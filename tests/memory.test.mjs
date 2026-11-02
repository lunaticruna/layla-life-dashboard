import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import { createProfile, documentId, epoch, memoryPayload } from '../src/core.js';
import { buildGraph, graphContext, graphScope, readTriples } from '../src/memory-graph.js';
import { enrichMemory, recordRetrievalCheck, writeMemory } from '../src/memory.js';

const now = epoch('2026-11-01', 175);
const role = { id: 'custom-6', data: { data: { name: '瑠璃子' } } };
const doc = () => ({ id: documentId(role.id, 'dream', '2026-11-01'), characterId: role.id, sessionId: 'original-session', kind: 'dream', day: '2026-11-01', title: '窗灯与铃铛', body: '梦里我在咖啡馆，银色书签夹不住书页。开口时只有铃铛响，最后留着窗灯。', summary: '梦境：咖啡馆、银色书签、铃铛响和留下的窗灯。', createdAt: now, syncStatus: 'pending' });
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const memories = [], writes = [], prompts = [], f = { memories, writes, prompts, afterModel: null, beforeUpdate: null, updateMode: 'ok', response: null };
  const client = {
    db: { executeSql: async (q, args = []) => { const s = db.prepare(q); if (/^SELECT/.test(q)) return { rows: s.all(...args) }; const r = s.run(...args); return { rows: [], rowsAffected: Number(r.changes), insertId: Number(r.lastInsertRowid) }; } },
    memories: {
      list: async (id, offset, limit, options) => memories.filter(m => m.character_id === id && m.timestamp >= options.minTimestamp && m.timestamp <= options.maxTimestamp).sort((a, b) => b.timestamp - a.timestamp).slice(offset, offset + limit).map(m => structuredClone(m)),
      createOrUpdate: async rows => {
        const output = [];
        for (const m of rows) {
          writes.push(structuredClone(m));
          if (m.id <= 0) {
            const added = { ...m, id: 100 + memories.length, ...(f.dropCreateGraph ? { knowledgeGraphJSON: null } : {}) };
            memories.push(added); output.push(structuredClone(added)); continue;
          }
          if (f.beforeUpdate) await f.beforeUpdate(m);
          if (f.updateMode === 'reject') throw new Error('更新连接中断');
          const i = memories.findIndex(x => x.id === m.id); assert.ok(i >= 0, 'updates must target an existing id');
          memories[i] = { ...m }; output.push(structuredClone(m));
          if (f.updateMode === 'lost') throw new Error('更新回执丢失');
          if (f.updateMode === 'wrong-receipt') output[output.length - 1].id += 1;
          if (f.updateMode === 'stale-read') memories[i].knowledgeGraphJSON = null;
        }
        return output;
      }
    },
    chat: { completions: { create: async request => {
      prompts.push(request); const c = JSON.parse(request.messages[1].content);
      if (f.afterModel) await f.afterModel(c, request);
      const response = f.response ?? JSON.stringify([{ subject: c.recordNode, relationship: '梦中声音', object: '铃铛响' }, { subject: c.recordNode, relationship: '梦中地点', object: '咖啡馆' }]);
      return { choices: [{ message: { content: response } }] };
    } } }
  };
  return Object.assign(f, { client, store: createStore(client),
    async init(d = doc(), native = null) { await this.store.init(); await this.store.putProfile(createProfile(role, now)); await this.store.putDoc(d); if (native) memories.push(structuredClone(native)); },
    async legacy() { const d = { ...doc(), syncStatus: 'written', memoryId: 64 }; await this.init(d, { ...memoryPayload(d), id: 64 }); return d; }
  });
}

test('new handoff atomically writes text and graph on id 0 in isolated archive session, reads it back and keeps recall unverified', async t => {
  const f = fixture(t); await f.init();
  const saved = await writeMemory(f.client, f.store, doc().id);
  assert.equal(f.memories.length, 1); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].id, 0);
  assert.equal(saved.syncStatus, 'written'); assert.equal(saved.graphStatus, 'ready'); assert.equal(saved.retrievalStatus, 'unverified');
  const original = f.writes[0], updated = f.memories[0];
  assert.equal(updated.session_id, `life-archive-${role.id}`);
  for (const k of ['rawText', 'summary', 'timestamp', 'session_id', 'character_id', 'knowledgeGraphJSON']) assert.equal(updated[k], original[k]);
  const graph = readTriples(updated.knowledgeGraphJSON);
  assert.ok(graph.some(x => x.subject === '瑠璃子' && x.relationship === '梦境记录'));
  assert.ok(graph.some(x => x.object === '梦境，不是现实事件'));
  assert.ok(graph.filter(x => x.relationship.startsWith('梦中')).every(x => x.subject === graphScope(doc())));
});
test('host ignoring knowledgeGraphJSON on id 0 falls back to enriching the assigned id without re-calling the model', async t => {
  const f = fixture(t); f.dropCreateGraph = true; await f.init();
  const saved = await writeMemory(f.client, f.store, doc().id);
  assert.equal(f.memories.length, 1); assert.equal(f.prompts.length, 1);
  assert.equal(f.writes.length, 2); assert.equal(f.writes[0].id, 0); assert.equal(f.writes[1].id, saved.memoryId);
  assert.equal(saved.graphStatus, 'ready');
});
test('legacy migration preserves archive data and repairs only its known native id', async t => {
  const f = fixture(t), d = await f.legacy();
  f.memories.push({ id: 3, character_id: role.id, timestamp: now, rawText: '其他记忆', summary: '不能改动', knowledgeGraphJSON: null });
  const migrated = await f.store.getDoc(d.id); assert.equal(migrated.graphStatus, 'missing'); assert.equal(migrated.body, d.body);
  const result = await enrichMemory(f.client, f.store, d.id);
  assert.equal(result.memoryId, 64); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].id, 64); assert.equal(f.memories.length, 2); assert.equal(f.memories[1].summary, '不能改动');
});
test('repeated repair and handoff do not create rows or call the model again', async t => {
  const f = fixture(t); await f.legacy(); await enrichMemory(f.client, f.store, doc().id); await enrichMemory(f.client, f.store, doc().id); await writeMemory(f.client, f.store, doc().id);
  assert.equal(f.prompts.length, 1); assert.equal(f.writes.length, 1); assert.equal(f.memories.length, 1);
});
test('lost update receipt is reconciled by native read without a second update or generation', async t => {
  const f = fixture(t); await f.legacy(); f.updateMode = 'lost';
  const uncertain = await enrichMemory(f.client, f.store, doc().id);
  assert.equal(uncertain.graphStatus, 'uncertain'); assert.equal(uncertain.syncStatus, 'written'); assert.ok(uncertain.graphDraftJSON);
  const recovered = await enrichMemory(f.client, f.store, doc().id);
  assert.equal(recovered.graphStatus, 'ready'); assert.equal(f.writes.length, 1); assert.equal(f.prompts.length, 1);
});
test('a rejected update reuses the durable graph draft when manually retried', async t => {
  const f = fixture(t); await f.legacy(); f.updateMode = 'reject'; await enrichMemory(f.client, f.store, doc().id); f.updateMode = 'ok';
  const result = await enrichMemory(f.client, f.store, doc().id);
  assert.equal(result.graphStatus, 'ready'); assert.equal(f.prompts.length, 1); assert.equal(f.writes.length, 2); assert.ok(f.writes.every(x => x.id === 64));
});
test('invalid model graph leaves confirmed text intact and can be retried', async t => {
  const f = fixture(t); await f.init(); f.response = '{"scene":"wrong format"}';
  const result = await writeMemory(f.client, f.store, doc().id);
  assert.equal(result.syncStatus, 'written'); assert.equal(result.graphStatus, 'error'); assert.equal(f.memories.length, 1); assert.equal(f.memories[0].knowledgeGraphJSON, null);
  f.response = null; assert.equal((await enrichMemory(f.client, f.store, doc().id)).graphStatus, 'ready'); assert.equal(f.memories.length, 1);
});
test('readback mismatch is not reported as a completed native graph', async t => {
  const f = fixture(t); await f.legacy(); f.updateMode = 'stale-read'; const result = await enrichMemory(f.client, f.store, doc().id);
  assert.equal(result.graphStatus, 'uncertain'); assert.match(result.graphError, /回读/); assert.equal(result.retrievalStatus, 'unverified');
});
test('wrong update receipt id cannot mark graph processing complete', async t => {
  const f = fixture(t); await f.legacy(); f.updateMode = 'wrong-receipt';
  assert.equal((await enrichMemory(f.client, f.store, doc().id)).graphStatus, 'uncertain');
});
test('a deleted or moved native row is never replaced with a newly created memory', async t => {
  const f = fixture(t); await f.legacy(); f.memories.length = 0;
  const result = await enrichMemory(f.client, f.store, doc().id); assert.equal(result.graphStatus, 'error'); assert.match(result.graphError, /找不到/); assert.equal(f.writes.length, 0);
});
test('a known native id with mismatched ownership is not overwritten', async t => {
  const f = fixture(t); await f.legacy(); f.memories[0].rawText = '其他记录';
  await enrichMemory(f.client, f.store, doc().id); assert.equal(f.writes.length, 0); assert.equal(f.prompts.length, 0);
});
test('duplicate untracked source markers stop reconciliation instead of choosing a row', async t => {
  const f = fixture(t); await f.init(); f.memories.push({ ...memoryPayload(doc()), id: 1 }, { ...memoryPayload(doc()), id: 2 });
  await assert.rejects(writeMemory(f.client, f.store, doc().id), /多个/); assert.equal(f.writes.length, 0);
});
test('native edits made before repair are used as the source and preserved byte for byte', async t => {
  const f = fixture(t); await f.legacy(); f.memories[0].summary = '用户已编辑的梦境摘要'; f.memories[0].rawText += '\n用户修订：窗灯是蓝色的。';
  const before = structuredClone(f.memories[0]); await enrichMemory(f.client, f.store, doc().id);
  assert.equal(JSON.parse(f.prompts[0].messages[1].content).rawText, before.rawText);
  assert.equal(f.memories[0].rawText, before.rawText); assert.equal(f.memories[0].summary, before.summary);
});
test('native text edits during inference prevent update and preserve the user edit', async t => {
  const f = fixture(t); await f.legacy(); f.afterModel = () => { f.memories[0].summary = '生成期间由用户修改'; };
  const result = await enrichMemory(f.client, f.store, doc().id); assert.equal(result.graphStatus, 'error'); assert.match(result.graphError, /已变化/); assert.equal(f.writes.length, 0); assert.equal(f.memories[0].summary, '生成期间由用户修改');
});
test('existing native graph is accepted without model generation or overwrite', async t => {
  const f = fixture(t); await f.legacy(); f.memories[0].knowledgeGraphJSON = '[{"subject":"梦境","relationship":"梦中地点","object":"咖啡馆"}]';
  const result = await enrichMemory(f.client, f.store, doc().id); assert.equal(result.graphStatus, 'ready'); assert.equal(f.prompts.length, 0); assert.equal(f.writes.length, 0);
});
test('unrecognized nonempty native graph is preserved for manual inspection', async t => {
  const f = fixture(t); await f.legacy(); f.memories[0].knowledgeGraphJSON = '{"raw":"上次模型未完成的输出"}';
  const result = await enrichMemory(f.client, f.store, doc().id); assert.equal(result.graphStatus, 'error'); assert.match(result.graphError, /未覆盖/); assert.equal(f.writes.length, 0);
});
test('cancelling during graph inference retains text and never sends a graph update', async t => {
  const f = fixture(t); await f.legacy(); const controller = new AbortController(); f.afterModel = () => controller.abort();
  const result = await enrichMemory(f.client, f.store, doc().id, { signal: controller.signal }); assert.equal(result.graphStatus, 'error'); assert.equal(result.syncStatus, 'written'); assert.equal(f.writes.length, 0);
});
test('reconciliation-only reports missing graph without inference or mutation', async t => {
  const f = fixture(t); const d = { ...doc(), syncStatus: 'uncertain' }; await f.init(d, { ...memoryPayload(d), id: 22 });
  const result = await writeMemory(f.client, f.store, d.id, { reconcileOnly: true }); assert.equal(result.memoryId, 22); assert.equal(result.graphStatus, 'missing'); assert.equal(f.writes.length, 0); assert.equal(f.prompts.length, 0);
});
test('recall is recorded only as a user report and passing requires the clean-session confirmation', async t => {
  const f = fixture(t); await f.legacy(); await enrichMemory(f.client, f.store, doc().id);
  await assert.rejects(recordRetrievalCheck(f.store, doc().id, { result: 'passed' }), /未贴原文/);
  const result = await recordRetrievalCheck(f.store, doc().id, { result: 'failed', note: '只在提供原文后答对' });
  assert.equal(result.retrievalStatus, 'failed'); assert.equal(result.retrievalCheck.source, 'user-report'); assert.equal(result.retrievalChecks.length, 1);
  await recordRetrievalCheck(f.store, doc().id, { result: 'passed', cleanSession: true });
  assert.equal((await enrichMemory(f.client, f.store, doc().id)).retrievalStatus, 'passed');
  f.memories[0].summary = '修改后的摘要';
  assert.equal((await enrichMemory(f.client, f.store, doc().id)).retrievalStatus, 'unverified');
});
test('unwritten archives cannot receive a recall acceptance report', async t => {
  const f = fixture(t); await f.init(); await assert.rejects(recordRetrievalCheck(f.store, doc().id, { result: 'failed' }), /尚未确认/);
});
test('graph extraction rejects invented facts, wrong scope and reality relations', () => {
  const d = doc(), c = graphContext(d, memoryPayload(d), '瑠璃子');
  for (const bad of [[], [{ subject: c.recordNode, relationship: '梦中地点', object: '旧院子' }], [{ subject: '瑠璃子', relationship: '梦中地点', object: '咖啡馆' }], [{ subject: c.recordNode, relationship: '现实居住地', object: '咖啡馆' }]]) assert.throws(() => buildGraph(JSON.stringify(bad), c, d));
  const graph = buildGraph('```json\n' + JSON.stringify([{ source: c.recordNode, label: '梦中声音', target: '铃铛响' }]) + '\n```', c, d);
  assert.ok(readTriples(graph).some(x => x.object === '铃铛响'));
});
test('creative work graph keeps fictional details under a work node', () => {
  const d = { ...doc(), kind: 'work' }, c = graphContext(d, memoryPayload(d), '瑠璃子');
  const graph = readTriples(buildGraph(JSON.stringify([{ subject: c.recordNode, relationship: '作品中地点', object: '咖啡馆' }]), c, d));
  assert.ok(graph.some(x => x.object === '创作作品，不是现实事件')); assert.ok(graph.some(x => x.relationship === '作品中地点'));
  assert.equal(graph.filter(x => x.subject === '瑠璃子').length, 1);
});
test('diary graph normalizes 08:44 vs 8:44 time spans and projects 1-hop dated facts onto character node', () => {
  const d = { id: documentId(role.id, 'diary', '2026-11-01'), characterId: role.id, sessionId: 'original-session', kind: 'diary', day: '2026-11-01', title: '清晨记录', body: '今天8:44起床，在窗边书桌整理了读书笔记。', summary: '8:44起床，在窗边书桌整理了读书笔记。', createdAt: now, syncStatus: 'pending' };
  const c = graphContext(d, memoryPayload(d), '瑠璃子');
  const extracted = JSON.stringify([
    { subject: c.recordNode, relationship: '记录中作息', object: '08:44 起床' },
    { subject: c.recordNode, relationship: '记录中地点', object: '窗边书桌' },
    { subject: c.recordNode, relationship: '记录中动作', object: '整理了读书笔记' }
  ]);
  const graph = readTriples(buildGraph(extracted, c, d));
  assert.ok(graph.some(x => x.subject === '瑠璃子' && x.relationship === '2026-11-01作息' && x.object === '8:44起床'));
  assert.ok(graph.some(x => x.subject === '瑠璃子' && x.relationship === '2026-11-01地点' && x.object === '窗边书桌'));
  assert.ok(graph.some(x => x.subject === '瑠璃子' && x.relationship === '2026-11-01动作' && x.object === '整理了读书笔记'));
});
