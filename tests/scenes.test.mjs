import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import { createProfile, epoch, makeSnapshot, templatePlan, validateScene } from '../src/core.js';
import { generateCurrentScene, generateDocument, generatePlan, refreshLife, runBackground } from '../src/workflow.js';

const day = '2026-11-01', at = minute => epoch(day, minute);
const character = { id: 'scene-a', data: { data: { name: '璃', description: '银白色长发，狐狸耳与尾巴，住在自己的公寓。', personality: '细心，喜欢阅读。', scenario: '周末在家。' } } };
const prose = '璃在自己的节奏里做着眼前的小事，指尖轻轻理过放在一旁的物件，再停下来想一想。银白色的长发落在肩边，她顺手将它拨开，让注意力重新回到当前的活动上。这段普通的日常没有太多波折，几个细小的动作和停顿，就让时间慢慢往前走了一点。';

async function fixture(t, now = at(860)) {
  const db = new DatabaseSync(':memory:'), requests = [], memories = [];
  let reply = request => request.messages[0].content.includes('TASK:SCENE') ? { scene: prose } : request.messages[0].content.includes('TASK:PLAN') ? { nodes: templatePlan(day, createProfile(character, now)) } : { title: '日常片段', body: '根据已有记录写下今天的片段。', summary: '角色模拟生活记录。' };
  let history = [];
  const client = {
    db: { executeSql: async (q, args = []) => { const stmt = db.prepare(q); if (/^SELECT/.test(q)) return { rows: stmt.all(...args) }; const r = stmt.run(...args); return { rows: [], rowsAffected: Number(r.changes), insertId: Number(r.lastInsertRowid) }; } },
    characters: { list: async () => [character] },
    chat: { getChatSessions: async () => ({ sessions: [{ session_id: 'native-a' }] }), getChatHistory: async () => history, completions: { create: async request => { requests.push(request); const value = await reply(request); return { choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }; } } },
    personas: { get: async () => ({ name: '用户' }) },
    memories: { getTopMemories: async () => [], list: async () => memories, createOrUpdate: async rows => { const saved = rows.map(m => ({ ...m, id: memories.length + 1 })); memories.push(...saved); return saved; } }
  };
  const store = createStore(client); await store.init(); await store.putProfile(createProfile(character, now));
  t.after(() => db.close());
  return { client, store, db, requests, memories, setReply(fn) { reply = fn; }, setHistory(rows) { history = rows; } };
}
function context(request) { return JSON.parse(request.messages[1].content); }
function sceneRequests(f) { return f.requests.filter(r => r.messages[0].content.includes('TASK:SCENE')); }

test('0.1 profiles gain scene defaults without losing plans, settings or archived content', async t => {
  const f = await fixture(t), p = await f.store.getProfile(character.id);
  p.schema = 1; delete p.settings.autoScene; delete p.currentScene; p.settings.home = '旧住处'; p.state.energy = 42;
  p.plans[day] = { source: 'manual', nodes: templatePlan(day, p) };
  await f.store.putProfile(p); await f.store.putDoc({ id: 'old', characterId: character.id, day, kind: 'diary', createdAt: at(600), body: '旧日记', syncStatus: 'written', memoryId: 66 });
  const migrated = await f.store.getProfile(character.id);
  assert.equal(migrated.schema, 3); assert.equal(migrated.settings.autoScene, true); assert.equal(migrated.settings.home, '旧住处'); assert.equal(migrated.state.energy, 42);
  assert.deepEqual(migrated.plans, p.plans); assert.equal((await f.store.getDoc('old')).memoryId, 66); assert.equal(f.requests.length, 0);
});

test('same node and phase reuse SQLite cache; forced regeneration archives a new revision', async t => {
  const f = await fixture(t);
  const first = await generateCurrentScene(f.client, f.store, character, { now: at(860) });
  const again = await generateCurrentScene(f.client, f.store, character, { now: at(861) });
  assert.equal(again.record.id, first.record.id); assert.equal(sceneRequests(f).length, 1);
  const reloaded = makeSnapshot(await f.store.getProfile(character.id), at(861)); assert.equal(reloaded.activity, first.record.scene); assert.equal(reloaded.current.scene, first.record.scene);
  const regenerated = await generateCurrentScene(f.client, f.store, character, { now: at(862), force: true });
  assert.notEqual(regenerated.record.id, first.record.id); assert.equal((await f.store.scenes(character.id)).length, 2);
  assert.equal(context(sceneRequests(f)[1]).previousScenes[0].scene, first.record.scene); assert.equal(f.memories.length, 0);
});

test('scene prompts use existing card, current time and phase; stale weather is withheld', async t => {
  const f = await fixture(t, at(60)), p = await f.store.getProfile(character.id);
  p.settings.weatherNote = '下雪 · -2°C'; p.settings.weatherAt = at(0) - 8 * 3600000;
  await f.store.putProfile(p); await generateCurrentScene(f.client, f.store, character, { now: at(60) });
  const input = context(sceneRequests(f)[0]);
  assert.match(input.role.description, /狐狸耳/); assert.equal(input.state.sleepPhase, 'deep_sleep'); assert.equal(input.currentNode.kind, 'sleep'); assert.equal(input.time, `${day} 01:00`);
  assert.equal(input.weather, null); assert.match(input.weatherStatus, /超过六小时/); assert.equal(input.currentNode.remainingMinutes, 420);
});

test('sleep stage, actual reply wake and return to sleep produce distinct current scenes', async t => {
  const f = await fixture(t, at(1410));
  await generateCurrentScene(f.client, f.store, character, { now: at(1415) });
  const light = await generateCurrentScene(f.client, f.store, character, { now: at(1426) });
  assert.equal(light.record.phase, 'light_sleep');
  f.setHistory([{ id: 99, role: 'assistant', content: '刚刚回复了。', timestamp: at(1427), session_id: 'native-a' }]);
  const awake = await refreshLife(f.client, f.store, character, { now: at(1428) }); assert.equal(awake.scene.record.phase, 'woken');
  const nextMorning = await generateCurrentScene(f.client, f.store, character, { now: at(1488) });
  assert.equal(nextMorning.record.phase, 'deep_sleep'); assert.notEqual(nextMorning.record.key, light.record.key);
  assert.equal(sceneRequests(f).length, 4);
});

test('returning to deep sleep after a wake window does not reuse the pre-wake scene', async t => {
  const f = await fixture(t, at(60));
  const first = await generateCurrentScene(f.client, f.store, character, { now: at(60) });
  f.setHistory([{ id: 18, role: 'assistant', content: '嗯。', timestamp: at(65), session_id: 'native-a' }]);
  await refreshLife(f.client, f.store, character, { now: at(66) });
  const returned = await refreshLife(f.client, f.store, character, { now: at(100) });
  assert.equal(returned.scene.record.phase, 'deep_sleep'); assert.notEqual(returned.scene.record.key, first.record.key); assert.equal(sceneRequests(f).length, 3);
});

test('invalid scene keeps last valid paragraph; retry backoff and explicit retry work', async t => {
  const f = await fixture(t);
  const first = await generateCurrentScene(f.client, f.store, character, { now: at(860) });
  f.setReply(() => ({ scene: '太短' }));
  await assert.rejects(generateCurrentScene(f.client, f.store, character, { now: at(861), force: true }), /40–500/);
  assert.equal(makeSnapshot(await f.store.getProfile(character.id), at(861)).scene, first.record.scene);
  const cooldown = await generateCurrentScene(f.client, f.store, character, { now: at(862) });
  assert.equal(cooldown.status, 'cached'); assert.equal(sceneRequests(f).length, 2);
  f.setReply(() => ({ scene: prose + '她又停了一小会儿。' }));
  const retried = await generateCurrentScene(f.client, f.store, character, { now: at(862), force: true }); assert.equal(retried.status, 'generated'); assert.equal((await f.store.scenes(character.id)).length, 2);
});

test('failed first generation is not saved as an experience or retried on every refresh', async t => {
  const f = await fixture(t); f.setReply(() => ({ scene: '' }));
  const one = await refreshLife(f.client, f.store, character, { now: at(860) }); assert.equal(one.scene.status, 'error');
  const two = await refreshLife(f.client, f.store, character, { now: at(861) }); assert.equal(two.scene.status, 'cooldown');
  assert.equal(sceneRequests(f).length, 1); assert.equal((await f.store.scenes(character.id)).length, 0);
  await refreshLife(f.client, f.store, character, { now: at(871) }); assert.equal(sceneRequests(f).length, 2);
});

test('auto-off does not call the model; manual scene is preserved and recorded only when current', async t => {
  const f = await fixture(t), p = await f.store.getProfile(character.id); p.settings.autoScene = false;
  const nodes = templatePlan(day, p); const current = nodes.find(n => n.start <= 860 && n.end > 860); current.source = 'manual'; current.scene = '用户手动填写的当前场景。';
  nodes[nodes.length - 1].scene = '未来的手动睡前场景'; nodes[nodes.length - 1].source = 'manual'; p.plans[day] = { source: 'manual', nodes };
  await f.store.putProfile(p); const result = await refreshLife(f.client, f.store, character, { now: at(860) });
  assert.equal(result.scene.record.source, 'manual'); assert.equal(result.scene.record.scene, current.scene); assert.equal(f.requests.length, 0);
  assert.equal((await f.store.scenes(character.id)).length, 1);
  const future = await generateCurrentScene(f.client, f.store, character, { now: at(1145) }); assert.equal(future.status, 'disabled'); assert.equal(f.requests.length, 0);
});

test('schedule edits and character identities invalidate scene cache independently', async t => {
  const f = await fixture(t); const first = await generateCurrentScene(f.client, f.store, character, { now: at(860) });
  const changed = structuredClone(character); changed.data.data.description = '现在是黑色短发。';
  const second = await generateCurrentScene(f.client, f.store, changed, { now: at(861) }); assert.notEqual(first.record.key, second.record.key);
  const p = await f.store.getProfile(character.id), nodes = templatePlan(day, p); nodes.find(n => n.start <= 860 && n.end > 860).summary = '新的活动'; p.plans[day] = { source: 'manual', nodes }; await f.store.putProfile(p);
  const third = await generateCurrentScene(f.client, f.store, changed, { now: at(862) }); assert.notEqual(second.record.key, third.record.key);
});

test('plans contain no prewritten future scenes; diary receives only recorded scenes up to cutoff', async t => {
  const f = await fixture(t); await generatePlan(f.client, f.store, character, { now: at(860) });
  const plan = (await f.store.getProfile(character.id)).plans[day]; assert.ok(plan.nodes.every(n => n.scene === ''));
  const current = (await f.store.scenes(character.id))[0];
  await f.store.putScene({ ...current, id: 'future', generatedAt: at(1300), scene: '未来才会发生的片段' });
  await f.store.putScene({ ...current, id: 'yesterday', day: '2026-10-31', generatedAt: at(0) - 60000, end: at(0), scene: '昨天的片段' });
  const document = await generateDocument(f.client, f.store, character, 'diary', { now: at(861) });
  const input = context(f.requests.find(r => r.messages[0].content.includes('TASK:DIARY')));
  assert.equal(input.lifeSchedule, undefined); assert.equal(input.experiencedScenes.length, 1); assert.equal(input.experiencedScenes[0].id, current.id);
  assert.equal(input.experiencedScenes[0].until, `${day} 14:21`); assert.deepEqual(document.sourceSceneIds, [current.id]); assert.equal(document.recordedThrough, at(861));
});

test('empty or offline gaps are not backfilled as life experiences', async t => {
  const f = await fixture(t), p = await f.store.getProfile(character.id); p.settings.autoScene = false; p.state.updatedAt = at(0) - 4 * 86400000; await f.store.putProfile(p);
  const doc = await generateDocument(f.client, f.store, character, 'diary', { now: at(860) });
  const input = context(f.requests[0]); assert.equal(input.experiencedScenes.length, 0); assert.match(input.lifeCoverage, /尚无/); assert.deepEqual(doc.sourceSceneIds, []); assert.equal((await f.store.scenes(character.id)).length, 0);
});

test('background generates at most one current scene and one daily document, reusing both on repeat', async t => {
  const f = await fixture(t, at(1320)), p = await f.store.getProfile(character.id); p.settings.background = true; await f.store.putProfile(p);
  await runBackground(f.client, f.store, { now: at(1320) }); await runBackground(f.client, f.store, { now: at(1321) });
  assert.equal(sceneRequests(f).length, 1); assert.equal(f.requests.length, 2); assert.equal((await f.store.docs(character.id)).length, 1); assert.equal(f.memories.length, 0);
});

test('malformed or oversized scene JSON is rejected without accepting model state changes', () => {
  assert.throws(() => validateScene({ scene: { text: 'wrong' } }), /scene/); assert.throws(() => validateScene({ scene: '字'.repeat(501) }), /40–500/);
  assert.equal(validateScene({ scene: prose, energy: 0, location: '火星' }), prose);
});

test('cancelled generation never archives a scene or writes native memory', async t => {
  const f = await fixture(t), controller = new AbortController();
  f.setReply(() => { controller.abort(); return { scene: prose }; });
  await assert.rejects(generateCurrentScene(f.client, f.store, character, { now: at(860), signal: controller.signal }), /停止/);
  assert.equal((await f.store.scenes(character.id)).length, 0); assert.equal(f.memories.length, 0);
});

test('a slow completion crossing a sleep stage is discarded rather than attached to the new stage', async t => {
  const f = await fixture(t, at(1410)); let clock = at(1424);
  t.mock.method(Date, 'now', () => clock);
  f.setReply(() => { clock = at(1426); return { scene: prose }; });
  await assert.rejects(generateCurrentScene(f.client, f.store, character), /阶段已变化/);
  assert.equal((await f.store.scenes(character.id)).length, 0);
  assert.equal(makeSnapshot(await f.store.getProfile(character.id), clock).scene, '');
});

test('scene history and cached paragraphs stay isolated between characters', async t => {
  const f = await fixture(t), other = structuredClone(character); other.id = 'scene-b'; other.data.data.name = '另一角色';
  const a = await generateCurrentScene(f.client, f.store, character, { now: at(860) });
  const b = await generateCurrentScene(f.client, f.store, other, { now: at(860) });
  assert.notEqual(a.record.key, b.record.key); assert.deepEqual((await f.store.scenes(character.id)).map(r => r.characterId), [character.id]);
  assert.equal((await f.store.getProfile(other.id)).currentScene.characterId, other.id);
});
