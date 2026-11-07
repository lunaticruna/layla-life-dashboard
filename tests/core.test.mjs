import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_SYNC_END, CARD_SYNC_START, applyCardSyncBlock, archiveSessionId, buildCardSyncBlock, createProfile, dailyTimelineFacts, extractWakeMention, stripCardSyncBlock, validatePlan, templatePlan, epoch, parts, contextAt, advanceProfile, sleepPhase, makeSnapshot, parseJSON, validateDocument, memoryPayload, documentId } from '../src/core.js';
const character = { id: 'role-a', data: { data: { name: '测试角色' } } };
const day = '2026-11-01';

test('default schedule covers a whole day and next node crosses midnight', () => {
  const p = createProfile(character, epoch(day, 0));
  for (const [start, end] of [['23:30', '08:00'], ['00:00', '08:00'], ['12:00', '13:00'], ['22:00', '06:30']]) {
    p.settings.sleepStart = start; p.settings.sleepEnd = end;
    assert.doesNotThrow(() => validatePlan(templatePlan(day, p), day));
  }
  p.settings.sleepStart = '23:30'; p.settings.sleepEnd = '08:00';
  const c = contextAt(p, epoch(day, 1439));
  assert.equal(c.nextDate, '2026-11-02'); assert.equal(c.next.start, 0);
});
test('rejects overlapping, incomplete and nonfinite schedules', () => {
  const p = createProfile(character), nodes = templatePlan(day, p);
  const bad = structuredClone(nodes); bad[1].start -= 1;
  assert.throws(() => validatePlan(bad, day), /重叠/);
  assert.throws(() => validatePlan(nodes.slice(1), day), /覆盖/);
  const invalid = structuredClone(nodes); invalid[0].end = NaN;
  assert.throws(() => validatePlan(invalid, day), /无效/);
});
test('timezones do not depend on machine timezone or Intl', () => {
  const t = epoch(day, 30, 'Asia/Tokyo');
  assert.equal(parts(t, 'Asia/Tokyo').day, day);
  assert.equal(parts(t, 'Asia/Tokyo').minute, 30);
  assert.equal(parts(t, 'Asia/Shanghai').day, '2026-10-31');
});
test('sleep recovers energy, refresh is idempotent, clock rollback is harmless', () => {
  const start = epoch(day, 60), p = createProfile(character, start); p.state.energy = 30;
  const out = advanceProfile(p, start + 4 * 3600000);
  assert.ok(out.state.energy > p.state.energy); assert.ok(out.state.energy <= 90);
  assert.deepEqual(advanceProfile(out, out.state.updatedAt), out);
  assert.deepEqual(advanceProfile(out, start), out);
});
test('only actual assistant messages create a wake window; duplicates do not extend it', () => {
  const start = epoch(day, 60), now = start + 600000, p = createProfile(character, start);
  const message = { id: 13, role: 'user', timestamp: start + 300000 };
  assert.notEqual(sleepPhase(advanceProfile(p, now, [message]), now), 'woken');
  message.role = 'assistant';
  const awake = advanceProfile(p, now, [message]);
  assert.equal(sleepPhase(awake, now), 'woken');
  const next = advanceProfile(awake, now + 60000, [message]);
  assert.equal(next.state.awakeUntil, awake.state.awakeUntil);
  assert.equal(sleepPhase(advanceProfile(next, start + 60 * 60000), start + 60 * 60000), 'deep_sleep');
});
test('meal transition only applies once and offline work is bounded', () => {
  const start = epoch(day, 710), p = createProfile(character, start); p.state.hunger = 70;
  const out = advanceProfile(p, epoch(day, 730));
  assert.ok(out.state.hunger < 20);
  assert.deepEqual(advanceProfile(out, epoch(day, 730)), out);
  const long = advanceProfile(p, start + 300 * 86400000);
  assert.ok(long.state.energy >= 0 && long.state.energy <= 100);
  assert.equal(long.state.updatedAt, start + 300 * 86400000);
});
test('snapshot distinguishes cached weather and the simulated scene', () => {
  const p = createProfile(character, epoch(day, 800)); p.settings.weatherNote = '多云'; p.settings.weatherAt = epoch(day, 300);
  const s = makeSnapshot(p, epoch(day, 800)); assert.equal(s.weatherStale, true); assert.equal(s.source, 'template');
  assert.equal(s.current.kind, 'leisure'); assert.equal(s.dayType, '周末');
});
test('documents validate model output and keep dream provenance in native memory', () => {
  assert.deepEqual(parseJSON('```json\n{"title":"甲"}\n```'), { title: '甲' });
  assert.throws(() => validateDocument({ title: 'x', body: '', summary: 'y' }), /正文/);
  const d = { id: documentId('role-a', 'dream', day), characterId: 'role-a', sessionId: 'session-1', kind: 'dream', day, title: '梦中的车站', body: '梦见了一座车站', summary: '梦境：车站。', createdAt: epoch(day, 600) };
  const m = memoryPayload(d); assert.equal(m.knowledgeGraphJSON, null); assert.match(m.rawText, /这是梦境，不是双方真实经历/); assert.match(m.summary, /梦境（2026-11-01）/);
  const isolated = memoryPayload(d, { memorySessionMode: 'isolated' });
  assert.equal(isolated.session_id, archiveSessionId('role-a'));
});

test('wake extraction, daily timeline facts and reversible card sync block stay consistent', () => {
  assert.deepEqual(extractWakeMention('今天早上8:44起床，喝了一杯水'), { phrase: '早上8:44起床', time: '08:44' });
  assert.deepEqual(extractWakeMention('8点半醒来'), { phrase: '8点半醒来', time: '08:30' });
  assert.equal(extractWakeMention('十点多才从被子里爬出来').time, '10:00');
  const p = createProfile(character, epoch(day, 524));
  const morningScene = { id: 'sc-1', characterId: character.id, day, start: epoch(day, 480), end: epoch(day, 525), phase: 'awake', summary: '起身与用餐', location: '家里', scene: '8:44 刚收拾好桌面准备吃早饭。', generatedAt: epoch(day, 524) };
  const now = epoch(day, 900);
  const olderDiary = { day, characterId: character.id, kind: 'diary', summary: '今天10:00起床' };
  const facts = dailyTimelineFacts(p, [morningScene], day, now, [olderDiary]);
  assert.equal(facts.plannedWakeTime, '08:00');
  assert.equal(facts.firstAwakeTime, '08:44');
  assert.equal(facts.wakeTime, '');
  assert.equal(facts.wakeSource, 'scene');
  assert.doesNotMatch(buildCardSyncBlock(p, [morningScene], [olderDiary], now), /10:00起床/);
  p.wakeRecords[day] = { at: epoch(day, 522) };
  const block = buildCardSyncBlock(p, [morningScene], [olderDiary], now);
  assert.ok(block.startsWith(CARD_SYNC_START) && block.endsWith(CARD_SYNC_END));
  assert.match(block, /计划 08:00 结束休息；首个清醒片段 08:44；已确认 08:42 起床/);
  const original = '保持角色一贯温和克制的语气。';
  const merged = applyCardSyncBlock(original, block);
  assert.ok(merged.startsWith(original));
  assert.equal(applyCardSyncBlock(merged, block), merged);
  assert.equal(stripCardSyncBlock(merged), original);
  assert.equal(applyCardSyncBlock(merged, ''), original);
});
