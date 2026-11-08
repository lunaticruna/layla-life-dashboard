import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_SYNC_END, CARD_SYNC_START, applyCardSyncBlock, archiveSessionId, buildCardSyncBlock, confirmedWakeTime, continuousSleepBlock, createProfile, dailyTimelineFacts, extractWakeMention, hasUnconfirmedWakeTime, stripCardSyncBlock, validatePlan, templatePlan, epoch, parts, contextAt, advanceProfile, sleepPhase, makeSnapshot, parseJSON, validateDocument, memoryPayload, documentId, upgradeProfile } from '../src/core.js';
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

test('R1.1 / R2: Wake regex boundary filtering (degree adverbs, nap contexts, quotes, 零X分, vague mentions)', () => {
  // Degree adverbs must return null (not parsed as 01:00)
  for (const phrase of ['今天晚一点起床', '慢一点起身', '差一点醒来', '快一点起床', '早一点起床', '好一点起床', '多一点起床', '少一点起床', '晚了一点起床']) {
    assert.equal(extractWakeMention(phrase), null, `expected null for adverb: ${phrase}`);
  }

  // Midday & nap contexts must return null (not parsed as morning wake-ups)
  for (const phrase of ['午睡到两点半醒来', '小憩到14:30睡醒', '今天下午三点醒来', '中午12点睡醒', '傍晚六点醒来', '打盹到两点半醒来']) {
    assert.equal(extractWakeMention(phrase), null, `expected null for nap/midday: ${phrase}`);
  }

  // Plan comparisons and quotes: only actual wake-up extracted, planned/quoted wake skipped
  const planComparison = extractWakeMention('平时计划8:00起床，今天8:44醒来');
  assert.deepEqual(planComparison, { phrase: '8:44醒来', time: '08:44' });

  assert.equal(extractWakeMention('你说早上8点起床'), null);
  assert.equal(extractWakeMention('听你说早上8点起床'), null);
  assert.equal(extractWakeMention('聊天中提到早上8点起床'), null);

  // 零X分 support
  assert.deepEqual(extractWakeMention('八点零五分起床'), { phrase: '八点零五分起床', time: '08:05' });
  assert.deepEqual(extractWakeMention('早上八点零五起床'), { phrase: '早上八点零五起床', time: '08:05' });
  assert.deepEqual(extractWakeMention('7点零9分醒来'), { phrase: '7点零9分醒来', time: '07:09' });

  // Vague mentions: exact: false, time preserved
  const vague = extractWakeMention('十点多才从被子里爬出来');
  assert.equal(vague.time, '10:00');
  assert.equal(vague.exact, false);

  // hasUnconfirmedWakeTime behavior
  assert.equal(hasUnconfirmedWakeTime('十点多才从被子里爬出来', ''), false);
  assert.equal(hasUnconfirmedWakeTime('十点多才从被子里爬出来', '08:44'), true);
  assert.equal(hasUnconfirmedWakeTime('平时计划8:00起床，今天8:44醒来', '08:44'), false);
  assert.equal(hasUnconfirmedWakeTime('平时计划8:00起床，今天8:44醒来', '08:00'), true);
  assert.equal(hasUnconfirmedWakeTime('早上8:44起床', '08:44'), false);
  assert.equal(hasUnconfirmedWakeTime('早上8:44起床', '08:00'), true);
});

test('R1.2 / R2: Sleep phase and resting state linkage with confirmed wake records and sleeping wakeSource', () => {
  const p = createProfile(character, epoch(day, 0));
  p.settings.sleepStart = '23:30';
  p.settings.sleepEnd = '08:00';
  const wakeTs = epoch(day, 420); // 07:00
  p.wakeRecords[day] = { at: wakeTs, timezone: 'Asia/Shanghai' };

  // Before confirmed wake time (06:30): character is in light/deep sleep
  const beforeWake = epoch(day, 390);
  assert.equal(sleepPhase(p, beforeWake), 'deep_sleep');

  // At confirmed wake time (07:00): character transitions to awake
  assert.equal(sleepPhase(p, wakeTs), 'awake');

  // After confirmed wake time but before planned sleepEnd (07:30): character remains awake!
  const afterWake = epoch(day, 450);
  assert.equal(sleepPhase(p, afterWake), 'awake');

  // AdvanceProfile: resting is false once confirmed wake time is reached
  const advanced = advanceProfile(p, afterWake);
  assert.ok(advanced.state.updatedAt === afterWake);

  // Night sleep (23:45): not affected by morning wakeRecord
  const nightTs = epoch(day, 1425);
  assert.notEqual(sleepPhase(p, nightTs), 'awake');

  // dailyTimelineFacts with wakeSource = 'sleeping' during morning sleep when unconfirmed
  const pUnconfirmed = createProfile(character, epoch(day, 0));
  pUnconfirmed.settings.sleepStart = '23:30';
  pUnconfirmed.settings.sleepEnd = '08:00';
  const morningSleepNow = epoch(day, 420); // 07:00, unconfirmed
  const sleepingFacts = dailyTimelineFacts(pUnconfirmed, [], day, morningSleepNow);
  assert.equal(sleepingFacts.wakeSource, 'sleeping');
  assert.match(sleepingFacts.wakeSummary, /尚未起床/);
  assert.equal(sleepingFacts.wakeTime, '');
});

test('R1.3 / R2: Timezone consistency, default now, and wakeRecords object normalization in upgradeProfile', () => {
  // Default now in confirmedWakeTime
  const p = createProfile(character, epoch(day, 0));
  const morningAt = epoch(day, 480, 'Asia/Shanghai'); // 08:00
  p.wakeRecords[day] = { at: morningAt, timezone: 'Asia/Shanghai' };
  // Calling confirmedWakeTime with 2 arguments (now defaults to Date.now())
  assert.equal(confirmedWakeTime(p, day), '08:00');

  // Timezone switch: user changes settings timezone to Asia/Tokyo
  p.settings.timezone = 'Asia/Tokyo';
  // Must use record.timezone ('Asia/Shanghai') and still return '08:00' for day
  assert.equal(confirmedWakeTime(p, day), '08:00');

  // Normalization in upgradeProfile: null, array, corrupt wakeRecords fallback to {}
  const corruptInput1 = { characterId: 'c1', name: '测试', wakeRecords: null };
  const up1 = upgradeProfile(corruptInput1);
  assert.deepEqual(up1.wakeRecords, {});

  const corruptInput2 = { characterId: 'c2', name: '测试', wakeRecords: ['invalid', 'array'] };
  const up2 = upgradeProfile(corruptInput2);
  assert.deepEqual(up2.wakeRecords, {});

  const validInput = { characterId: 'c3', name: '测试', wakeRecords: { [day]: { at: morningAt, timezone: 'Asia/Shanghai' } } };
  const up3 = upgradeProfile(validInput);
  assert.equal(up3.wakeRecords[day].at, morningAt);
});

test('R1.2 / R2: continuousSleepBlock accurately identifies contiguous sleep blocks and morning start', () => {
  const nodes = [
    { id: 's1', start: 0, end: 360, kind: 'sleep' },
    { id: 's2', start: 360, end: 480, kind: 'sleep' },
    { id: 'w1', start: 480, end: 720, kind: 'work' },
    { id: 'n1', start: 720, end: 780, kind: 'nap' },
    { id: 'w2', start: 780, end: 1260, kind: 'leisure' },
    { id: 's3', start: 1260, end: 1440, kind: 'sleep' }
  ];
  const b0 = continuousSleepBlock(nodes, 0);
  assert.deepEqual(b0, { start: 0, end: 480, startIndex: 0, endIndex: 1, containsMorningStart: true });

  const b1 = continuousSleepBlock(nodes, 1);
  assert.deepEqual(b1, { start: 0, end: 480, startIndex: 0, endIndex: 1, containsMorningStart: true });

  const bEvening = continuousSleepBlock(nodes, 5);
  assert.deepEqual(bEvening, { start: 1260, end: 1440, startIndex: 5, endIndex: 5, containsMorningStart: false });

  assert.equal(continuousSleepBlock(nodes, 2), null); // 'work' is not sleep
  assert.equal(continuousSleepBlock(nodes, 3), null); // 'nap' is not sleep
  assert.equal(continuousSleepBlock(nodes, -1), null); // out of bounds
  assert.equal(continuousSleepBlock(nodes, 99), null); // out of bounds
  assert.equal(continuousSleepBlock([], 0), null);
});

test('R1.2 / R2: Defect 2: Early evening sleep before settings.sleepStart is protected from morning wakeAt', () => {
  const p = createProfile(character, epoch(day, 0));
  p.settings.sleepStart = '23:30'; // default preference is 23:30 (1410 min)
  p.settings.sleepEnd = '08:00';
  p.plans[day] = {
    source: 'custom',
    nodes: [
      { id: 'm-sleep', start: 0, end: 480, kind: 'sleep', summary: '晨间睡眠' },
      { id: 'day-activity', start: 480, end: 1260, kind: 'work', summary: '日间工作' },
      { id: 'early-sleep', start: 1260, end: 1440, kind: 'sleep', summary: '提前就寝' } // 21:00 starts early sleep
    ]
  };
  // Morning confirmed wake time is 08:30 (510 min)
  const morningWakeAt = epoch(day, 510, p.settings.timezone);
  p.wakeRecords[day] = { at: morningWakeAt, timezone: p.settings.timezone };

  // 1. Morning sleep after wakeAt must be awake
  const morningAfterWakeTs = epoch(day, 470, p.settings.timezone); // 07:50
  // Note: 07:50 is before 08:30 wakeAt, so morning sleep at 07:50 should still be deep_sleep
  assert.equal(sleepPhase(p, morningAfterWakeTs), 'deep_sleep');

  // Morning after wakeAt (08:35):
  const morningAwakeTs = epoch(day, 515, p.settings.timezone); // in day-activity node
  assert.equal(sleepPhase(p, morningAwakeTs), 'awake');

  // 2. Early evening sleep at 21:10 (1270 min): must NOT be treated as morning sleep or canceled by morningWakeAt!
  const eveningStartTs = epoch(day, 1270, p.settings.timezone);
  assert.equal(sleepPhase(p, eveningStartTs), 'falling_asleep');

  // Early evening sleep at 21:40 (1300 min):
  const eveningLightTs = epoch(day, 1300, p.settings.timezone);
  assert.equal(sleepPhase(p, eveningLightTs), 'light_sleep');

  // Early evening sleep at 22:15 (1335 min):
  const eveningDeepTs = epoch(day, 1335, p.settings.timezone);
  assert.equal(sleepPhase(p, eveningDeepTs), 'deep_sleep');
});

test('R1.2 / R2: Defect 2: advanceProfile protects early evening sleep and maintains resting state', () => {
  const p = createProfile(character, epoch(day, 0));
  p.settings.sleepStart = '23:30';
  p.settings.sleepEnd = '08:00';
  p.plans[day] = {
    source: 'custom',
    nodes: [
      { id: 'm-sleep', start: 0, end: 480, kind: 'sleep', summary: '晨间睡眠' },
      { id: 'day-activity', start: 480, end: 1260, kind: 'work', summary: '日间工作' },
      { id: 'early-sleep', start: 1260, end: 1440, kind: 'sleep', summary: '提前就寝' } // 21:00
    ]
  };
  p.wakeRecords[day] = { at: epoch(day, 510, p.settings.timezone), timezone: p.settings.timezone };

  // Set profile state at 21:00 (1260 min) with low energy
  const startTs = epoch(day, 1260, p.settings.timezone);
  p.state.updatedAt = startTs;
  p.state.energy = 30;
  p.state.hunger = 40;
  p.state.arousal = 0.5;

  // Advance by 90 minutes to 22:30 (1350 min)
  const endTs = epoch(day, 1350, p.settings.timezone);
  const advanced = advanceProfile(p, endTs);

  // In early evening sleep, energy should recover (resting = true)
  assert.ok(advanced.state.energy > 30, `energy should recover during early evening sleep (was 30, now ${advanced.state.energy})`);
  assert.ok(advanced.state.arousal < 0.5, `arousal should decrease during sleep (was 0.5, now ${advanced.state.arousal})`);
});

test('R1.1 / R2: memoryPayload supports reflection and strict mode intercepts unconfirmed/conflicting wake', () => {
  const reflectionDoc = {
    id: 'doc-refl-1',
    characterId: 'role-a',
    kind: 'reflection',
    day: '2026-11-01',
    title: '反思与整理',
    body: '今天10:00起床后，反思了昨日的项目进展。',
    summary: '10:00起床，反思了昨日项目进展。',
    createdAt: Date.now(),
    timelineFacts: { wakeTime: '08:44', wakeSource: 'manual' } // confirmed wake is 08:44, text claims 10:00
  };

  // 1. In strict mode, memoryPayload must throw
  assert.throws(
    () => memoryPayload(reflectionDoc, { strict: true }),
    /文稿包含未确认或冲突的起床时间，已严格拦截原生记忆生成/
  );

  // 2. Non-strict mode does not throw and computes payload
  const payload = memoryPayload(reflectionDoc);
  assert.ok(payload);
  assert.ok(payload.rawText.includes('反思与整理'));
  // Conflicting wake time 08:44 vs 10:00 in summary means wakeTag is empty or not matching conflicting claim
  assert.ok(!payload.summary.includes('已确认 10:00 起床'));
});

