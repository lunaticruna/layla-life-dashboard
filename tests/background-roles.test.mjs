import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { VERSION, createProfile, epoch } from '../src/core.js';
import { createStore } from '../src/store.js';
import { configurePurpose, runPurposeBackground } from '../src/purpose-runner.js';
import { createPurposeStore } from '../src/purpose-store.js';
import { runBackground } from '../src/workflow.js';
import { runTasks } from '../src/task-runner.js';

const now = epoch('2026-11-08', 14 * 60);
const role = (id, name = '同名角色') => ({ id, data: { spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: '', personality: '', scenario: '', post_history_instructions: '' } } });
async function fixture() {
  const db = new DatabaseSync(':memory:');
  const f = { db, roles: [role('current-id')], nativeCalls: [], modelCalls: 0, nativeWrites: 0 };
  const rejectWrite = async () => { f.nativeWrites++; throw new Error('此用例不应写原生数据'); };
  f.client = {
    db: { executeSql: async (q, args = []) => {
      const s = db.prepare(q);
      if (/^SELECT/.test(q)) return { rows: s.all(...args), rowsAffected: 0 };
      const r = s.run(...args); return { rows: [], rowsAffected: Number(r.changes), insertId: Number(r.lastInsertRowid) };
    } },
    characters: { list: async (offset = 0, range = 50) => f.roles.slice(offset, offset + range), update: rejectWrite },
    chat: {
      getChatSessions: async id => { f.nativeCalls.push(id); return { sessions: [{ session_id: `s-${id}` }] }; },
      getChatHistory: async () => [],
      getScheduledChatMessages: async () => [], scheduleChatMessage: rejectWrite, cancelScheduledChatMessage: rejectWrite,
      completions: { create: async () => { f.modelCalls++; throw new Error('此用例不应调用模型'); } }
    },
    memories: { getTopMemories: async () => [], createOrUpdate: rejectWrite },
    personas: { get: async () => null }
  };
  f.store = createStore(f.client); await f.store.init();
  f.profile = async (id, { background = true, lastRunAt = 0 } = {}) => {
    const p = createProfile(role(id), now - 4 * 3600000);
    Object.assign(p.settings, { background, autoScene: false, autoPlan: false, autoWrite: false, syncCard: false });
    p.lastRunAt = lastRunAt; await f.store.putProfile(p); return p;
  };
  f.purpose = async id => configurePurpose(f.client, f.store, id, { mode: 'observe', background: true, sessionId: `s-${id}` }, { now });
  return f;
}

test('background: an unavailable oldest life profile cannot starve the enabled current character', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.profile('old-id'); await f.profile('current-id', { lastRunAt: now - 1000 });
  const old = await f.store.getProfile('old-id');
  const result = await runBackground(f.client, f.store, { now });
  assert.equal(result.status, 'ok'); assert.equal(result.characterId, 'current-id');
  assert.equal(result.warnings.length, 1);
  assert.equal(result.diagnostics.unavailable[0].characterId, 'old-id');
  assert.equal((await f.store.getProfile('current-id')).lastRunAt, now);
  assert.deepEqual(await f.store.getProfile('old-id'), old);
  assert.equal(f.nativeWrites, 0); assert.equal(f.modelCalls, 0);
  const combined = await runTasks(f.client, f.store, { now: now + 1000 });
  assert.equal(combined.status, 'partial'); assert.equal(combined.life.status, 'ok');
  assert.equal(combined.life.characterId, 'current-id');
});

test('background: the reported no_goal plus unavailable-life combination is partial, not successful life work', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.profile('old-id'); await f.profile('current-id', { background: false }); await f.purpose('current-id');
  const result = await runTasks(f.client, f.store, { now });
  assert.equal(result.purpose.status, 'no_goal'); assert.equal(result.purpose.characterId, 'current-id');
  assert.equal(result.life.status, 'skipped'); assert.equal(result.status, 'partial');
  assert.equal(result.appVersion, VERSION);
  assert.equal(result.life.reason, 'background_character_mismatch');
  assert.deepEqual(result.life.diagnostics.configured.map(x => x.characterId), ['old-id']);
  assert.deepEqual(result.life.diagnostics.visible.map(x => x.characterId), ['current-id']);
  assert.equal(result.life.diagnostics.unavailable[0].name, '同名角色');
  assert.equal(f.nativeWrites, 0);
});

test('background: empty host visibility is reported without deleting or disabling stored profiles', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await f.profile('current-id');
  const before = await f.store.getProfile('current-id'); f.roles = [];
  const result = await runTasks(f.client, f.store, { now });
  assert.equal(result.status, 'partial'); assert.equal(result.life.reason, 'host_characters_empty');
  assert.equal(result.life.diagnostics.visibleCount, 0); assert.equal(result.life.diagnostics.configuredCount, 1);
  assert.deepEqual(await f.store.getProfile('current-id'), before);
  f.roles = [role('current-id')];
  assert.equal((await runBackground(f.client, f.store, { now })).status, 'ok');
});

test('background: same-name cards are never substituted for an unavailable id', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await f.profile('old-id');
  const result = await runBackground(f.client, f.store, { now });
  assert.equal(result.status, 'skipped');
  assert.equal(result.diagnostics.unavailable[0].characterId, 'old-id');
  assert.equal(result.diagnostics.visible[0].characterId, 'current-id');
  assert.deepEqual(f.nativeCalls, []); assert.equal(f.nativeWrites, 0);
});

test('background: valid profiles keep their oldest-first rotation even with unavailable entries', async t => {
  const f = await fixture(); t.after(() => f.db.close()); f.roles.push(role('second-id'));
  await f.profile('old-id'); await f.profile('current-id'); await f.profile('second-id');
  const results = [];
  for (let i = 0; i < 3; i++) results.push((await runBackground(f.client, f.store, { now: now + i * 1000 })).characterId);
  assert.deepEqual(results, ['current-id', 'second-id', 'current-id']);
});

test('background: unavailable purpose records cannot consume the only execution slot', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await f.profile('current-id', { background: false });
  await f.purpose('old-id'); await f.purpose('current-id');
  const ps = createPurposeStore(f.store);
  await ps.lock('old-id', async (r, save) => { r.deliveries.push({ id: 'old-uncertain', status: 'uncertain', hostId: 10 }); await save(); });
  const old = await ps.get('old-id');
  const result = await runPurposeBackground(f.client, f.store, { now });
  assert.equal(result.status, 'no_goal'); assert.equal(result.characterId, 'current-id'); assert.equal(result.warnings.length, 1);
  assert.deepEqual(await ps.get('old-id'), old); assert.equal(f.nativeWrites, 0);
});

test('background: ordinary no_goal with a successfully processed life profile remains ok', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await f.profile('current-id'); await f.purpose('current-id');
  const result = await runTasks(f.client, f.store, { now });
  assert.equal(result.purpose.status, 'no_goal'); assert.equal(result.life.status, 'ok'); assert.equal(result.status, 'ok');
  assert.equal(f.nativeWrites, 0);
});

test('background: disabled old profiles are not mistaken for enabled background configuration', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await f.profile('old-id', { background: false }); await f.profile('current-id');
  const result = await runTasks(f.client, f.store, { now });
  assert.equal(result.status, 'ok'); assert.deepEqual(result.life.warnings, []);
  assert.equal(result.life.diagnostics.configuredCount, 1);
});

test('background: id type differences are exposed, not silently rebound', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await f.profile('42'); f.roles = [role(42)];
  const result = await runBackground(f.client, f.store, { now });
  assert.equal(result.status, 'skipped');
  assert.equal(result.diagnostics.configured[0].idType, 'string');
  assert.equal(result.diagnostics.visible[0].idType, 'number');
  assert.deepEqual(f.nativeCalls, []); assert.equal(f.nativeWrites, 0);
});

test('background: role diagnostics are bounded while preserving complete counts', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  f.roles = Array.from({ length: 30 }, (_, i) => role(`visible-${i}`));
  for (let i = 0; i < 25; i++) await f.profile(`old-${i}`);
  const result = await runBackground(f.client, f.store, { now });
  const d = result.diagnostics;
  assert.equal(result.status, 'skipped'); assert.equal(d.configuredCount, 25); assert.equal(d.visibleCount, 30);
  assert.equal(d.unavailableCount, 25); assert.equal(d.matchedCount, 0);
  assert.equal(d.configured.length, 20); assert.equal(d.visible.length, 20); assert.equal(d.unavailable.length, 20);
  assert.deepEqual(d.truncated, { configured: true, visible: true, unavailable: true });
  assert.equal(f.nativeWrites, 0);
});
