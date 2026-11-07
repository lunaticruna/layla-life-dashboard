import { upgradeProfile, templatePlan } from './core.js';
import { upgradeDocument } from './memory-graph.js';
import { applyChange } from './schedule.js';

const planColumns = 'id, character_id, day, title, mood, day_type, nodes, changes, data, generated_at';
const planBindings = '?, ?, ?, ?, ?, ?, ?, ?, ?, ?';

export const SQL = {
  profiles: 'CREATE TABLE IF NOT EXISTS ll_profiles (character_id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  docs: 'CREATE TABLE IF NOT EXISTS ll_documents (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL)',
  runs: 'CREATE TABLE IF NOT EXISTS ll_runs (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)',
  locks: 'CREATE TABLE IF NOT EXISTS ll_locks (character_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)',
  scenes: 'CREATE TABLE IF NOT EXISTS ll_scenes (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, scope_key TEXT NOT NULL, day TEXT NOT NULL, generated_at INTEGER NOT NULL, data TEXT NOT NULL)',
  scenesByScope: 'CREATE INDEX IF NOT EXISTS ll_scenes_scope ON ll_scenes (scope_key, generated_at)',
  scenesByCharacter: 'CREATE INDEX IF NOT EXISTS ll_scenes_character ON ll_scenes (character_id, generated_at)',
  plans: 'CREATE TABLE IF NOT EXISTS ll_plans (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, day TEXT NOT NULL, title TEXT, mood TEXT, day_type TEXT, nodes TEXT NOT NULL, changes TEXT, data TEXT, generated_at INTEGER NOT NULL)',
  plansByCharacter: 'CREATE INDEX IF NOT EXISTS ll_plans_character ON ll_plans (character_id, day DESC)',
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
  getPlan: 'SELECT * FROM ll_plans WHERE character_id = ? AND day = ?',
  listPlans: 'SELECT * FROM ll_plans WHERE character_id = ? ORDER BY day DESC LIMIT ?',
  savePlan: `INSERT OR REPLACE INTO ll_plans (${planColumns}) VALUES (${planBindings})`,
  insertLegacyPlan: `INSERT OR IGNORE INTO ll_plans (${planColumns}) SELECT ${planBindings} WHERE NOT EXISTS (SELECT 1 FROM ll_plans WHERE character_id = ? AND day = ?)`,
  deletePlan: 'DELETE FROM ll_plans WHERE character_id = ? AND day = ?',
  acquire: 'INSERT OR IGNORE INTO ll_locks (character_id, owner, expires_at) VALUES (?, ?, ?)',
  takeover: 'UPDATE ll_locks SET owner = ?, expires_at = ? WHERE character_id = ? AND expires_at < ?',
  getLock: 'SELECT owner FROM ll_locks WHERE character_id = ?',
  release: 'DELETE FROM ll_locks WHERE character_id = ? AND owner = ?'
};

function decodePlan(row) {
  if (!row) return null;
  let extra = {};
  if (row.data) {
    try { extra = JSON.parse(row.data); } catch {}
  }
  let nodes = [];
  try {
    nodes = typeof row.nodes === 'string' ? JSON.parse(row.nodes) : (row.nodes || []);
  } catch {}
  let changes = [];
  try {
    changes = typeof row.changes === 'string' ? JSON.parse(row.changes) : (row.changes || []);
  } catch {}
  let dayType = null;
  if (row.day_type) {
    try {
      dayType = String(row.day_type).startsWith('{') ? JSON.parse(row.day_type) : { id: row.day_type, name: row.day_type };
    } catch {
      dayType = { id: row.day_type, name: row.day_type };
    }
  }
  return {
    ...extra,
    id: row.id,
    characterId: row.character_id,
    day: row.day,
    title: row.title || extra.title || '',
    mood: row.mood || extra.mood || '',
    dayType: dayType || extra.dayType || null,
    nodes,
    changes,
    source: extra.source || 'generated',
    generatedAt: Number(row.generated_at) || extra.generatedAt || Date.now()
  };
}

export function createStore(client) {
  const query = async (sql, args = []) => {
    const r = await client.db.executeSql(sql, args);
    if (!r || !Array.isArray(r.rows)) throw new Error('当前 Layla 未返回有效的数据库结果');
    return r;
  };
  const decode = r => r.rows.map(x => JSON.parse(x.data));

  async function persistPlan(characterId, day, data, legacy = false) {
    const plan = {
      ...data,
      id: data?.id || `${characterId}-${day}`,
      characterId,
      day,
      title: data?.title || '',
      mood: data?.mood || '',
      nodes: data?.nodes || [],
      changes: data?.changes || [],
      source: data?.source || 'generated',
      generatedAt: data?.generatedAt || Date.now()
    };
    const dayType = plan.dayType && typeof plan.dayType === 'object' ? JSON.stringify(plan.dayType) : String(plan.dayType || '');
    const encoded = JSON.stringify(plan);
    const args = [plan.id, characterId, day, plan.title, plan.mood, dayType, JSON.stringify(plan.nodes), JSON.stringify(plan.changes), encoded, plan.generatedAt];
    if (legacy) {
      // A concurrent writer or an earlier migration may already own this character/day.
      await query(SQL.insertLegacyPlan, [...args, characterId, day]);
    } else {
      await query(SQL.savePlan, args);
    }
    return JSON.parse(encoded);
  }

  async function populateProfilePlans(profile) {
    for (const [day, plan] of Object.entries(profile.plans)) {
      await persistPlan(profile.characterId, day, { ...plan, generatedAt: plan?.generatedAt || profile.createdAt }, true);
    }
    const saved = await store.plans(profile.characterId, { limit: 365 });
    profile.plans = Object.fromEntries(saved.map(plan => [plan.day, plan]));
    return profile;
  }

  const store = {
    query,
    async init() {
      for (const sql of [SQL.profiles, SQL.docs, SQL.runs, SQL.locks, SQL.scenes, SQL.scenesByScope, SQL.scenesByCharacter, SQL.plans, SQL.plansByCharacter]) {
        await query(sql);
      }
    },
    async getProfile(id) {
      const p = decode(await query(SQL.getProfile, [id]))[0];
      if (!p) return null;
      const upgraded = upgradeProfile(p);
      return populateProfilePlans(upgraded);
    },
    async profiles() {
      const list = decode(await query(SQL.listProfiles)).map(upgradeProfile);
      for (const prof of list) {
        await populateProfilePlans(prof);
      }
      return list;
    },
    async putProfile(p) {
      // Plans are hydrated for the time-line calculators and persisted separately.
      const { plans, ...data } = p;
      await query(SQL.putProfile, [p.characterId, JSON.stringify(data)]);
    },
    async getDoc(id) {
      const d = decode(await query(SQL.getDoc, [id]))[0];
      return d ? upgradeDocument(d) : null;
    },
    async docs(id) {
      return decode(await query(SQL.listDocs, [id])).map(upgradeDocument);
    },
    async putDoc(d) {
      await query(SQL.putDoc, [d.id, d.characterId, d.day, d.kind, d.createdAt, JSON.stringify(d)]);
    },
    async addRun(r) {
      await query(SQL.addRun, [r.id, r.characterId, r.at, JSON.stringify(r)]);
    },
    async runs(id) {
      return decode(await query(SQL.listRuns, [id]));
    },
    async allRuns(id) {
      return decode(await query(SQL.listAllRuns, [id]));
    },
    async getScene(key, before = Date.now()) {
      return decode(await query(SQL.getScene, [key, before]))[0] || null;
    },
    async scenes(id, { before = Number.MAX_SAFE_INTEGER, limit = 200 } = {}) {
      return decode(await query(SQL.listScenes, [id, before, limit]));
    },
    async putScene(s) {
      await query(SQL.putScene, [s.id, s.characterId, s.key, s.day, s.generatedAt, JSON.stringify(s)]);
    },
    async getPlan(characterId, day) {
      const r = await query(SQL.getPlan, [characterId, day]);
      if (r.rows && r.rows.length) {
        return decodePlan(r.rows[0]);
      }
      return null;
    },
    async savePlan(characterId, day, planData) {
      if (typeof characterId === 'object' && characterId !== null && !planData) {
        const data = characterId;
        return persistPlan(data.characterId || data.character_id, data.day, data);
      }
      return persistPlan(characterId, day, planData);
    },
    async saveProfile(profile) {
      return store.putProfile(profile);
    },
    async plans(characterId, { limit = 30 } = {}) {
      const r = await query(SQL.listPlans, [characterId, limit]);
      return (r.rows || []).map(decodePlan);
    },
    async applyPlanChange(characterId, day, change) {
      return store.lock(characterId, async () => {
        const prof = await store.getProfile(characterId);
        const existing = await store.getPlan(characterId, day) || {
          title: '日常',
          mood: '平静',
          dayType: { id: 'workday', name: '上班日' },
          nodes: templatePlan(day, prof || { settings: {} }),
          changes: []
        };
        const { items, changeRecord } = applyChange(existing.nodes, change, day);
        return store.savePlan(characterId, day, {
          ...existing, nodes: items, changes: [...existing.changes, changeRecord], source: 'manual'
        });
      });
    },
    async lock(id, action) {
      const now = Date.now(), owner = `${now}-${Math.random()}`;
      await query(SQL.acquire, [id, owner, now + 30 * 60000]);
      await query(SQL.takeover, [owner, now + 30 * 60000, id, now]);
      const r = await query(SQL.getLock, [id]);
      if (r.rows[0]?.owner !== owner) throw new Error('这个角色正在处理另一项任务，请稍后再试');
      try { return await action(); } finally { await query(SQL.release, [id, owner]); }
    }
  };

  return store;
}
