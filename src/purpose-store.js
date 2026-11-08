import { createPurposeRecord, normalizePurposeConfig } from './purpose-engine.js';

// A separate table and lock namespace let a future mini-app reuse the engine
// without adding fields to life profiles or reaching into Dream's database.
export const PURPOSE_SQL = {
  create: 'CREATE TABLE IF NOT EXISTS ll_purpose (character_id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  get: 'SELECT data FROM ll_purpose WHERE character_id = ?',
  list: 'SELECT data FROM ll_purpose',
  insert: 'INSERT OR IGNORE INTO ll_purpose (character_id, data) VALUES (?, ?)',
  cas: 'UPDATE ll_purpose SET data = ? WHERE character_id = ? AND data = ?'
};
export function createPurposeStore(store) {
  const init = () => store.query(PURPOSE_SQL.create);
  function decode(row) {
    if (!row) return null;
    const data = JSON.parse(row.data);
    if (data.version !== 1 || !Array.isArray(data.goals) || !Array.isArray(data.deliveries)) throw new Error('主动交互数据版本或结构不兼容');
    return { ...data, config: normalizePurposeConfig(data.config) };
  }
  return {
    init,
    async get(characterId) { await init(); return decode((await store.query(PURPOSE_SQL.get, [characterId])).rows[0]); },
    async list() { await init(); return (await store.query(PURPOSE_SQL.list)).rows.map(decode); },
    async lock(characterId, action, now = Date.now()) {
      await init();
      return store.lock(`purpose:${characterId}`, async () => {
        await store.query(PURPOSE_SQL.insert, [characterId, JSON.stringify(createPurposeRecord(characterId, now))]);
        const row = (await store.query(PURPOSE_SQL.get, [characterId])).rows[0];
        let previous = row.data;
        const record = decode(row);
        if (record.characterId !== characterId) throw new Error('主动交互角色归属异常');
        const save = async () => {
          const next = JSON.stringify(record);
          const res = await store.query(PURPOSE_SQL.cas, [next, characterId, previous]);
          if (res.rowsAffected !== 1) throw new Error('主动交互状态已被其他任务修改，请重新读取后核对');
          previous = next;
        };
        return action(record, save);
      });
    }
  };
}
