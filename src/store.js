import { upgradeProfile } from './core.js';
import { upgradeDocument } from './memory-graph.js';

export const SQL = {
  profiles: 'CREATE TABLE IF NOT EXISTS ll_profiles (character_id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  docs: 'CREATE TABLE IF NOT EXISTS ll_documents (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL)',
  runs: 'CREATE TABLE IF NOT EXISTS ll_runs (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)',
  locks: 'CREATE TABLE IF NOT EXISTS ll_locks (character_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)',
  scenes: 'CREATE TABLE IF NOT EXISTS ll_scenes (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, scope_key TEXT NOT NULL, day TEXT NOT NULL, generated_at INTEGER NOT NULL, data TEXT NOT NULL)',
  scenesByScope: 'CREATE INDEX IF NOT EXISTS ll_scenes_scope ON ll_scenes (scope_key, generated_at)',
  scenesByCharacter: 'CREATE INDEX IF NOT EXISTS ll_scenes_character ON ll_scenes (character_id, generated_at)',
  getProfile: 'SELECT data FROM ll_profiles WHERE character_id = ?',
  listProfiles: 'SELECT data FROM ll_profiles',
  putProfile: 'INSERT INTO ll_profiles (character_id, data) VALUES (?, ?) ON CONFLICT(character_id) DO UPDATE SET data = excluded.data',
  getDoc: 'SELECT data FROM ll_documents WHERE id = ?',
  listDocs: 'SELECT data FROM ll_documents WHERE character_id = ? ORDER BY created_at DESC',
  putDoc: 'INSERT INTO ll_documents (id, character_id, day, kind, created_at, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
  addRun: 'INSERT OR REPLACE INTO ll_runs (id, character_id, at, data) VALUES (?, ?, ?, ?)',
  listRuns: 'SELECT data FROM ll_runs WHERE character_id = ? ORDER BY at DESC LIMIT 20',
  listAllRuns: 'SELECT data FROM ll_runs WHERE character_id = ? ORDER BY at DESC',
  getScene: 'SELECT data FROM ll_scenes WHERE scope_key = ? AND generated_at <= ? ORDER BY generated_at DESC, rowid DESC LIMIT 1',
  listScenes: 'SELECT data FROM ll_scenes WHERE character_id = ? AND generated_at <= ? ORDER BY generated_at DESC, rowid DESC LIMIT ?',
  putScene: 'INSERT INTO ll_scenes (id, character_id, scope_key, day, generated_at, data) VALUES (?, ?, ?, ?, ?, ?)',
  acquire: 'INSERT OR IGNORE INTO ll_locks (character_id, owner, expires_at) VALUES (?, ?, ?)',
  takeover: 'UPDATE ll_locks SET owner = ?, expires_at = ? WHERE character_id = ? AND expires_at < ?',
  getLock: 'SELECT owner FROM ll_locks WHERE character_id = ?',
  release: 'DELETE FROM ll_locks WHERE character_id = ? AND owner = ?'
};
export function createStore(client) {
  const query = async (sql, args = []) => { const r = await client.db.executeSql(sql, args); if (!r || !Array.isArray(r.rows)) throw new Error('当前 Layla 未返回有效的数据库结果'); return r; };
  const decode = r => r.rows.map(x => JSON.parse(x.data));
  return {
    query,
    async init() { for (const sql of [SQL.profiles, SQL.docs, SQL.runs, SQL.locks, SQL.scenes, SQL.scenesByScope, SQL.scenesByCharacter]) await query(sql); },
    async getProfile(id) { const p = decode(await query(SQL.getProfile, [id]))[0]; return p ? upgradeProfile(p) : null; },
    async profiles() { return decode(await query(SQL.listProfiles)).map(upgradeProfile); },
    async putProfile(p) { await query(SQL.putProfile, [p.characterId, JSON.stringify(p)]); },
    async getDoc(id) { const d = decode(await query(SQL.getDoc, [id]))[0]; return d ? upgradeDocument(d) : null; },
    async docs(id) { return decode(await query(SQL.listDocs, [id])).map(upgradeDocument); },
    async putDoc(d) { await query(SQL.putDoc, [d.id, d.characterId, d.day, d.kind, d.createdAt, JSON.stringify(d)]); },
    async addRun(r) { await query(SQL.addRun, [r.id, r.characterId, r.at, JSON.stringify(r)]); },
    async runs(id) { return decode(await query(SQL.listRuns, [id])); },
    async allRuns(id) { return decode(await query(SQL.listAllRuns, [id])); },
    async getScene(key, before = Date.now()) { return decode(await query(SQL.getScene, [key, before]))[0] || null; },
    async scenes(id, { before = Number.MAX_SAFE_INTEGER, limit = 200 } = {}) { return decode(await query(SQL.listScenes, [id, before, limit])); },
    async putScene(s) { await query(SQL.putScene, [s.id, s.characterId, s.key, s.day, s.generatedAt, JSON.stringify(s)]); },
    async lock(id, action) {
      const now = Date.now(), owner = `${now}-${Math.random()}`;
      await query(SQL.acquire, [id, owner, now + 30 * 60000]);
      await query(SQL.takeover, [owner, now + 30 * 60000, id, now]);
      const r = await query(SQL.getLock, [id]);
      if (r.rows[0]?.owner !== owner) throw new Error('这个角色正在处理另一项任务，请稍后再试');
      try { return await action(); } finally { await query(SQL.release, [id, owner]); }
    }
  };
}
