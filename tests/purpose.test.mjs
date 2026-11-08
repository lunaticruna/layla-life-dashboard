import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';
import { createStore } from '../src/store.js';
import { createProfile, epoch } from '../src/core.js';
import { createPurposeStore, PURPOSE_SQL } from '../src/purpose-store.js';
import { MINUTE, HOUR, acceptPurposeGoals, createPurposeRecord, inPurposeQuiet, purposeOpportunity, sourceKey } from '../src/purpose-engine.js';
import { addPurposeGoal, cancelPurposeDelivery, configurePurpose, purposeFeedback, runPurpose, runPurposeBackground } from '../src/purpose-runner.js';
import { runTasks } from '../src/task-runner.js';

const START = epoch('2026-11-08', 14 * 60);
async function fixture(mode = 'observe') {
  const db = new DatabaseSync(':memory:');
  const f = { db, time: START, calls: [], queue: [], writes: [], cancels: [], failure: '', draft: '', onExpression: null,
    role: { id: 'role-a', data: { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '澪', description: '喜欢读书', personality: '安静', scenario: '' } } },
    history: [{ id: 1, session_id: 's', character_id: 'user', role: 'user', timestamp: START - 2 * HOUR, content: '我想把那首歌的旋律写完，之后想聊聊和声。' },
      { id: 2, session_id: 's', character_id: 'role-a', role: 'assistant', timestamp: START - 2 * HOUR + 1000, content: '我想和你分享读书笔记里的那句话。' }] };
  f.opts = { clock: () => f.time };
  f.client = {
    db: { executeSql: async (q, args = []) => {
      const s = db.prepare(q); if (/^SELECT/.test(q)) return { rows: s.all(...args), rowsAffected: 0 };
      const r = s.run(...args); return { rows: [], rowsAffected: Number(r.changes), insertId: Number(r.lastInsertRowid) };
    } },
    characters: { list: async () => [f.role] },
    chat: {
      getChatSessions: async () => ({ sessions: ['s', 'other'].map(id => ({ session_id: id, last_message_timestamp: Math.max(0, ...f.history.filter(m => m.session_id === id).map(m => m.timestamp)), last_message_content: '会话' })) }),
      getChatHistory: async id => structuredClone(f.history.filter(m => m.session_id === id)),
      getScheduledChatMessages: async () => { if (f.failure === 'list') throw new Error('列表不可读'); return structuredClone(f.queue); },
      scheduleChatMessage: async request => {
        f.writes.push(structuredClone(request));
        // Inspect the real SQLite journal before the fake host accepts anything.
        const journal = await createPurposeStore(f.store).get(f.role.id);
        assert.equal(journal.deliveries.at(-1).status, 'reserving');
        if (f.failure === 'before') throw new Error('请求未到达');
        const entry = { ...structuredClone(request), id: 100 + f.writes.length }; f.queue.push(entry);
        if (f.failure === 'receipt') throw new Error('回执丢失');
        if (f.failure === 'wrong') return { ...entry, message: '错误回执' };
        return structuredClone(entry);
      },
      cancelScheduledChatMessage: async id => {
        f.cancels.push(id); const index = f.queue.findIndex(e => e.id === id);
        if (index < 0) return { id, success: false };
        f.queue.splice(index, 1); if (f.failure === 'cancel') throw new Error('撤销回执丢失'); return { id, success: true };
      },
      completions: { create: async request => {
        f.calls.push(request); const c = JSON.parse(request.messages[1].content);
        let result;
        if (request.messages[0].content.includes('TASK:PURPOSE_GOALS')) {
          const m = c.conversation.find(x => x.role === 'assistant');
          result = { goals: m ? [{ owner: 'character', kind: 'share', summary: '分享读书笔记的那句话', sourceIds: [m.id], evidence: '读书笔记里的那句话', confidence: .9, waitMinutes: 0 }] : [] };
        } else if (request.messages[0].content.includes('TASK:PURPOSE_EXPRESSION')) {
          if (f.onExpression) await f.onExpression();
          result = { goalId: c.purpose.id, sourceIds: c.purpose.sourceIds, timeless: true, text: f.draft || '你愿意听我说说那份读书笔记吗？有些想法想和你一起慢慢捋一捋。' };
        } else throw new Error('这个测试不应生成生活文稿');
        return { choices: [{ message: { content: JSON.stringify(result) } }] };
      } }
    }
  };
  f.store = createStore(f.client); f.ps = createPurposeStore(f.store);
  await f.store.init(); await f.store.putProfile(createProfile(f.role, START - 3 * HOUR));
  await configurePurpose(f.client, f.store, f.role.id, { mode, sessionId: 's', dreamOutreachDisabled: true }, { now: START - 31 * MINUTE });
  f.run = opts => runPurpose(f.client, f.store, f.role, { ...f.opts, ...opts });
  f.record = () => f.ps.get(f.role.id);
  f.manual = text => addPurposeGoal(f.store, f.role.id, text || '想聊聊那份读书笔记', 'character', f.opts);
  return f;
}

test('purpose: two stages preserve exact source attribution; observation has no native side effects', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  assert.equal((await f.run()).status, 'observed'); const r = await f.record();
  assert.equal(f.calls.length, 2); assert.equal(f.writes.length, 0); assert.equal(f.cancels.length, 0);
  assert.equal(r.goals[0].owner, 'character'); assert.deepEqual(r.goals[0].sourceIds, [sourceKey(f.history[1])]);
  assert.equal(r.deliveries[0].status, 'observed'); assert.equal(r.deliveries[0].request, undefined);
  assert.equal((await f.run()).status, 'cooldown'); assert.equal(f.calls.length, 2);
});
test('purpose: unknown evidence, incorrect owner, missing quote and stale sources cannot create goals', () => {
  const r = createPurposeRecord('a', START); r.config.sessionId = 's';
  const message = { id: 1, session_id: 's', role: 'user', content: '我想学会写和声。', timestamp: START - HOUR };
  const native = { messages: [message] }, id = sourceKey(message);
  const valid = { owner: 'user', kind: 'follow_up', summary: '询问和声学习的想法', evidence: '想学会写和声', sourceIds: [id], confidence: .9 };
  for (const bad of [{ sourceIds: ['invented'] }, { owner: 'character', kind: 'share' }, { evidence: '不在原文中的话' }, { confidence: .3 }]) {
    assert.equal(acceptPurposeGoals({ goals: [{ ...valid, ...bad }] }, native, r, START).length, 0);
  }
  assert.equal(acceptPurposeGoals({ goals: [valid] }, native, r, START).length, 1);
  message.timestamp = START + HOUR;
  assert.equal(acceptPurposeGoals({ goals: [valid] }, native, r, START).length, 0);
});
test('purpose: scheduling reserves a journal entry before mutation and never equates queue receipt with delivery', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual();
  assert.equal((await f.run()).status, 'queued'); const r = await f.record();
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].timestamp, START + MINUTE);
  assert.equal(f.writes[0].session_id, 's'); assert.equal(r.deliveries[0].status, 'queued');
  assert.equal(r.deliveries[0].deliveredAt, undefined);
  assert.equal((await f.run()).status, 'pending_delivery'); assert.equal(f.writes.length, 1);
});
test('purpose: lost schedule receipt is recovered by exact queue matching without a second send', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual(); f.failure = 'receipt';
  assert.equal((await f.run()).status, 'uncertain'); assert.equal(f.writes.length, 1);
  f.failure = ''; assert.equal((await f.run()).status, 'pending_delivery');
  assert.equal((await f.record()).deliveries[0].hostId, 101); assert.equal(f.writes.length, 1);
});
test('purpose: absent queue is uncertain, not delivered; failed requests are not retried automatically', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual(); f.failure = 'before';
  await f.run(); f.failure = ''; f.time += 4 * HOUR;
  await f.run(); const r = await f.record();
  assert.equal(r.deliveries[0].status, 'uncertain'); assert.equal(f.writes.length, 1);
  assert.equal(r.deliveries[0].deliveredAt, undefined);
});
test('purpose: only matching assistant history proves delivery; user reply is a separate signal', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual(); await f.run();
  const q = f.queue.pop(); f.time += 2 * MINUTE;
  f.history.push({ id: 20, role: 'assistant', content: q.message, character_id: f.role.id, session_id: q.session_id, timestamp: q.timestamp },
    { id: 21, role: 'user', content: '可以呀。', character_id: 'user', session_id: q.session_id, timestamp: q.timestamp + 1000 });
  await f.run({ reconcileOnly: true }); const d = (await f.record()).deliveries[0];
  assert.equal(d.status, 'delivered'); assert.equal(d.nativeMessageId, 20); assert.equal(d.replyMessageId, 21);
  assert.equal((await f.record()).goals[0].state, 'contacted');
});
test('purpose: user text in another session is not a delivery receipt', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual(); await f.run();
  const q = f.queue.pop(); f.time += 2 * MINUTE;
  f.history.push({ id: 30, role: 'user', content: q.message, character_id: 'user', session_id: 'other', timestamp: q.timestamp });
  await f.run({ reconcileOnly: true }); assert.equal((await f.record()).deliveries[0].status, 'uncertain');
});
test('purpose: local 04:30 is quiet regardless of execution host timezone', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual(); f.time = epoch('2026-11-09', 270);
  assert.equal(inPurposeQuiet(f.time, 'Asia/Shanghai', (await f.record()).config), true);
  assert.equal((await f.run()).status, 'quiet'); assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
});
test('purpose: crossing quiet hours while generating discards the expression', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); f.time = epoch('2026-11-08', 23 * 60 + 20); await f.manual();
  f.onExpression = () => { f.time = epoch('2026-11-08', 23 * 60 + 31); };
  assert.equal((await f.run()).status, 'quiet'); assert.equal(f.writes.length, 0);
});
test('purpose: native interaction during generation suppresses the pending outreach', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual();
  f.onExpression = () => { f.time += MINUTE; f.history.push({ ...f.history[0], id: 3, content: '我回来啦', timestamp: f.time }); };
  assert.equal((await f.run()).status, 'recent_chat'); assert.equal(f.writes.length, 0);
});
test('purpose: source edits during expression generation invalidate that hypothesis', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close());
  f.onExpression = () => { f.history[1].content = '不想分享这件事了。'; };
  assert.equal((await f.run()).status, 'stale_source'); assert.equal(f.writes.length, 0);
});
test('purpose: concrete greetings and relative time are rejected instead of scheduled', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual(); f.draft = '下午好，现在要不要聊聊笔记？';
  const r = await f.run(); assert.equal(r.status, 'error'); assert.match(r.error, /时段|相对时间/); assert.equal(f.writes.length, 0);
  assert.equal((await f.run()).status, 'model_cooldown'); assert.equal(f.calls.length, 1);
});
test('purpose: Dream/external queued messages block auto mode without being cancelled', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual();
  f.queue.push({ id: 9, character_id: f.role.id, session_id: 's', timestamp: START + HOUR, message: 'Dream 的消息' });
  assert.equal((await f.run()).status, 'external_schedule'); assert.equal(f.calls.length, 0); assert.equal(f.cancels.length, 0);
});
test('purpose: disabling auto cancels only the exact owned schedule, preserves Dream and life settings', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); const before = await f.store.getProfile(f.role.id);
  await f.manual(); await f.run(); f.queue.push({ id: 9, character_id: f.role.id, session_id: 's', timestamp: START + HOUR, message: 'Dream 的消息' });
  await configurePurpose(f.client, f.store, f.role.id, { ...(await f.record()).config, mode: 'off' }, f.opts);
  assert.deepEqual(f.cancels, [101]); assert.deepEqual(f.queue.map(x => x.id), [9]);
  assert.equal((await f.record()).deliveries[0].status, 'cancelled'); assert.deepEqual(await f.store.getProfile(f.role.id), before);
});
test('purpose: changed host fields prevent accidental cancellation even when the ID matches', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual(); await f.run();
  f.queue[0].message = '该 ID 已经变成其他消息';
  await cancelPurposeDelivery(f.client, f.store, f.role.id, (await f.record()).deliveries[0].id, f.opts);
  assert.equal(f.cancels.length, 0); assert.equal((await f.record()).deliveries[0].status, 'uncertain');
});
test('purpose: expired expressions are cancelled when the task next runs, never batch replayed', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual(); await f.run();
  f.time += 7 * MINUTE; await f.run();
  assert.deepEqual(f.cancels, [101]); assert.equal(f.writes.length, 1); assert.equal((await f.record()).goals[0].state, 'cancelled');
});
test('purpose: slow inference past purpose expiry does not schedule stale content', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close());
  await configurePurpose(f.client, f.store, f.role.id, { ...(await f.record()).config, ttlHours: 1 }, f.opts); await f.manual();
  f.onExpression = () => { f.time += 2 * HOUR; };
  assert.equal((await f.run()).status, 'no_goal'); assert.equal(f.writes.length, 0);
});
test('purpose: recent activity in any visible native session suppresses outreach', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual();
  f.history.push({ ...f.history[0], id: 5, session_id: 'other', timestamp: f.time - MINUTE });
  assert.equal((await f.run()).status, 'recent_chat'); assert.equal(f.writes.length, 0);
});
test('purpose: invalid/future message time is not silently treated as idle', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual(); f.history[0].timestamp = f.time + HOUR;
  assert.equal((await f.run()).status, 'clock_invalid'); assert.equal(f.writes.length, 0);
});
test('purpose: concurrent foreground/task passes cannot enqueue twice', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual();
  const results = await Promise.allSettled([f.run(), f.run()]);
  assert.equal(f.writes.length, 1); assert.ok(results.some(r => r.status === 'rejected' && /另一项任务/.test(r.reason.message)));
});
test('purpose: daily quota uses the scheduled local day and gap survives midnight', () => {
  const r = createPurposeRecord('a', START); r.config = { ...r.config, mode: 'auto', sessionId: 's', dreamOutreachDisabled: true, quietStart: '00:00', quietEnd: '00:00', dailyMax: 1 };
  r.activatedAt = START - HOUR;
  const now = epoch('2026-11-08', 1439) + 30000, native = { sessions: [{ session_id: 's' }], messages: [], lastInteractionAt: 0 };
  r.deliveries.push({ status: 'cancelled', reservedAt: START - 24 * HOUR, request: { timestamp: epoch('2026-11-09', 1) } });
  assert.equal(purposeOpportunity(r, native, { timezone: 'Asia/Shanghai', sleeping: false }, now).reason, 'daily_limit');
  r.deliveries = [{ status: 'cancelled', reservedAt: now - MINUTE }];
  assert.equal(purposeOpportunity(r, native, { timezone: 'Asia/Shanghai', sleeping: false }, now + MINUTE).reason, 'cooldown');
});
test('purpose: dismissing a sourced hypothesis does not regenerate it from the same chat', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await f.run(); const id = (await f.record()).goals[0].id;
  await purposeFeedback(f.store, f.role.id, id, 'dismissed', f.opts); f.time += 4 * HOUR;
  assert.equal((await f.run()).status, 'no_goal'); assert.equal((await f.record()).goals.length, 1); assert.equal(f.calls.length, 2);
});
test('purpose: background opt-in is separate from life background; its state survives a store restart', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const before = await f.store.getProfile(f.role.id);
  await configurePurpose(f.client, f.store, f.role.id, { ...(await f.record()).config, background: true }, f.opts);
  assert.equal((await runPurposeBackground(f.client, f.store, f.opts)).status, 'observed');
  assert.equal((await createPurposeStore(createStore(f.client)).get(f.role.id)).deliveries.length, 1);
  assert.deepEqual(await f.store.getProfile(f.role.id), before);
});
test('purpose: old hosts can observe but cannot silently fall back to writing chat history', async t => {
  const f = await fixture(); t.after(() => f.db.close()); delete f.client.chat.scheduleChatMessage;
  assert.equal((await f.run()).status, 'observed');
  await configurePurpose(f.client, f.store, f.role.id, { ...(await f.record()).config, mode: 'auto' }, { now: START - HOUR });
  assert.equal((await f.run()).status, 'unsupported'); assert.equal(f.writes.length, 0);
});
test('purpose: auto requires explicit session/Dream configuration and enforces warm-up', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await assert.rejects(configurePurpose(f.client, f.store, f.role.id, { mode: 'auto' }, f.opts), /Dream/);
  await configurePurpose(f.client, f.store, f.role.id, { ...(await f.record()).config, mode: 'auto' }, f.opts); await f.manual();
  assert.equal((await f.run()).status, 'initial_delay'); assert.equal(f.calls.length, 0);
});
test('purpose: compare-and-swap detects stale state even if an old lock holder resumes', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await assert.rejects(f.ps.lock(f.role.id, async (record, save) => {
    const current = (await f.store.query(PURPOSE_SQL.get, [f.role.id])).rows[0].data;
    await f.store.query(PURPOSE_SQL.cas, [JSON.stringify({ ...record, lastRunAt: START + 1 }), f.role.id, current]);
    record.lastRunAt = START + 2; await save();
  }), /其他任务修改/);
});
test('purpose: task orchestration reports independent results without enabling life writes', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await configurePurpose(f.client, f.store, f.role.id, { ...(await f.record()).config, background: true }, f.opts);
  const r = await runTasks(f.client, f.store, f.opts);
  assert.equal(r.purpose.status, 'observed'); assert.equal(r.life.status, 'idle'); assert.equal(f.writes.length, 0);
});

test('purpose: emitted task is a classic script returning a Promise without DOM, timers, SDK import or Intl', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const result = await build({ entryPoints: [new URL('../src/task-entry.js', import.meta.url).pathname], bundle: true, format: 'iife', globalName: 'LifeTask', target: 'es2020', write: false });
  const source = result.outputFiles[0].text + '\nLifeTask.run();';
  assert.doesNotMatch(source, /ReactNativeWebView|new LaylaSDK|^import /m);
  const context = vm.createContext({ layla: f.client, console: { info() {} }, Intl: undefined });
  const value = new vm.Script(source).runInContext(context);
  assert.equal(typeof value.then, 'function');
  const output = await value;
  assert.equal(output.purpose.status, 'idle'); assert.equal(output.life.status, 'idle');
  assert.equal(f.writes.length, 0);
});

test('purpose: failed cancellation receipt keeps the journal unresolved and does not repeat scheduling', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual(); await f.run(); f.failure = 'cancel';
  await cancelPurposeDelivery(f.client, f.store, f.role.id, (await f.record()).deliveries[0].id, f.opts);
  assert.equal((await f.record()).deliveries[0].status, 'uncertain'); assert.equal(f.queue.length, 0);
  f.failure = ''; await f.run(); assert.equal(f.writes.length, 1);
});

test('purpose: context changes after queueing cause conservative cancellation', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual(); await f.run();
  f.time += 10000; f.history.push({ ...f.history[0], id: 8, content: '继续刚才的话题吧', timestamp: f.time });
  await f.run({ reconcileOnly: true }); assert.deepEqual(f.cancels, [101]); assert.equal(f.writes.length, 1);
});

test('purpose: a changed timezone cancels the existing reservation without rewriting it', async t => {
  const f = await fixture('auto'); t.after(() => f.db.close()); await f.manual(); await f.run();
  const profile = await f.store.getProfile(f.role.id); profile.settings.timezone = 'Asia/Tokyo'; await f.store.putProfile(profile);
  await f.run({ reconcileOnly: true }); assert.deepEqual(f.cancels, [101]); assert.equal(f.writes.length, 1);
});
