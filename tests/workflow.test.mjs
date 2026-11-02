import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import { createProfile, documentId, epoch, memoryPayload } from '../src/core.js';
import { readTriples } from '../src/memory-graph.js';
import { generateCurrentScene, generateDocument, generatePlan, runBackground, syncCharacterCard, writeMemory } from '../src/workflow.js';

const character = { id: 'a', data: { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '甲', description: '角色', personality: '', scenario: '', post_history_instructions: '' } } };
const now = epoch('2026-11-01', 22 * 60);
function fixture() {
  const db = new DatabaseSync(':memory:'); let creates = 0, mode = 'ok', calls = 0, customDoc = null;
  const role = structuredClone(character), memories = [], requests = [], cardUpdates = [];
  const client = {
    db: { executeSql: async (q, args = []) => { const stmt = db.prepare(q); if (/^SELECT/.test(q)) return { rows: stmt.all(...args), rowsAffected: 0, insertId: 0 }; const r = stmt.run(...args); return { rows: [], rowsAffected: Number(r.changes), insertId: Number(r.lastInsertRowid) }; } },
    characters: { list: async () => [role], update: async updated => { cardUpdates.push(structuredClone(updated)); role.data = structuredClone(updated.data); return updated.id; } },
    chat: { getChatSessions: async () => ({ sessions: [{ session_id: 's' }] }), getChatHistory: async () => [{ id: 1, role: 'user', content: '你好', timestamp: now - 10000, character_id: 'a', session_id: 's' }], completions: { create: async request => { calls++; requests.push(request); return { choices: [{ message: { content: JSON.stringify(request.messages[0].content.includes('TASK:MEMORY_GRAPH') ? (() => { const c = JSON.parse(request.messages[1].content); return [{ subject: c.recordNode, relationship: c.allowedRelationships.find(r => r.endsWith('细节')), object: c.rawText.slice(-8) }]; })() : request.messages[0].content.includes('TASK:SCENE') ? { scene: '角色继续做手边的日常小事，先将放在一旁的物件整理妥当，再停下来慢慢调整节奏。这段安静的时间里，她不急着开始下一件事，只专心留意眼前正在发生的细节。' } : (customDoc || { title: '今日记录', body: '这是经过验证的正文。', summary: '角色今日记录。' })) } }] }; } } },
    personas: { get: async () => ({ name: '用户', description: '' }) },
    memories: { getTopMemories: async () => memories, list: async (_id, offset, limit) => memories.slice(offset, offset + limit), createOrUpdate: async rows => { const saved = rows.map(m => { if (m.id > 0) { const i = memories.findIndex(x => x.id === m.id); if (i < 0) throw new Error('missing id'); memories[i] = { ...m }; return memories[i]; } creates++; const added = { ...m, id: 100 + memories.length }; memories.push(added); return added; }); if (mode === 'lost') throw new Error('连接中断'); return saved; } }
  };
  return { client, store: createStore(client), db, role, memories, requests, cardUpdates, get creates() { return creates; }, get calls() { return calls; }, setMode(value) { mode = value; }, setDoc(value) { customDoc = value; } };
}
function document() { return { id: documentId('a', 'diary', '2026-11-01'), characterId: 'a', sessionId: 's', kind: 'diary', day: '2026-11-01', title: '日记', body: '角色日记。', summary: '角色今天的日记。', createdAt: now, syncStatus: 'pending' }; }

test('memory write is idempotent and does not alter unrelated memories', async () => {
  const f = fixture(); await f.store.init(); await f.store.putDoc(document()); f.memories.push({ id: 1, character_id: 'a', rawText: '原有记忆' });
  const one = await writeMemory(f.client, f.store, document().id); const two = await writeMemory(f.client, f.store, document().id);
  assert.equal(one.memoryId, two.memoryId); assert.equal(f.creates, 1); assert.equal(f.memories[0].rawText, '原有记忆'); assert.equal(one.retrievalStatus, 'unverified'); f.db.close();
});
test('lost host receipt is recovered by marker lookup without sending twice', async () => {
  const f = fixture(); await f.store.init(); await f.store.putDoc(document()); f.setMode('lost');
  await assert.rejects(writeMemory(f.client, f.store, document().id), /连接中断/);
  assert.equal((await f.store.getDoc(document().id)).syncStatus, 'uncertain');
  const recovered = await writeMemory(f.client, f.store, document().id, { reconcileOnly: true });
  assert.equal(recovered.syncStatus, 'written'); assert.equal(f.creates, 1); f.db.close();
});
test('uncertain write with no matching host record never silently resends', async () => {
  const f = fixture(); await f.store.init(); await f.store.putDoc({ ...document(), syncStatus: 'uncertain' });
  await assert.rejects(writeMemory(f.client, f.store, document().id), /待核对/); assert.equal(f.creates, 0); f.db.close();
});
test('existing native marker is reconciled even if local write state was lost', async () => {
  const f = fixture(); await f.store.init(); await f.store.putDoc(document()); f.memories.push({ ...memoryPayload(document()), id: 44 });
  const saved = await writeMemory(f.client, f.store, document().id); assert.equal(saved.memoryId, 44); assert.equal(f.creates, 0); f.db.close();
});
test('per-role lease blocks concurrent jobs and releases after failure', async () => {
  const f = fixture(); await f.store.init(); let release;
  const blocking = f.store.lock('a', () => new Promise(r => { release = r; }));
  await new Promise(r => setImmediate(r));
  await assert.rejects(f.store.lock('a', () => {}), /另一项任务/); release(); await blocking;
  await assert.rejects(f.store.lock('a', async () => { throw new Error('bad'); }), /bad/);
  assert.equal(await f.store.lock('a', async () => 'ok'), 'ok'); f.db.close();
});
test('document generation is once per day and filters generated memory evidence', async () => {
  const f = fixture(); await f.store.init(); await f.store.putProfile(createProfile(character, now));
  f.memories.push({ ...memoryPayload(document()), id: 77 }, { id: 78, rawText: '真实原生记忆', summary: '真实原生记忆', timestamp: now });
  const first = await generateDocument(f.client, f.store, character, 'diary', { now });
  const again = await generateDocument(f.client, f.store, character, 'diary', { now: now + 1000 });
  assert.equal(first.id, again.id); assert.equal(f.calls, 2); assert.equal((await f.store.docs('a')).length, 1);
  const context = JSON.parse(f.requests.find(r => r.messages[0].content.includes('TASK:DIARY')).messages[1].content);
  assert.equal(context.memories.length, 1); assert.equal(context.memories[0].text, '真实原生记忆'); f.db.close();
});
test('invalid model schedule preserves existing plan and unlocks the role', async () => {
  const f = fixture(); await f.store.init(); const p = createProfile(character, now); p.plans['2026-11-01'] = { source: 'manual', nodes: [] }; await f.store.putProfile(p);
  await assert.rejects(generatePlan(f.client, f.store, character, { now }), /节点/);
  assert.equal((await f.store.getProfile('a')).plans['2026-11-01'].source, 'manual'); await f.store.lock('a', async () => {}); f.db.close();
});
test('background is opt-in and produces at most one document without implicit native writes', async () => {
  const f = fixture(); await f.store.init(); const p = createProfile(character, now - 10000); await f.store.putProfile(p);
  assert.equal((await runBackground(f.client, f.store, { now })).status, 'idle');
  p.settings.background = true; await f.store.putProfile(p);
  await runBackground(f.client, f.store, { now }); await runBackground(f.client, f.store, { now: now + 1000 });
  assert.equal(f.calls, 2); assert.equal(f.creates, 0); assert.equal((await f.store.docs('a')).length, 1); f.db.close();
});

test('packaged task returns its Promise and runs without DOM, timers, fetch or Intl', async () => {
  const { build } = await import('esbuild'); const vm = await import('node:vm');
  const f = fixture(); await f.store.init(); const p = createProfile(f.role, now - 10000); p.settings.background = true; p.settings.autoWrite = true; await f.store.putProfile(p);
  const built = await build({ entryPoints: [fileURLToPath(new URL('../src/task-entry.js', import.meta.url))], bundle: true, format: 'iife', globalName: 'LifeTask', write: false, target: 'es2020' });
  const code = built.outputFiles[0].text + '\nLifeTask.run();';
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const sandbox = { layla: f.client, Date: FixedDate, Intl: undefined, console: { info() {}, log() {}, error() {} } };
  const completion = vm.runInNewContext(code, sandbox); assert.equal(typeof completion.then, 'function');
  const result = await completion; assert.equal(result.status, 'ok'); assert.equal(f.calls, 3); assert.equal(f.creates, 1);
  assert.equal((await f.store.docs('a'))[0].syncStatus, 'written');
  assert.match(f.role.data.data.post_history_instructions, /【生活手记·实时状态】/);
  f.db.close();
});

test('scheme 1 card sync and scheme 2 LTM graph align on 08:44 wake-up and clean up losslessly', async () => {
  const f = fixture(); await f.store.init();
  f.role.data.data.post_history_instructions = '保持既有角色口吻。';
  const morning = epoch('2026-11-01', 8 * 60 + 44);
  await f.store.putProfile(createProfile(f.role, morning - 60000));
  const sc = await generateCurrentScene(f.client, f.store, f.role, { now: morning });
  const identityBefore = sc.profile.sceneIdentity;
  assert.ok(f.role.data.data.post_history_instructions.startsWith('保持既有角色口吻。'));
  assert.match(f.role.data.data.post_history_instructions, /08:44/);

  f.setDoc({ title: '晨起读书', body: '今天早上8:44起床，简单吃过早饭后整理了窗边的读书笔记。', summary: '早上8:44起床，整理了窗边的读书笔记。' });
  const diary = await generateDocument(f.client, f.store, f.role, 'diary', { now });
  const diaryPrompt = JSON.parse(f.requests.find(r => r.messages[0].content.includes('TASK:DIARY')).messages[1].content);
  assert.equal(diaryPrompt.timelineAnchors.firstRecordedAwakeTime, '08:44');
  assert.equal((await f.store.getProfile('a')).sceneIdentity, identityBefore);
  assert.match(f.role.data.data.post_history_instructions, /早上8:44起床/);

  const saved = await writeMemory(f.client, f.store, diary.id);
  assert.equal(saved.syncStatus, 'written'); assert.equal(saved.graphStatus, 'ready');
  assert.equal(f.memories[0].session_id, 'life-archive-a');
  assert.match(f.memories[0].summary, /早上8:44起床/);
  const triples = readTriples(f.memories[0].knowledgeGraphJSON);
  assert.ok(triples.some(t => t.subject === '甲' && t.relationship === '2026-11-01作息' && t.object === '早上8:44起床'));

  await syncCharacterCard(f.client, f.store, f.role, { now, clear: true, forceSync: true });
  assert.equal(f.role.data.data.post_history_instructions, '保持既有角色口吻。');
  f.db.close();
});

test('forced same-day diary regeneration updates existing native memory in place without duplicate rows', async () => {
  const f = fixture(); await f.store.init(); await f.store.putProfile(createProfile(f.role, now - 3600000));
  f.setDoc({ title: '初版日记', body: '早上8:44起床，上午在家看书。', summary: '早上8:44起床，上午看书。' });
  const first = await generateDocument(f.client, f.store, f.role, 'diary', { now: now - 1800000 });
  const written = await writeMemory(f.client, f.store, first.id);
  assert.equal(f.creates, 1);

  f.setDoc({ title: '晚间补充日记', body: '早上8:44起床，上午看书，晚上又整理了书架。', summary: '早上8:44起床，看书并在晚间整理了书架。' });
  const refreshed = await generateDocument(f.client, f.store, f.role, 'diary', { now, force: true });
  assert.equal(refreshed.memoryId, written.memoryId);
  assert.equal(refreshed.syncStatus, 'stale');

  const updated = await writeMemory(f.client, f.store, refreshed.id);
  assert.equal(updated.memoryId, written.memoryId);
  assert.equal(updated.syncStatus, 'written');
  assert.equal(updated.graphStatus, 'ready');
  assert.equal(f.creates, 1);
  assert.equal(f.memories.length, 1);
  assert.match(f.memories[0].summary, /整理了书架/);
  f.db.close();
});
