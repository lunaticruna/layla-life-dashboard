// Pure JavaScript PKZIP archive builder (zero external dependencies).
// Follows standard PKZIP specification: Method 0 (STORE), Little-Endian, CRC-32.

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const day = (((Math.max(1980, date.getFullYear()) - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/**
 * Creates a valid PKZIP binary archive from an array of files.
 * @param {Array<{ name: string, data: Uint8Array | string }>} files
 * @returns {Uint8Array}
 */
export function createZip(files = []) {
  const encoder = new TextEncoder();
  const { time: dosTime, day: dosDay } = dosDateTime();

  let localOffset = 0;
  const prepared = [];

  for (const file of files) {
    if (!file || typeof file.name !== 'string') continue;
    const cleanName = file.name.replace(/\\/g, '/').replace(/^\/+/, '');
    const nameBytes = encoder.encode(cleanName);
    const dataBytes = typeof file.data === 'string'
      ? encoder.encode(file.data)
      : (file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data || 0));
    const crc = crc32(dataBytes);

    prepared.push({
      name: cleanName,
      nameBytes,
      dataBytes,
      crc,
      localOffset
    });

    localOffset += 30 + nameBytes.length + dataBytes.length;
  }

  const centralDirOffset = localOffset;
  let centralDirSize = 0;
  for (const item of prepared) {
    centralDirSize += 46 + item.nameBytes.length;
  }

  const totalSize = centralDirOffset + centralDirSize + 22;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  let offset = 0;

  // 1. Local File Headers and Data
  for (const item of prepared) {
    view.setUint32(offset, 0x04034b50, true);       // Local file header signature
    view.setUint16(offset + 4, 20, true);          // Version needed to extract (2.0)
    view.setUint16(offset + 6, 0x0800, true);       // General purpose bit flag (UTF-8 filename)
    view.setUint16(offset + 8, 0, true);           // Compression method (0 = STORE)
    view.setUint16(offset + 10, dosTime, true);     // File last mod time
    view.setUint16(offset + 12, dosDay, true);      // File last mod date
    view.setUint32(offset + 14, item.crc, true);    // CRC-32
    view.setUint32(offset + 18, item.dataBytes.length, true); // Compressed size
    view.setUint32(offset + 22, item.dataBytes.length, true); // Uncompressed size
    view.setUint16(offset + 26, item.nameBytes.length, true); // File name length
    view.setUint16(offset + 28, 0, true);          // Extra field length
    offset += 30;

    out.set(item.nameBytes, offset);
    offset += item.nameBytes.length;

    out.set(item.dataBytes, offset);
    offset += item.dataBytes.length;
  }

  // 2. Central Directory
  for (const item of prepared) {
    view.setUint32(offset, 0x02014b50, true);       // Central directory header signature
    view.setUint16(offset + 4, 20, true);          // Version made by (2.0)
    view.setUint16(offset + 6, 20, true);          // Version needed to extract (2.0)
    view.setUint16(offset + 8, 0x0800, true);       // General purpose bit flag (UTF-8 filename)
    view.setUint16(offset + 10, 0, true);          // Compression method (0 = STORE)
    view.setUint16(offset + 12, dosTime, true);     // File last mod time
    view.setUint16(offset + 14, dosDay, true);      // File last mod date
    view.setUint32(offset + 16, item.crc, true);    // CRC-32
    view.setUint32(offset + 20, item.dataBytes.length, true); // Compressed size
    view.setUint32(offset + 24, item.dataBytes.length, true); // Uncompressed size
    view.setUint16(offset + 28, item.nameBytes.length, true); // File name length
    view.setUint16(offset + 30, 0, true);          // Extra field length
    view.setUint16(offset + 32, 0, true);          // File comment length
    view.setUint16(offset + 34, 0, true);          // Disk number start
    view.setUint16(offset + 36, 0, true);          // Internal file attributes
    view.setUint32(offset + 38, 0, true);          // External file attributes
    view.setUint32(offset + 42, item.localOffset, true); // Relative offset of local header
    offset += 46;

    out.set(item.nameBytes, offset);
    offset += item.nameBytes.length;
  }

  // 3. End of Central Directory Record (EOCD)
  view.setUint32(offset, 0x06054b50, true);         // EOCD signature
  view.setUint16(offset + 4, 0, true);            // Number of this disk
  view.setUint16(offset + 6, 0, true);            // Disk where central directory starts
  view.setUint16(offset + 8, prepared.length, true);  // Number of central directory records on this disk
  view.setUint16(offset + 10, prepared.length, true); // Total number of central directory records
  view.setUint32(offset + 12, centralDirSize, true);  // Size of central directory
  view.setUint32(offset + 16, centralDirOffset, true); // Offset of central directory
  view.setUint16(offset + 20, 0, true);           // ZIP comment length

  return out;
}

/**
 * Encodes a Uint8Array to Base64 in safe 8KB chunks.
 * Avoids call stack overflow and excessive memory pressure on WebView/mobile.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function uint8ArrayToBase64(bytes) {
  const CHUNK_SIZE = 8192; // 8KB chunks
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    for (let j = 0; j < chunk.length; j++) {
      binary += String.fromCharCode(chunk[j]);
    }
  }
  return btoa(binary);
}

/**
 * Encodes a string to Base64 via UTF-8 bytes in safe 8KB chunks.
 * @param {string} str
 * @returns {string}
 */
export function stringToBase64(str) {
  return uint8ArrayToBase64(new TextEncoder().encode(str));
}
