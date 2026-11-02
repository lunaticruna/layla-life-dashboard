// Conservative packaging guard, not a reimplementation of Layla's closed importer.
// The install folder may be derived from title. Keep it portable across ASCII sluggers.
export function validateInstallManifest(manifest) {
  const title = typeof manifest?.title === 'string' ? manifest.title.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(title)) {
    throw new Error('安装标题须使用 ASCII 字母、数字、空格、连字符或下划线；纯中文标题可能生成空安装路径。看板内部仍可使用中文。');
  }
  const portableName = title.toLowerCase().replace(/[ _]+/g, '-').replace(/-+/g, '-');
  if (!/[a-z0-9]/.test(portableName)) throw new Error('安装标题不能生成有效目录名');
  for (const key of ['iconUri', 'backgroundImgUri']) {
    const value = manifest[key];
    if (value && (typeof value !== 'string' || value.startsWith('/') || value.includes('..') || /^[a-z]+:/i.test(value))) throw new Error(`${key} 必须是小应用内部的相对路径`);
  }
  return { title, portableName };
}
