import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import {
  createProfile,
  documentId,
  epoch,
  extractWakeMention,
  extractWakeMentions,
  hasUnconfirmedWakeTime,
  memoryPayload,
  wakeMinuteInterval
} from '../src/core.js';
import {
  buildGraph,
  graphContext,
  readTriples
} from '../src/memory-graph.js';
import {
  enrichMemory,
  writeMemory
} from '../src/memory.js';

const now = epoch('2026-11-01', 524); // 08:44 in Asia/Shanghai
const role = { id: 'custom-6', data: { data: { name: '瑠璃子' } } };

function createTestFixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const memories = [];
  const writes = [];
  const prompts = [];
  const f = { memories, writes, prompts, response: null };
  const client = {
    db: {
      executeSql: async (q, args = []) => {
        const s = db.prepare(q);
        if (/^SELECT/.test(q)) return { rows: s.all(...args) };
        const r = s.run(...args);
        return { rows: [], rowsAffected: Number(r.changes), insertId: Number(r.lastInsertRowid) };
      }
    },
    memories: {
      list: async (id, offset, limit, options) => {
        return memories
          .filter(m => m.character_id === id && m.timestamp >= options.minTimestamp && m.timestamp <= options.maxTimestamp)
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(offset, offset + limit)
          .map(m => structuredClone(m));
      },
      createOrUpdate: async rows => {
        const output = [];
        for (const m of rows) {
          writes.push(structuredClone(m));
          if (m.id <= 0) {
            const added = { ...m, id: 100 + memories.length };
            memories.push(added);
            output.push(structuredClone(added));
            continue;
          }
          const i = memories.findIndex(x => x.id === m.id);
          assert.ok(i >= 0, 'updates must target an existing id');
          memories[i] = { ...m };
          output.push(structuredClone(m));
        }
        return output;
      }
    },
    chat: {
      completions: {
        create: async request => {
          prompts.push(request);
          const c = JSON.parse(request.messages[1].content);
          const response = f.response ?? JSON.stringify([
            { subject: c.recordNode, relationship: '记录中作息', object: '十点多起床' },
            { subject: c.recordNode, relationship: '记录中动作', object: '整理书桌' }
          ]);
          return { choices: [{ message: { content: response } }] };
        }
      }
    }
  };
  return Object.assign(f, {
    client,
    store: createStore(client),
    async init(d, native = null, profileInit = null) {
      await this.store.init();
      const p = profileInit || createProfile(role, now);
      await this.store.putProfile(p);
      if (d) await this.store.putDoc(d);
      if (native) memories.push(structuredClone(native));
    }
  });
}

test('P1 Regression 1: Confirmed 08:44 with conflicting fuzzy time "十点多起床" is strictly intercepted and excluded from 1-hop direct', async t => {
  const f = createTestFixture(t);
  const p = createProfile(role, now);
  p.wakeRecords['2026-11-01'] = { at: epoch('2026-11-01', 524, 'Asia/Shanghai'), timezone: 'Asia/Shanghai' };

  const diaryDoc = {
    id: documentId(role.id, 'diary', '2026-11-01'),
    characterId: role.id,
    sessionId: 'original-session',
    kind: 'diary',
    day: '2026-11-01',
    title: '早晨',
    body: '今天十点多起床，随后整理书桌。',
    summary: '十点多起床，整理书桌。',
    createdAt: now,
    syncStatus: 'pending',
    timelineFacts: { wakeTime: '08:44', wakeSource: 'manual' }
  };
  await f.init(diaryDoc, null, p);

  // 1. Conflict detection verification
  assert.equal(hasUnconfirmedWakeTime(diaryDoc.body, '08:44'), true);
  assert.equal(hasUnconfirmedWakeTime(diaryDoc.summary, '08:44'), true);

  // 2. Strict memoryPayload interception
  assert.throws(
    () => memoryPayload(diaryDoc, { strict: true }),
    /文稿包含未确认或冲突的起床时间，已严格拦截原生记忆生成/
  );

  // 3. Non-strict payload does NOT produce contradictory wake tag
  const nonStrictPayload = memoryPayload(diaryDoc, { strict: false });
  assert.doesNotMatch(nonStrictPayload.summary, /已确认.*08:44.*起床/);
  assert.equal(nonStrictPayload.summary.includes('（已确认 08:44 起床）'), false);

  // 4. writeMemory strict write interception
  await assert.rejects(
    writeMemory(f.client, f.store, diaryDoc.id),
    /文稿包含未确认或冲突的起床时间，已严格拦截写入原生记忆/
  );
  assert.equal(f.writes.length, 0, 'No native write should have occurred');

  // 5. Knowledge graph build verification
  const gCtx = graphContext(diaryDoc, { rawText: diaryDoc.body, summary: diaryDoc.summary }, role.data.data.name);

  // 5a. Strict graph build throws
  assert.throws(
    () => buildGraph(JSON.stringify([
      { subject: gCtx.recordNode, relationship: '记录中作息', object: '十点多起床' },
      { subject: gCtx.recordNode, relationship: '记录中动作', object: '整理书桌' }
    ]), gCtx, diaryDoc, { strict: true }),
    /图谱包含未确认或冲突的起床时间，未写入原生记忆/
  );

  // 5b. Default graph build strips conflicting details and completely bans 1-hop direct
  const graphJson = buildGraph(JSON.stringify([
    { subject: gCtx.recordNode, relationship: '记录中作息', object: '十点多起床' },
    { subject: gCtx.recordNode, relationship: '记录中动作', object: '整理书桌' }
  ]), gCtx, diaryDoc, { strict: false });
  const triples = readTriples(graphJson);

  // 2-hop details must NOT contain "十点多起床"
  assert.equal(triples.some(tr => tr.subject === gCtx.recordNode && tr.object.includes('十点多')), false);
  // 1-hop direct attributes must NOT contain "十点多起床"
  const directTriples = triples.filter(tr => tr.subject === role.data.data.name);
  assert.equal(directTriples.some(tr => tr.object.includes('十点多')), false);
  // Valid non-conflicting action is preserved
  assert.ok(triples.some(tr => tr.subject === gCtx.recordNode && tr.relationship === '记录中动作' && tr.object === '整理书桌'));
  assert.ok(directTriples.some(tr => tr.relationship === '2026-11-01动作' && tr.object === '整理书桌'));
});

test('P1 Regression 2: Confirmed 08:44 with compatible fuzzy time "八点多起床" is kept in details but strictly excluded from 1-hop direct', async t => {
  const f = createTestFixture(t);
  const p = createProfile(role, now);
  p.wakeRecords['2026-11-01'] = { at: epoch('2026-11-01', 524, 'Asia/Shanghai'), timezone: 'Asia/Shanghai' };

  const diaryDoc = {
    id: documentId(role.id, 'diary', '2026-11-01'),
    characterId: role.id,
    sessionId: 'original-session',
    kind: 'diary',
    day: '2026-11-01',
    title: '晨光',
    body: '今天八点多起床，随后在阳台给花浇水。',
    summary: '八点多起床，给花浇水。',
    createdAt: now,
    syncStatus: 'pending',
    timelineFacts: { wakeTime: '08:44', wakeSource: 'manual' }
  };
  await f.init(diaryDoc, null, p);

  // 1. Compatible fuzzy wake time does not conflict with 08:44 (524 falls in [480, 539])
  assert.equal(hasUnconfirmedWakeTime(diaryDoc.body, '08:44'), false);
  assert.equal(hasUnconfirmedWakeTime(diaryDoc.summary, '08:44'), false);

  // 2. Strict memoryPayload succeeds
  const strictPayload = memoryPayload(diaryDoc, { strict: true });
  assert.ok(strictPayload);
  // Since summary lacks exact '08:44', wakeTag is added
  assert.match(strictPayload.summary, /（已确认 08:44 起床）/);

  // 3. Knowledge graph: compatible fuzzy phrase is kept in 2-hop details, but BANNED from 1-hop direct
  const gCtx = graphContext(diaryDoc, { rawText: diaryDoc.body, summary: diaryDoc.summary }, role.data.data.name);
  const graphJson = buildGraph(JSON.stringify([
    { subject: gCtx.recordNode, relationship: '记录中作息', object: '八点多起床' },
    { subject: gCtx.recordNode, relationship: '记录中动作', object: '给花浇水' }
  ]), gCtx, diaryDoc);
  const triples = readTriples(graphJson);

  // 2-hop details retains "八点多起床" as recorded in the document
  assert.ok(triples.some(tr => tr.subject === gCtx.recordNode && tr.relationship === '记录中作息' && tr.object === '八点多起床'));
  // 1-hop direct represents character facts: "八点多起床" MUST NOT be projected to character node!
  const directTriples = triples.filter(tr => tr.subject === role.data.data.name);
  assert.equal(directTriples.some(tr => tr.object.includes('八点多起床')), false, 'Fuzzy wake time must NEVER project to 1-hop character direct attributes');
  // Non-wake actions project normally
  assert.ok(directTriples.some(tr => tr.relationship === '2026-11-01动作' && tr.object === '给花浇水'));
});

test('P1 Regression 3: Unconfirmed wake time with fuzzy mention synchronizes uncertainty tag in summary, provenance disclaimer, and bans 1-hop direct', async t => {
  const f = createTestFixture(t);
  const diaryDoc = {
    id: documentId(role.id, 'diary', '2026-11-01'),
    characterId: role.id,
    sessionId: 'original-session',
    kind: 'diary',
    day: '2026-11-01',
    title: '早晨漫记',
    body: '十点多起床，随后看了一会儿书。',
    summary: '十点多起床，看书。',
    createdAt: now,
    syncStatus: 'pending',
    timelineFacts: { wakeTime: '', wakeSource: 'schedule' }
  };
  await f.init(diaryDoc);

  // 1. Without confirmed wake record, fuzzy mention does not throw hard error by default
  assert.equal(hasUnconfirmedWakeTime(diaryDoc.body, ''), false);
  // But if firstAwakeTime is 08:44, waking at 10:something contradicts earlier awake scene
  assert.equal(hasUnconfirmedWakeTime(diaryDoc.body, '', { firstAwakeTime: '08:44' }), true);

  // 2. memoryPayload consistency: summary has (起床时间未确认), provenance has disclaimer
  const payload = memoryPayload(diaryDoc);
  assert.match(payload.summary, /（起床时间未确认）/);
  assert.doesNotMatch(payload.summary, /已确认/);
  assert.match(payload.rawText, /实际起床时间未确认，文中时间表述仅为模糊回顾。/);

  // 3. Knowledge graph: unconfirmed fuzzy mention remains in 2-hop details, STRICTLY excluded from 1-hop direct
  const gCtx = graphContext(diaryDoc, { rawText: diaryDoc.body, summary: diaryDoc.summary }, role.data.data.name);
  const graphJson = buildGraph(JSON.stringify([
    { subject: gCtx.recordNode, relationship: '记录中作息', object: '十点多起床' },
    { subject: gCtx.recordNode, relationship: '记录中动作', object: '看书' }
  ]), gCtx, diaryDoc);
  const triples = readTriples(graphJson);

  // 2-hop details retains phrase
  assert.ok(triples.some(tr => tr.subject === gCtx.recordNode && tr.object === '十点多起床'));
  // 1-hop direct completely bans unconfirmed wake phrase
  const directTriples = triples.filter(tr => tr.subject === role.data.data.name);
  assert.equal(directTriples.some(tr => tr.object.includes('起床')), false);
  assert.ok(directTriples.some(tr => tr.object === '看书'));
});

test('P1 Regression 4: Prefix fuzzy words (大概/大约/约) correctly extracted with exact: false, intervals, and plan comparisons skipped', () => {
  // 1. Prefix fuzzy words
  const m1 = extractWakeMention('大概十点起床');
  assert.equal(m1.phrase, '大概十点起床');
  assert.equal(m1.time, '10:00');
  assert.equal(m1.exact, false);
  assert.equal(m1.minMinute, 580);
  assert.equal(m1.maxMinute, 620);
  assert.deepEqual(wakeMinuteInterval(m1), [580, 620]);

  const m2 = extractWakeMention('大约8:30醒来');
  assert.equal(m2.phrase, '大约8:30醒来');
  assert.equal(m2.time, '08:30');
  assert.equal(m2.exact, false);
  assert.equal(m2.minMinute, 490);
  assert.equal(m2.maxMinute, 530);

  const m3 = extractWakeMention('约八点起床');
  assert.equal(m3.phrase, '约八点起床');
  assert.equal(m3.time, '08:00');
  assert.equal(m3.exact, false);
  assert.equal(m3.minMinute, 460);
  assert.equal(m3.maxMinute, 500);

  const m4 = extractWakeMention('早上大概十点起床');
  assert.equal(m4.phrase, '早上大概十点起床');
  assert.equal(m4.time, '10:00');
  assert.equal(m4.exact, false);

  // 2. Minute + 多 intervals
  const m5 = extractWakeMention('8点半多起床');
  assert.equal(m5.phrase, '8点半多起床');
  assert.equal(m5.time, '08:30');
  assert.equal(m5.exact, false);
  assert.equal(m5.minMinute, 510);
  assert.equal(m5.maxMinute, 539);

  const m6 = extractWakeMention('8点20分多醒来');
  assert.equal(m6.phrase, '8点20分多醒来');
  assert.equal(m6.time, '08:20');
  assert.equal(m6.exact, false);
  assert.equal(m6.minMinute, 500);
  assert.equal(m6.maxMinute, 529);

  // 3. Plan comparison exclusion: only actual wake extracted
  const planComparison = extractWakeMention('平时计划大约8:00起床，今天8:44醒来');
  assert.deepEqual(planComparison, { phrase: '8:44醒来', time: '08:44' });

  // 4. Exact mention has NO extra properties (strict backward compatibility)
  const exact = extractWakeMention('早上8:44起床');
  assert.deepEqual(exact, { phrase: '早上8:44起床', time: '08:44' });
  assert.equal(exact.exact, undefined);
  assert.deepEqual(wakeMinuteInterval(exact), [524, 524]);
});

test('P2 Regression 5: Clearing or modifying confirmed wake record allows read-only reconcile to recover written status without wake validation error', async t => {
  const f = createTestFixture(t);
  const diaryDoc = {
    id: documentId(role.id, 'diary', '2026-11-01'),
    characterId: role.id,
    sessionId: 'original-session',
    kind: 'diary',
    day: '2026-11-01',
    title: '早晨日记',
    body: '今天08:44起床，随后在书桌前整理了笔记。',
    summary: '08:44起床，整理了笔记。',
    createdAt: now,
    syncStatus: 'uncertain',
    timelineFacts: { wakeTime: '08:44', wakeSource: 'manual' }
  };
  // Native memory row exists in host storage (id 105)
  const native = { ...memoryPayload(diaryDoc), id: 105, timestamp: now };
  await f.init(diaryDoc, native);

  // Clear confirmed wake record in profile (simulates user removing manual wake time)
  const p = await f.store.getProfile(role.id);
  delete p.wakeRecords['2026-11-01'];
  await f.store.putProfile(p);

  // Read-only reconcile must succeed without throwing wake assertion error!
  const recovered = await writeMemory(f.client, f.store, diaryDoc.id, { reconcileOnly: true });
  assert.equal(recovered.syncStatus, 'written');
  assert.equal(recovered.memoryId, 105);
  assert.equal(f.writes.length, 0, 'No native write or update should be sent during reconcile');

  // Verify stored document state
  const stored = await f.store.getDoc(diaryDoc.id);
  assert.equal(stored.syncStatus, 'written');
  assert.equal(stored.memoryId, 105);

  // Test modifying wake record to conflicting time (e.g. 10:00) also allows read-only reconcile
  p.wakeRecords['2026-11-01'] = { at: epoch('2026-11-01', 600, 'Asia/Shanghai'), timezone: 'Asia/Shanghai' };
  await f.store.putProfile(p);
  stored.syncStatus = 'uncertain';
  await f.store.putDoc(stored);

  const reReconciled = await writeMemory(f.client, f.store, diaryDoc.id, { reconcileOnly: true });
  assert.equal(reReconciled.syncStatus, 'written');
  assert.equal(reReconciled.memoryId, 105);
  assert.equal(f.writes.length, 0);
});

test('P2 Regression 6: Stale document with cleared wake record returns on reconcileOnly without throwing', async t => {
  const f = createTestFixture(t);
  const diaryDoc = {
    id: documentId(role.id, 'diary', '2026-11-01'),
    characterId: role.id,
    sessionId: 'original-session',
    kind: 'diary',
    day: '2026-11-01',
    title: '重新整理',
    body: '今天08:44起床，重写日记。',
    summary: '08:44起床，重写日记。',
    createdAt: now,
    syncStatus: 'stale',
    memoryId: 50
  };
  const native = { ...memoryPayload(diaryDoc), id: 50, timestamp: now };
  await f.init(diaryDoc, native);

  // Clear wake record in profile
  const p = await f.store.getProfile(role.id);
  delete p.wakeRecords['2026-11-01'];
  await f.store.putProfile(p);

  // Read-only reconcile returns d without error
  const reconciled = await writeMemory(f.client, f.store, diaryDoc.id, { reconcileOnly: true });
  assert.equal(reconciled.syncStatus, 'stale');
  assert.equal(f.writes.length, 0);

  // But active in-place update without reconcileOnly MUST still strictly intercept
  await assert.rejects(
    writeMemory(f.client, f.store, diaryDoc.id),
    /文稿包含未确认或冲突的起床时间，已严格拦截写入原生记忆/
  );
  assert.equal(f.writes.length, 0);
});

test('P2 Regression 7: Uncertain write with truly missing native memory throws receipt-not-found error instead of wake assertion error', async t => {
  const f = createTestFixture(t);
  const diaryDoc = {
    id: documentId(role.id, 'diary', '2026-11-01'),
    characterId: role.id,
    sessionId: 'original-session',
    kind: 'diary',
    day: '2026-11-01',
    title: '早起记录',
    body: '今天08:44起床，跑步半小时。',
    summary: '08:44起床，跑步半小时。',
    createdAt: now,
    syncStatus: 'uncertain',
    timelineFacts: { wakeTime: '08:44', wakeSource: 'manual' }
  };
  // No native memory row initialized (memories is empty)
  await f.init(diaryDoc);

  // Clear wake record in profile
  const p = await f.store.getProfile(role.id);
  delete p.wakeRecords['2026-11-01'];
  await f.store.putProfile(p);

  // Must throw receipt-not-found error, NOT wake validation error!
  await assert.rejects(
    writeMemory(f.client, f.store, diaryDoc.id, { reconcileOnly: true }),
    /暂未找到写入回执，已保留待核对状态；请检查原生记忆，避免重复新增/
  );
  assert.equal(f.writes.length, 0);
});

test('P2 Regression 8: enrichLocked adopts existing native graph even if wake records were cleared', async t => {
  const f = createTestFixture(t);
  const diaryDoc = {
    id: documentId(role.id, 'diary', '2026-11-01'),
    characterId: role.id,
    sessionId: 'original-session',
    kind: 'diary',
    day: '2026-11-01',
    title: '日记图谱核对',
    body: '今天08:44起床，阅读书籍。',
    summary: '08:44起床，阅读书籍。',
    createdAt: now,
    syncStatus: 'written',
    memoryId: 64,
    timelineFacts: { wakeTime: '08:44', wakeSource: 'manual' }
  };
  const existingGraph = JSON.stringify([{ subject: '瑠璃子', relationship: '2026-11-01作息', object: '8:44起床' }]);
  const native = { ...memoryPayload(diaryDoc), id: 64, timestamp: now, knowledgeGraphJSON: existingGraph };
  await f.init(diaryDoc, native);

  // Clear wake records in profile
  const p = await f.store.getProfile(role.id);
  delete p.wakeRecords['2026-11-01'];
  await f.store.putProfile(p);

  // enrichMemory should adopt the existing graph without failing on wake validation
  const result = await enrichMemory(f.client, f.store, diaryDoc.id);
  assert.equal(result.graphStatus, 'ready');
  assert.equal(f.prompts.length, 0);
  assert.equal(f.writes.length, 0);
});
