import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore, SQL } from '../src/store.js';
import {
  exportCharacterBackup,
  consolidateKnowledgeGraph,
  extractScheduleAndTimelineFacts,
  fetchAllNativeMemories
} from '../src/export.js';
import { createZip, crc32 } from '../src/zip.js';
import { VERSION, createProfile, epoch } from '../src/core.js';

/**
 * Pure JavaScript PKZIP archive parser for automated test verification.
 * Validates Local File Headers (0x04034b50), Central Directory Headers (0x02014b50),
 * End of Central Directory (0x06054b50), and CRC-32 checksums.
 *
 * @param {string | Uint8Array | Buffer} input Base64 string or byte array
 * @returns {{ eocd: object, entries: Array<object>, files: Record<string, object> }}
 */
function parseZipArchive(input) {
  const bytes = typeof input === 'string'
    ? Buffer.from(input, 'base64')
    : (input instanceof Uint8Array ? input : new Uint8Array(input));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 1. Locate End of Central Directory (EOCD)
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('PKZIP End of Central Directory signature (0x06054b50) not found');
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const startDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const entries = [];
  const files = {};
  const decoder = new TextDecoder('utf-8');

  let curr = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    const cdSig = view.getUint32(curr, true);
    if (cdSig !== 0x02014b50) {
      throw new Error(`Invalid Central Directory header signature 0x${cdSig.toString(16)} at offset ${curr}`);
    }

    const versionMadeBy = view.getUint16(curr + 4, true);
    const versionNeeded = view.getUint16(curr + 6, true);
    const flags = view.getUint16(curr + 8, true);
    const method = view.getUint16(curr + 10, true);
    const modTime = view.getUint16(curr + 12, true);
    const modDate = view.getUint16(curr + 14, true);
    const crc = view.getUint32(curr + 16, true);
    const compSize = view.getUint32(curr + 20, true);
    const uncompSize = view.getUint32(curr + 24, true);
    const nameLen = view.getUint16(curr + 28, true);
    const extraLen = view.getUint16(curr + 30, true);
    const commentLen = view.getUint16(curr + 32, true);
    const localHeaderOffset = view.getUint32(curr + 42, true);

    const nameBytes = bytes.subarray(curr + 46, curr + 46 + nameLen);
    const name = decoder.decode(nameBytes);

    // Verify Local File Header
    const localSig = view.getUint32(localHeaderOffset, true);
    if (localSig !== 0x04034b50) {
      throw new Error(`Invalid Local File Header signature 0x${localSig.toString(16)} for "${name}" at offset ${localHeaderOffset}`);
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);

    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const fileBytes = bytes.subarray(dataStart, dataStart + uncompSize);
    const text = decoder.decode(fileBytes);

    const entry = {
      name,
      method,
      crc,
      compSize,
      uncompSize,
      localHeaderOffset,
      bytes: fileBytes,
      text,
      json: () => JSON.parse(text)
    };

    entries.push(entry);
    files[name] = entry;

    curr += 46 + nameLen + extraLen + commentLen;
  }

  return {
    eocd: { diskNumber, startDisk, entriesOnDisk, totalEntries, cdSize, cdOffset, eocdOffset },
    entries,
    files
  };
}

/**
 * Creates an in-memory SQLite store and mock SDK client for testing export workflows.
 */
function setupTestEnvironment(characterOverride = null) {
  const db = new DatabaseSync(':memory:');
  const character = characterOverride || {
    id: 'char-test-full',
    data: {
      data: {
        name: '测试角色·澪',
        description: '热爱文学与红茶的少女。'
      }
    }
  };

  const nativeMemories = [];

  const client = {
    db: {
      executeSql: async (q, args = []) => {
        const stmt = db.prepare(q);
        if (/^SELECT/i.test(q.trim())) {
          return { rows: stmt.all(...args), rowsAffected: 0, insertId: 0 };
        }
        const r = stmt.run(...args);
        return { rows: [], rowsAffected: Number(r.changes), insertId: Number(r.lastInsertRowid) };
      }
    },
    memories: {
      list: async (characterId, offset = 0, limit = 50) => {
        const matching = nativeMemories.filter(m => m.character_id === characterId);
        return matching.slice(offset, offset + limit);
      }
    }
  };

  const store = createStore(client);

  return {
    db,
    client,
    store,
    character,
    nativeMemories
  };
}

test('export: full data completeness (>25 runs, docs, scenes, graph, paginated native memories)', async t => {
  const f = setupTestEnvironment();
  t.after(() => f.db.close());
  await f.store.init();

  const characterId = f.character.id;
  const fixedNow = epoch('2026-11-01', 22 * 60);

  // 1. Profile setup
  const profile = createProfile(f.character, fixedNow);
  profile.settings.timezone = 'Asia/Shanghai';
  profile.settings.home = '天台小屋';
  profile.settings.sleepStart = '23:30';
  profile.settings.sleepEnd = '08:00';
  profile.state.energy = 85;
  profile.state.hunger = 20;
  profile.state.mood = 0.8;
  await f.store.putProfile(profile);

  // 2. Seed > 25 runs (30 runs total) to verify bypass of legacy 20-run limit
  for (let i = 0; i < 30; i++) {
    await f.store.addRun({
      id: `run-${String(i).padStart(3, '0')}`,
      characterId,
      at: fixedNow - (30 - i) * 60000,
      kind: i % 2 === 0 ? 'scene' : 'diary',
      status: 'ok',
      message: `历史任务流水 #${i}`
    });
  }

  // 3. Seed multiple documents (diary, dream, reflection, work)
  const docsToSeed = [
    {
      id: `life-${characterId}-diary-2026-11-01`,
      characterId,
      sessionId: 'session-1',
      kind: 'diary',
      day: '2026-11-01',
      title: '初冬的散步与红茶',
      body: '今天早晨 08:15 起床，推开窗户有初冬的冷风。泡了大吉岭红茶，在桌边写下了新想法。',
      summary: '澪在 08:15 起床，泡了一杯大吉岭红茶。',
      createdAt: fixedNow - 3600000,
      syncStatus: 'written',
      memoryId: 101,
      graphStatus: 'ready',
      timelineFacts: {
        day: '2026-11-01',
        wakeTime: '08:15',
        wakePhrase: '08:15起床',
        wakeSource: 'diary',
        wakeSummary: '08:15（日记记录“08:15起床”）'
      },
      graphVerifiedJSON: JSON.stringify([
        { subject: '日记（2026-11-01）《初冬的散步与红茶》', relationship: '记录中作息', object: '08:15起床' },
        { subject: '日记（2026-11-01）《初冬的散步与红茶》', relationship: '记录中物件', object: '大吉岭红茶' }
      ])
    },
    {
      id: `life-${characterId}-dream-2026-11-01`,
      characterId,
      sessionId: 'session-1',
      kind: 'dream',
      day: '2026-11-01',
      title: '悬浮的玻璃图书馆',
      body: '整个图书馆浮在云海上方，书页在空中轻轻翻飞。她在三层拾起了一本旧诗集。',
      summary: '澪梦见自己在无重力的玻璃图书馆中寻找旧诗集。',
      createdAt: fixedNow - 7200000,
      syncStatus: 'written',
      memoryId: 102,
      graphStatus: 'draft',
      graphDraftJSON: JSON.stringify([
        { subject: '梦境（2026-11-01）《悬浮的玻璃图书馆》', relationship: '梦中地点', object: '玻璃图书馆' },
        { subject: '梦境（2026-11-01）《悬浮的玻璃图书馆》', relationship: '梦中物件', object: '旧诗集' }
      ])
    },
    {
      id: `life-${characterId}-reflection-2026-11-01`,
      characterId,
      sessionId: 'session-1',
      kind: 'reflection',
      day: '2026-11-01',
      title: '关于时间与记忆的思索',
      body: '长久的陪伴需要连续的记忆与真实的生理节律。',
      summary: '反思近日关于时空与长久记忆的记录。',
      createdAt: fixedNow - 10800000,
      syncStatus: 'pending',
      graphStatus: 'pending'
    },
    {
      id: `life-${characterId}-work-2026-11-01`,
      characterId,
      sessionId: 'session-1',
      kind: 'work',
      day: '2026-11-01',
      title: '冬日小夜曲第一乐章',
      body: '降B大调，悠缓的三拍子，如雪花落在琴键上。',
      summary: '为冬夜谱写的小夜曲草稿。',
      createdAt: fixedNow - 14400000,
      syncStatus: 'pending',
      graphStatus: 'pending'
    }
  ];

  for (const doc of docsToSeed) {
    await f.store.putDoc(doc);
  }

  // 4. Seed micro-scene records in SQLite
  const scenesToSeed = [
    {
      id: 'scene-001',
      characterId,
      key: 'key-001',
      day: '2026-11-01',
      generatedAt: fixedNow - 18000000,
      start: fixedNow - 18000000,
      end: fixedNow - 14400000,
      phase: 'awake',
      summary: '在书房晨读',
      location: '书房',
      scene: '晨光穿过薄纱窗帘洒在书桌上，澪端起热茶轻抿一口，翻开了未读完的散文集。'
    },
    {
      id: 'scene-002',
      characterId,
      key: 'key-002',
      day: '2026-11-01',
      generatedAt: fixedNow - 14400000,
      start: fixedNow - 14400000,
      end: fixedNow - 10800000,
      phase: 'awake',
      summary: '在天台整理花草',
      location: '天台',
      scene: '初冬的微风有些料峭，她戴着手套小心修剪着盆栽中的枯枝，目光落在远处的城市轮廓。'
    },
    {
      id: 'scene-003',
      characterId,
      key: 'key-003',
      day: '2026-11-01',
      generatedAt: fixedNow - 10800000,
      start: fixedNow - 10800000,
      end: fixedNow - 7200000,
      phase: 'awake',
      summary: '午间准备简餐',
      location: '厨房',
      scene: '锅里冒出温热的水汽，蔬菜与味噌的香气渐渐弥漫开来，她专注于眼前的每一个细小步骤。'
    },
    {
      id: 'scene-004',
      characterId,
      key: 'key-004',
      day: '2026-11-01',
      generatedAt: fixedNow - 7200000,
      start: fixedNow - 7200000,
      end: fixedNow - 3600000,
      phase: 'light_sleep',
      summary: '沙发上的短暂小憩',
      location: '客厅沙发',
      scene: '毛毯搭在膝头，窗外的鸟鸣时远时近，她在半睡半醒的宁静中慢慢恢复着精力。'
    },
    {
      id: 'scene-005',
      characterId,
      key: 'key-005',
      day: '2026-11-01',
      generatedAt: fixedNow - 3600000,
      start: fixedNow - 3600000,
      end: fixedNow,
      phase: 'awake',
      summary: '傍晚记录手记',
      location: '书房',
      scene: '台灯散发着暖黄色的柔光，笔尖划过纸张发出沙沙声，将这一天的所思所感静静沉淀。'
    }
  ];

  for (const scene of scenesToSeed) {
    await f.store.putScene(scene);
  }

  // 5. Seed 65 native memories in mock SDK (requires 2 pages: 50 + 15)
  for (let i = 0; i < 65; i++) {
    f.nativeMemories.push({
      id: 200 + i,
      character_id: characterId,
      session_id: 'life-archive-mio',
      timestamp: fixedNow - (65 - i) * 60000,
      rawText: `【Layla生活记录:mem-${i}】澪的原生记忆详情 #${i}`,
      summary: `原生记忆摘要 #${i}`,
      // One native memory contains knowledgeGraphJSON with a new triple and a duplicate triple
      knowledgeGraphJSON: i === 0 ? JSON.stringify([
        { subject: '宿主交互记忆', relationship: '记录中人物', object: '旅行者' },
        { subject: '日记（2026-11-01）《初冬的散步与红茶》', relationship: '记录中作息', object: '08:15起床' }
      ]) : null
    });
  }

  // Execute character backup export
  const state = { character: f.character };
  const result = await exportCharacterBackup(state, f.store, f.client, { now: fixedNow });

  // Verify export execution result
  assert.equal(result.isZip, true, 'Default export mode must be ZIP archive');
  assert.equal(result.filename, `life-backup-${characterId}-${fixedNow}.zip`);

  // Parse and inspect ZIP contents
  const parsed = parseZipArchive(result.base64);

  // 1. Verify 100% of runs exported (verifying bypass of legacy 20-run limit)
  assert.ok(parsed.files['runs/history_runs.json'], 'runs/history_runs.json must be present');
  const exportedRuns = parsed.files['runs/history_runs.json'].json();
  assert.equal(exportedRuns.length, 30, 'All 30 historical runs must be exported without legacy LIMIT 20 truncation');
  assert.equal(exportedRuns[0].id, 'run-029', 'Runs must be ordered descending by execution timestamp');
  assert.equal(exportedRuns[29].id, 'run-000');

  // 2. Verify documents: summaries, raw texts (body), kinds
  assert.ok(parsed.files['documents/documents.json'], 'documents/documents.json must be present');
  const exportedDocs = parsed.files['documents/documents.json'].json();
  assert.equal(exportedDocs.length, 4, 'All 4 documents must be exported');
  for (const doc of exportedDocs) {
    assert.ok(doc.summary, `Document ${doc.id} must have summary`);
    assert.ok(doc.body, `Document ${doc.id} must have raw body text`);
    assert.ok(['diary', 'dream', 'reflection', 'work'].includes(doc.kind), `Document ${doc.id} kind must be valid`);
  }

  // 3. Verify timeline facts extracted into schedules/daily_facts.json
  assert.ok(parsed.files['schedules/daily_facts.json'], 'schedules/daily_facts.json must be present');
  const exportedSchedules = parsed.files['schedules/daily_facts.json'].json();
  const dailyFact = Array.isArray(exportedSchedules) ? exportedSchedules.find(f => f.day === '2026-11-01') : exportedSchedules.dailyFacts['2026-11-01'];
  assert.equal(dailyFact?.wakeTime, '08:15');
  assert.equal(dailyFact?.wakePhrase, '08:15起床');
  assert.equal(dailyFact?.wakeSource, 'diary');

  // 4. Verify scene records
  assert.ok(parsed.files['scenes/scenes.json'], 'scenes/scenes.json must be present');
  const exportedScenes = parsed.files['scenes/scenes.json'].json();
  assert.equal(exportedScenes.length, 5, 'All 5 scenes must be exported');
  for (const s of exportedScenes) {
    assert.ok(s.id, 'Scene must have id');
    assert.ok(s.location, 'Scene must have location');
    assert.ok(s.phase, 'Scene must have phase');
    assert.ok(s.scene && s.scene.length > 20, 'Scene must have detailed prose');
  }

  // 5. Verify consolidated knowledge graph triples
  assert.ok(parsed.files['knowledge-graph/graph.json'], 'knowledge-graph/graph.json must be present');
  const graphData = parsed.files['knowledge-graph/graph.json'].json();
  const exportedTriples = Array.isArray(graphData) ? graphData : graphData.triples;
  // 2 from diary verified + 2 from dream draft + 1 unique from native memory = 5 triples total (duplicate deduplicated)
  assert.equal(exportedTriples.length, 5, 'Consolidated triples must deduplicate and combine all sources');
  for (const t of exportedTriples) {
    assert.ok(t.subject && typeof t.subject === 'string');
    assert.ok(t.relationship && typeof t.relationship === 'string');
    assert.ok(t.object && typeof t.object === 'string');
  }
  const hasHostMemory = exportedTriples.some(t => t.subject === '宿主交互记忆' && t.object === '旅行者');
  assert.equal(hasHostMemory, true, 'Triples from native memories must be consolidated');

  // 6. Verify native memories retrieved via SDK pagination
  assert.ok(parsed.files['native-memories/native_memories.json'], 'native-memories/native_memories.json must be present');
  const exportedNativeMems = parsed.files['native-memories/native_memories.json'].json();
  assert.equal(exportedNativeMems.length, 65, 'All 65 native memories must be retrieved across SDK pagination pages');
  assert.equal(exportedNativeMems[0].id, 200);
  assert.equal(exportedNativeMems[64].id, 264);
});

test('export: manifest metadata conforms to specification and exact counts', async t => {
  const f = setupTestEnvironment();
  t.after(() => f.db.close());
  await f.store.init();

  const characterId = f.character.id;
  const fixedNow = epoch('2026-11-01', 22 * 60);

  // Seed 4 documents
  for (const kind of ['diary', 'dream', 'reflection', 'work']) {
    await f.store.putDoc({
      id: `doc-${kind}`,
      characterId,
      kind,
      day: '2026-11-01',
      title: `${kind}标题`,
      body: '正文内容',
      summary: '摘要内容',
      createdAt: fixedNow
    });
  }

  // Seed 3 scenes
  for (let i = 0; i < 3; i++) {
    await f.store.putScene({
      id: `scene-${i}`,
      characterId,
      key: `key-${i}`,
      day: '2026-11-01',
      generatedAt: fixedNow - i * 1000,
      start: fixedNow - (i + 1) * 1000,
      end: fixedNow - i * 1000,
      phase: 'awake',
      summary: `片段 #${i}`,
      location: '书房',
      scene: '一段微观场景描述文字。'
    });
  }

  // Seed 25 runs
  for (let i = 0; i < 25; i++) {
    await f.store.addRun({
      id: `run-${i}`,
      characterId,
      at: fixedNow - i * 1000,
      kind: 'refresh',
      status: 'ok',
      message: '刷新记录'
    });
  }

  // Seed 10 native memories
  for (let i = 0; i < 10; i++) {
    f.nativeMemories.push({
      id: 500 + i,
      character_id: characterId,
      timestamp: fixedNow,
      rawText: '原生记录',
      summary: '摘要'
    });
  }

  const result = await exportCharacterBackup({ character: f.character }, f.store, f.client, { now: fixedNow });
  const parsed = parseZipArchive(result.base64);

  assert.ok(parsed.files['manifest.json'], 'manifest.json must be present');
  const manifest = parsed.files['manifest.json'].json();

  // Validate Manifest Fields
  assert.equal(manifest.version, VERSION, 'Manifest version must match core.js VERSION');
  assert.equal(manifest.appVersion, '0.2.3', 'appVersion must be 0.2.3');
  assert.equal(manifest.specVersion, '1.1.0', 'specVersion must be 1.1.0');
  assert.equal(manifest.exportVersion, '1.1.0', 'exportVersion must be 1.1.0');
  assert.equal(manifest.exportedAt, fixedNow, 'exportedAt must match execution timestamp');
  assert.equal(manifest.exportedAtISO, new Date(fixedNow).toISOString(), 'exportedAtISO must be valid ISO string');
  assert.equal(manifest.characterId, characterId, 'characterId must match export character');
  assert.equal(manifest.characterName, '测试角色·澪', 'characterName must match character profile name');

  // Validate exact recordCounts
  assert.deepEqual(manifest.recordCounts, {
    documents: 4,
    scenes: 3,
    runs: 25,
    triples: 0,
    nativeMemories: 10,
    plans: 0
  });

  // Validate summary counts
  assert.equal(manifest.summary.documentCount, 4);
  assert.equal(manifest.summary.sceneCount, 3);
  assert.equal(manifest.summary.runCount, 25);
  assert.equal(manifest.summary.tripleCount, 0);
  assert.equal(manifest.summary.nativeMemoryCount, 10);
  assert.equal(manifest.summary.planCount, 0);

  // Validate files array
  assert.equal(Array.isArray(manifest.files), true);
  assert.equal(manifest.files.length, 9, 'Must list all 9 canonical sub-files');
  const expectedFilePaths = [
    'manifest.json',
    'profile.json',
    'schedules/daily_facts.json',
    'schedules/plans.json',
    'documents/documents.json',
    'scenes/scenes.json',
    'runs/history_runs.json',
    'knowledge-graph/graph.json',
    'native-memories/native_memories.json'
  ];
  const manifestPaths = manifest.files.map(f => f.path);
  assert.deepEqual(manifestPaths, expectedFilePaths, 'Manifest files list must match canonical layout');

  // Verify that every single file declared in manifest exists in the archive
  for (const filePath of expectedFilePaths) {
    assert.ok(parsed.files[filePath], `File ${filePath} declared in manifest must exist in archive`);
  }
});

test('export: ZIP archive validity, standard PKZIP signatures and CRC-32 integrity', async t => {
  const f = setupTestEnvironment();
  t.after(() => f.db.close());
  await f.store.init();

  const characterId = f.character.id;
  const fixedNow = epoch('2026-11-01', 20 * 60);

  // Seed sample data
  await f.store.putDoc({
    id: 'doc-zip-test',
    characterId,
    kind: 'diary',
    day: '2026-11-01',
    title: '压缩校验日记',
    body: '测试 PKZIP 格式与 CRC32 校验码。',
    summary: '压缩测试',
    createdAt: fixedNow
  });

  const result = await exportCharacterBackup({ character: f.character }, f.store, f.client, { now: fixedNow });
  assert.equal(result.isZip, true);

  const rawBytes = Buffer.from(result.base64, 'base64');
  assert.ok(rawBytes.length > 100, 'Zip file must have non-trivial size');

  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);

  // Verify first 4 bytes are Local File Header magic (0x04034b50)
  assert.equal(view.getUint32(0, true), 0x04034b50, 'ZIP file must start with Local File Header signature');

  // Parse archive and verify all entries
  const parsed = parseZipArchive(rawBytes);

  // Verify EOCD signature (0x06054b50)
  assert.equal(view.getUint32(parsed.eocd.eocdOffset, true), 0x06054b50, 'EOCD signature must match');
  assert.equal(parsed.entries.length, 9, 'Archive must contain exactly 9 canonical entries');
  assert.equal(parsed.eocd.totalEntries, 9);

  // Check each entry: Method 0 (STORE), CRC-32 match, Central Directory signature, valid JSON
  for (const entry of parsed.entries) {
    assert.equal(entry.method, 0, `Entry ${entry.name} must use Method 0 (STORE)`);

    // Calculate CRC-32 of extracted bytes and verify equality
    const expectedCrc = crc32(entry.bytes);
    assert.equal(entry.crc, expectedCrc, `Entry ${entry.name} CRC-32 must match computed checksum`);

    // Verify Central Directory header signature
    const cdSig = view.getUint32(parsed.eocd.cdOffset, true);
    assert.equal(cdSig, 0x02014b50, 'Central Directory header signature must match 0x02014b50');

    // Verify JSON parseability
    assert.doesNotThrow(() => {
      const data = JSON.parse(entry.text);
      assert.ok(data !== null && typeof data === 'object');
    }, `Sub-file ${entry.name} must be valid parseable JSON`);
  }
});

test('export: graceful fallback to single structured JSON on explicit forceJson and packaging error', async t => {
  const f = setupTestEnvironment();
  t.after(() => f.db.close());
  await f.store.init();

  const characterId = f.character.id;
  const fixedNow = epoch('2026-11-01', 18 * 60);

  // Seed sample data
  await f.store.putDoc({
    id: 'doc-fallback-1',
    characterId,
    kind: 'diary',
    day: '2026-11-01',
    title: '降级测试日记',
    body: '验证当 ZIP 打包不可用时的优雅降级行为。',
    summary: '降级测试',
    createdAt: fixedNow
  });

  await f.store.addRun({
    id: 'run-fallback-1',
    characterId,
    at: fixedNow,
    kind: 'scene',
    status: 'ok',
    message: '降级运行记录'
  });

  // Subtest A: Explicit forceJson option
  const fallbackResult = await exportCharacterBackup(
    { character: f.character },
    f.store,
    f.client,
    { now: fixedNow, forceJson: true }
  );

  assert.equal(fallbackResult.isZip, false, 'forceJson must yield isZip === false');
  assert.equal(fallbackResult.filename, `life-backup-${characterId}-${fixedNow}.json`);

  const jsonStr = Buffer.from(fallbackResult.base64, 'base64').toString('utf-8');
  const fallbackData = JSON.parse(jsonStr);

  // Verify all required root keys in fallback JSON
  const expectedRootKeys = [
    'version',
    'exportedAt',
    'characterId',
    'characterName',
    'manifest',
    'profile',
    'schedules',
    'plans',
    'documents',
    'scenes',
    'runs',
    'knowledgeGraph',
    'nativeMemories'
  ];
  for (const key of expectedRootKeys) {
    assert.ok(key in fallbackData, `Fallback JSON must contain root key "${key}"`);
  }
  assert.equal(fallbackData.version, VERSION);
  assert.equal(fallbackData.characterId, characterId);
  assert.equal(fallbackData.documents.length, 1);
  assert.equal(fallbackData.runs.length, 1);

  // Subtest B: Simulated ZIP packaging exception
  const originalGetHours = Date.prototype.getHours;
  Date.prototype.getHours = function() {
    throw new Error('Simulated clock/binary packager crash');
  };

  try {
    const errorFallbackResult = await exportCharacterBackup(
      { character: f.character },
      f.store,
      f.client,
      { now: fixedNow }
    );

    assert.equal(errorFallbackResult.isZip, false, 'ZIP exception must trigger graceful JSON fallback');
    assert.equal(errorFallbackResult.filename, `life-backup-${characterId}-${fixedNow}.json`);

    const errorJsonStr = Buffer.from(errorFallbackResult.base64, 'base64').toString('utf-8');
    const errorData = JSON.parse(errorJsonStr);

    for (const key of expectedRootKeys) {
      assert.ok(key in errorData, `Error fallback JSON must contain root key "${key}"`);
    }
    assert.equal(errorData.characterId, characterId);
    assert.equal(errorData.documents.length, 1);
  } finally {
    Date.prototype.getHours = originalGetHours;
  }
});

test('export: storage layer listAllRuns bypasses 20-run limit while listRuns enforces it', async t => {
  const f = setupTestEnvironment();
  t.after(() => f.db.close());
  await f.store.init();

  const characterId = f.character.id;
  const now = Date.now();

  // Seed 35 runs
  for (let i = 0; i < 35; i++) {
    await f.store.addRun({
      id: `run-${i}`,
      characterId,
      at: now + i * 1000,
      kind: 'scene',
      status: 'ok',
      message: `运行 #${i}`
    });
  }

  // Verify legacy store.runs is bounded at 20
  const legacyRuns = await f.store.runs(characterId);
  assert.equal(legacyRuns.length, 20, 'store.runs must retain legacy LIMIT 20 for backward compatibility');

  // Verify store.allRuns retrieves all 35 records
  const allRuns = await f.store.allRuns(characterId);
  assert.equal(allRuns.length, 35, 'store.allRuns must retrieve 100% of runs without omission');

  // Verify order is strictly descending by at
  for (let i = 0; i < allRuns.length - 1; i++) {
    assert.ok(allRuns[i].at >= allRuns[i + 1].at, 'Runs must be ordered descending by execution timestamp');
  }
  assert.equal(allRuns[0].id, 'run-34', 'Most recent run must be first');
});

test('export: minimal boundary condition with zero records', async t => {
  const f = setupTestEnvironment();
  t.after(() => f.db.close());
  await f.store.init();

  const fixedNow = epoch('2026-11-01', 12 * 60);
  const result = await exportCharacterBackup({ character: f.character }, f.store, f.client, { now: fixedNow });

  assert.equal(result.isZip, true);
  assert.deepEqual(result.stats, {
    documents: 0,
    scenes: 0,
    runs: 0,
    triples: 0,
    nativeMemories: 0,
    plans: 0
  });

  const parsed = parseZipArchive(result.base64);
  assert.equal(parsed.entries.length, 9);

  const manifest = parsed.files['manifest.json'].json();
  assert.equal(manifest.recordCounts.documents, 0);
  assert.equal(manifest.recordCounts.scenes, 0);
  assert.equal(manifest.recordCounts.runs, 0);
  assert.equal(manifest.recordCounts.triples, 0);
  assert.equal(manifest.recordCounts.nativeMemories, 0);
  assert.equal(manifest.recordCounts.plans, 0);

  assert.deepEqual(parsed.files['schedules/plans.json'].json(), []);
  assert.deepEqual(parsed.files['documents/documents.json'].json(), []);
  assert.deepEqual(parsed.files['scenes/scenes.json'].json(), []);
  assert.deepEqual(parsed.files['runs/history_runs.json'].json(), []);
  const emptyGraph = parsed.files['knowledge-graph/graph.json'].json();
  assert.deepEqual(Array.isArray(emptyGraph) ? emptyGraph : emptyGraph.triples, []);
  assert.deepEqual(parsed.files['native-memories/native_memories.json'].json(), []);
});

test('export: adversarial encoding integrity (Unicode, CJK, emojis, quotes and HTML tags)', async t => {
  const complexCharacter = {
    id: 'char-unicode-test',
    data: {
      data: {
        name: '🌸 澪・星咏み / "Mio" & <Sparkle>',
        description: '「星の海を旅する」—— 含有双引号、换行与特殊字符。'
      }
    }
  };

  const f = setupTestEnvironment(complexCharacter);
  t.after(() => f.db.close());
  await f.store.init();

  const fixedNow = epoch('2026-11-01', 15 * 60);

  const specialBody = `
# 标题：初冬的星空与茶香 🍵✨
在 "2026-11-01 08:30" 起床。
这是一段包含特殊字符的正文：
- 换行符与制表符：\t\t[Tab]
- 引号与反斜杠：\\"Hello, \\World/\\"
- 标签与实体：<memory kind="important" flag="true">&amp;</memory>
- 多语言字符：日本語テスト（ひらがな・カタカナ・漢字）、العربية、Русский
- Emoji：🌙 ⭐ 📖 🍃 ☕
`;

  await f.store.putDoc({
    id: 'doc-complex-1',
    characterId: complexCharacter.id,
    kind: 'diary',
    day: '2026-11-01',
    title: '🍵 抹茶与夜空 ✨',
    body: specialBody,
    summary: '包含各种特殊符号与引用的摘要',
    createdAt: fixedNow,
    graphVerifiedJSON: JSON.stringify([
      {
        subject: '角色/澪',
        relationship: '喜欢::饮品',
        object: '大吉岭红茶 & "抹茶拿铁"'
      }
    ])
  });

  const result = await exportCharacterBackup({ character: complexCharacter }, f.store, f.client, { now: fixedNow });
  const parsed = parseZipArchive(result.base64);

  const manifest = parsed.files['manifest.json'].json();
  assert.equal(manifest.characterName, '🌸 澪・星咏み / "Mio" & <Sparkle>');

  const docs = parsed.files['documents/documents.json'].json();
  assert.equal(docs.length, 1);
  assert.equal(docs[0].body, specialBody, 'Body text with emojis and special characters must survive lossless roundtrip');

  const graphPayload = parsed.files['knowledge-graph/graph.json'].json();
  const triples = Array.isArray(graphPayload) ? graphPayload : graphPayload.triples;
  assert.equal(triples.length, 1);
  assert.equal(triples[0].subject, '角色/澪');
  assert.equal(triples[0].relationship, '喜欢::饮品');
  assert.equal(triples[0].object, '大吉岭红茶 & "抹茶拿铁"');
});

test('export: SDK native memory pagination boundaries and error resilience', async t => {
  const f = setupTestEnvironment();
  t.after(() => f.db.close());
  await f.store.init();

  const characterId = f.character.id;

  // Boundary 1: Exactly 100 memories (2 full pages of 50, then empty)
  for (let i = 0; i < 100; i++) {
    f.nativeMemories.push({
      id: 1000 + i,
      character_id: characterId,
      timestamp: Date.now() - i * 1000,
      rawText: `原生记忆边界测试 #${i}`,
      summary: `摘要 #${i}`
    });
  }

  const fetched = await fetchAllNativeMemories(f.client, characterId);
  assert.equal(fetched.length, 100, 'Exactly 100 memories must be retrieved across 2 pages without infinite loop');

  // Boundary 2: SDK failure / offline resilience
  const brokenClient = {
    memories: {
      list: async () => {
        throw new Error('SDK network offline / session timeout');
      }
    }
  };

  const offlineMemories = await fetchAllNativeMemories(brokenClient, characterId);
  assert.deepEqual(offlineMemories, [], 'SDK failure must be caught and gracefully return empty array');

  // Verify full export proceeds without throwing when SDK memories fail
  const exportWithBrokenSDK = await exportCharacterBackup(
    { character: f.character },
    f.store,
    brokenClient
  );
  assert.equal(exportWithBrokenSDK.isZip, true);
  assert.equal(exportWithBrokenSDK.stats.nativeMemories, 0);
});

test('export: schedule extraction extracts timelineFacts and falls back to body wake mention', () => {
  const profile = {
    settings: {
      timezone: 'Asia/Tokyo',
      sleepStart: '00:00',
      sleepEnd: '07:30',
      home: '林间小筑'
    },
    plans: {
      '2026-11-01': { source: 'manual', nodes: [] }
    }
  };

  const docs = [
    // Doc 1: explicit timelineFacts
    {
      day: '2026-11-01',
      kind: 'diary',
      timelineFacts: {
        day: '2026-11-01',
        wakeTime: '07:45',
        wakePhrase: '07:45起身',
        wakeSource: 'diary',
        wakeSummary: '07:45（日记记录“07:45起身”）'
      }
    },
    // Doc 2: wake mention inside body (no explicit timelineFacts)
    {
      day: '2026-11-02',
      kind: 'diary',
      summary: '今天在清晨苏醒。',
      body: '角色在 08:30 起床，窗外下了小雨。'
    }
  ];

  const extracted = extractScheduleAndTimelineFacts(profile, docs);

  assert.equal(extracted.timezone, 'Asia/Tokyo');
  assert.equal(extracted.sleepSettings.home, '林间小筑');
  assert.equal(extracted.dailyFacts['2026-11-01'].wakeTime, '07:45');
  assert.equal(extracted.dailyFacts['2026-11-01'].wakePhrase, '07:45起身');
  assert.equal(extracted.dailyFacts['2026-11-02'].wakeTime, '08:30');
  assert.equal(extracted.dailyFacts['2026-11-02'].wakePhrase, '08:30 起床');
});
