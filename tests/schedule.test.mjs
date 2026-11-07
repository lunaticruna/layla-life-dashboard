import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import {
  createProfile,
  epoch,
  parts,
  hhmm,
  validatePlan,
  buildCardSyncBlock,
  advanceProfile,
  sleepPhase
} from '../src/core.js';
import {
  DEFAULT_DAY_TYPES,
  pickDayType,
  cleanItem,
  normalizeItems,
  templateItems,
  applyChange,
  formatSyncTime,
  DEFAULT_VOICE,
  priorityLine,
  buildVoiceBlock
} from '../src/schedule.js';
import {
  generatePlan,
  syncCharacterContext,
  runBackground
} from '../src/workflow.js';

function createMockEnvironment(opts = {}) {
  const db = new DatabaseSync(':memory:');
  const cardUpdates = [];
  const completionsRequests = [];
  let completionResponse = opts.completionResponse || null;
  const character = {
    id: 'char-test-sched',
    data: {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '澪',
        description: '文学少女',
        post_history_instructions: ''
      }
    }
  };

  const client = {
    db: {
      executeSql: async (q, args = []) => {
        const stmt = db.prepare(q);
        if (/^SELECT/i.test(q.trim())) {
          return { rows: stmt.all(...args), rowsAffected: 0, insertId: 0 };
        }
        const r = stmt.run(...args);
        return { rows: [], rowsAffected: Number(r.changes), insertId: Number(r.lastInsertRowid) };
      }
    },
    characters: {
      list: async () => [character],
      update: async (updated) => {
        cardUpdates.push(structuredClone(updated));
        character.data = structuredClone(updated.data);
        return updated.id;
      }
    },
    chat: {
      getChatSessions: async () => ({ sessions: [{ session_id: 'sched-session' }] }),
      getChatHistory: async () => [],
      completions: {
        create: async (req) => {
          completionsRequests.push(req);
          if (completionResponse instanceof Error) {
            throw completionResponse;
          }
          if (typeof completionResponse === 'function') {
            return completionResponse(req);
          }
          if (completionResponse) {
            return completionResponse;
          }
          const sys = req.messages?.[0]?.content || '';
          if (sys.includes('TASK:DIARY') || sys.includes('TASK:DREAM')) {
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    title: '生活日记',
                    body: '今天是个平静安适的日子，把手头的事情逐一完成。',
                    summary: '今天完成了既定活动，平静安适。'
                  })
                }
              }]
            };
          }
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  title: '生成的日常',
                  mood: '平静',
                  nodes: [
                    { start: '00:00', end: '08:00', kind: 'sleep', summary: '睡眠' },
                    { start: '08:00', end: '12:00', kind: 'study', summary: '阅读' },
                    { start: '12:00', end: '13:00', kind: 'meal', summary: '午餐' },
                    { start: '13:00', end: '18:00', kind: 'work', summary: '写作' },
                    { start: '18:00', end: '19:00', kind: 'meal', summary: '晚餐' },
                    { start: '19:00', end: '23:30', kind: 'leisure', summary: '休息' },
                    { start: '23:30', end: '24:00', kind: 'sleep', summary: '入睡' }
                  ]
                })
              }
            }]
          };
        }
      }
    },
    personas: {
      get: async () => ({ name: '旅行者', description: '' })
    },
    memories: {
      list: async () => [],
      createOrUpdate: async (rows) => rows
    }
  };

  const store = createStore(client);

  return {
    db,
    client,
    store,
    character,
    cardUpdates,
    completionsRequests,
    setCompletionResponse(r) { completionResponse = r; }
  };
}

// -------------------------------------------------------------
// Point 1: Sync Block Precision & Prompt Cache Protection
// -------------------------------------------------------------
test('Point 1: formatSyncTime supports halfhour, node and minute rounding', () => {
  // 'halfhour' rounds to floor(minute/30)*30 with '约 ' prefix
  assert.equal(formatSyncTime('halfhour', 14 * 60 + 0), '约 14:00');
  assert.equal(formatSyncTime('halfhour', 14 * 60 + 15), '约 14:00');
  assert.equal(formatSyncTime('halfhour', 14 * 60 + 29), '约 14:00');
  assert.equal(formatSyncTime('halfhour', 14 * 60 + 30), '约 14:30');
  assert.equal(formatSyncTime('halfhour', 14 * 60 + 45), '约 14:30');
  assert.equal(formatSyncTime('halfhour', 14 * 60 + 59), '约 14:30');

  // 'node' returns empty string to omit clock time entirely
  assert.equal(formatSyncTime('node', 14 * 60 + 15), '');
  assert.equal(formatSyncTime('node', 14 * 60 + 45), '');

  // 'minute' returns exact clock time
  assert.equal(formatSyncTime('minute', 14 * 60 + 15), '14:15');
  assert.equal(formatSyncTime('minute', 14 * 60 + 45), '14:45');
});

test('Point 1: discrete sleep phases differentiate falling_asleep, light_sleep and deep_sleep', () => {
  const env = createMockEnvironment();
  const day = '2026-11-01';
  const startTs = epoch(day, 0); // 00:00
  const profile = createProfile(env.character, startTs);
  profile.settings.sleepStart = '23:30';
  profile.settings.sleepEnd = '08:00';

  // Sleep starts at 23:30 (1410 min).
  // At 23:35 (5 min into sleep) -> falling_asleep (<15m)
  const phase5 = sleepPhase(profile, epoch(day, 23 * 60 + 35));
  assert.equal(phase5, 'falling_asleep');

  // At 00:00 (30 min into sleep) -> light_sleep (15 to 45m)
  const phase30 = sleepPhase(profile, epoch('2026-11-02', 0));
  assert.equal(phase30, 'light_sleep');

  // At 00:30 (60 min into sleep) -> deep_sleep (>= 45m)
  const phase60 = sleepPhase(profile, epoch('2026-11-02', 30));
  assert.equal(phase60, 'deep_sleep');
});

test('Point 1: prompt cache protection skips client.characters.update when instructions are unchanged', async () => {
  const env = createMockEnvironment();
  await env.store.init();
  const day = '2026-11-01';
  const fixedNow = epoch(day, 14 * 60 + 5); // 14:05
  const profile = createProfile(env.character, fixedNow);
  profile.settings.syncPrecision = 'halfhour';

  // First sync: instructions are updated
  const res1 = await syncCharacterContext(env.client, env.store, env.character, profile, { now: fixedNow });
  assert.equal(res1.status, 'synced');
  assert.equal(res1.updated, true);
  assert.equal(env.cardUpdates.length, 1);

  // Advance time by 1 minute (14:06). In halfhour mode, formatted time is still '约 14:00'
  const fixedNowNextMin = epoch(day, 14 * 60 + 6);
  const res2 = await syncCharacterContext(env.client, env.store, env.character, profile, { now: fixedNowNextMin });
  // Must skip character update to protect host prompt cache
  assert.equal(res2.status, 'unchanged');
  assert.equal(res2.updated, false);
  assert.equal(env.cardUpdates.length, 1, 'client.characters.update must NOT be called');

  env.db.close();
});

// -------------------------------------------------------------
// Point 2: DayTypes & Prompt Context Injection
// -------------------------------------------------------------
test('Point 2: pickDayType selects dayType matching weekday/weekend and weights', () => {
  const types = DEFAULT_DAY_TYPES;
  assert.ok(Array.isArray(types) && types.length >= 3);

  // Forced ID selection
  const forced = pickDayType(types, '2026-11-01', 'workday');
  assert.equal(forced.id, 'workday');

  // Deterministic pseudo-random selection on weekday (e.g. 2026-11-02 Monday)
  const chosenWeekday = pickDayType(types, '2026-11-02', null, () => 0.1);
  assert.ok(['restday', 'workday', 'outing'].includes(chosenWeekday.id));

  // Fallback when all disabled
  const disabledTypes = types.map(t => ({ ...t, enabled: false }));
  const fallback = pickDayType(disabledTypes, '2026-11-01');
  assert.equal(fallback.id, 'restday');
});

test('Point 2: generatePlan injects dayType, recentSummary, hints, partnerName and extraRules', async () => {
  const env = createMockEnvironment();
  await env.store.init();
  const day = '2026-11-04';
  const profile = createProfile(env.character, epoch(day, 8 * 60));
  profile.settings.extraRules = '午后必须有至少30分钟的户外散步与阳光接触';
  await env.store.putProfile(profile);

  // Seed plans for previous 2 days in store
  await env.store.savePlan({
    characterId: env.character.id,
    day: '2026-11-02',
    title: '专注研究日',
    mood: '专注',
    dayType: 'workday',
    source: 'generated',
    nodes: templateItems('workday')
  });
  await env.store.savePlan({
    characterId: env.character.id,
    day: '2026-11-03',
    title: '散步与书店日',
    mood: '悠闲',
    dayType: 'restday',
    source: 'generated',
    nodes: templateItems('restday')
  });

  const plan = await generatePlan(env.client, env.store, env.character, {
    day,
    hint: '傍晚想在厨房炖一锅罗宋汤',
    forcedDayType: 'restday',
    partnerName: '旅行者'
  });

  assert.ok(plan);
  assert.equal(plan.day, day);
  assert.equal(env.completionsRequests.length, 1);
  const promptContent = env.completionsRequests[0].messages.map(m => m.content).join('\n');

  // Verify multi-factor context injected into prompt
  assert.ok(promptContent.includes('日常休息') || promptContent.includes('restday'), 'dayType must be in prompt');
  assert.ok(promptContent.includes('傍晚想在厨房炖一锅罗宋汤'), 'hint must be in prompt');
  assert.ok(promptContent.includes('午后必须有至少30分钟的户外散步'), 'extraRules must be in prompt');
  assert.ok(promptContent.includes('旅行者'), 'partnerName must be in prompt');
  assert.ok(promptContent.includes('前几天日程参考') || promptContent.includes('2026-11-02') || promptContent.includes('专注研究日'), 'recentSummary must be in prompt');

  env.db.close();
});

// -------------------------------------------------------------
// Point 3: Normalization Repair & Fallback Templates
// -------------------------------------------------------------
test('Point 3: normalizeItems repairs overlapping, disjoint, unpadded and malformed items', () => {
  // 1. Gaps and overlap repair
  const imperfectNodes = [
    { start: '08:00', end: '11:00', kind: 'study', summary: '自习' },
    { start: '10:30', end: '12:30', kind: 'meal', summary: '提前午餐' }, // overlaps with previous
    { start: '14:00', end: '18:00', kind: 'work', summary: '下午工作' }   // gap between 12:30 and 14:00
  ];

  const repaired = normalizeItems(imperfectNodes);
  assert.ok(Array.isArray(repaired));
  assert.ok(repaired.length >= 3);

  // Must strictly cover 00:00 to 24:00
  assert.equal(repaired[0].start, 0, 'First node must start at 0 (00:00)');
  assert.equal(repaired[repaired.length - 1].end, 1440, 'Last node must end at 1440 (24:00)');

  // No gaps or overlaps between adjacent nodes
  for (let i = 0; i < repaired.length - 1; i++) {
    assert.equal(repaired[i].end, repaired[i + 1].start, `Node ${i} end must match Node ${i+1} start`);
  }

  // 2. Completely empty input must return valid full-day normalized schedule
  const fromEmpty = normalizeItems([]);
  assert.ok(fromEmpty.length > 0);
  assert.equal(fromEmpty[0].start, 0);
  assert.equal(fromEmpty[fromEmpty.length - 1].end, 1440);
});

test('Point 3: validatePlan with repair:true repairs imperfect LLM schedule without throwing', () => {
  const day = '2026-11-01';
  const rawNodes = [
    { start: 480, end: 720, kind: 'study', summary: '读书' },
    { start: 700, end: 1200, kind: 'work', summary: '写作' }
  ];

  // Without repair option, validatePlan strictly throws on missing 00:00 start
  assert.throws(() => validatePlan(rawNodes, day), /覆盖/);

  // With repair: true, auto-normalizes and succeeds
  const repairedNodes = validatePlan(rawNodes, day, { repair: true });
  assert.ok(Array.isArray(repairedNodes));
  assert.equal(repairedNodes[0].start, 0);
  assert.equal(repairedNodes[repairedNodes.length - 1].end, 1440);
});

test('Point 3: generatePlan falls back to templateItems on LLM failure', async () => {
  const env = createMockEnvironment();
  await env.store.init();
  const day = '2026-11-01';
  const profile = createProfile(env.character, epoch(day, 8 * 60));

  // Simulate LLM 500 error / network timeout
  env.setCompletionResponse(new Error('LLM Service Unavailable 503'));

  const plan = await generatePlan(env.client, env.store, env.character, { day, forcedDayType: 'workday', fallback: true });
  assert.ok(plan);
  assert.equal(plan.source, 'template');
  assert.ok(plan.nodes.length >= 2);
  assert.equal(plan.nodes[0].start, 0);
  assert.equal(plan.nodes[plan.nodes.length - 1].end, 1440);

  env.db.close();
});

// -------------------------------------------------------------
// Point 4: Evening Advance Generation & Tomorrow Mention
// -------------------------------------------------------------
test('Point 4: runBackground pre-generates tomorrow schedule in the evening when autoPlan is enabled', async () => {
  const env = createMockEnvironment();
  await env.store.init();
  const today = '2026-11-01';
  const eveningNow = epoch(today, 22 * 60 + 30); // 22:30 evening
  const profile = createProfile(env.character, eveningNow);
  profile.settings.background = true;
  profile.settings.autoPlan = true;
  profile.settings.planAheadHour = 22;
  await env.store.saveProfile(profile);

  // Seed today's plan so only tomorrow needs generation
  await env.store.savePlan({
    characterId: env.character.id,
    day: today,
    title: '今日计划',
    mood: '平静',
    dayType: 'restday',
    source: 'generated',
    nodes: templateItems('restday')
  });

  const res = await runBackground(env.client, env.store, { now: eveningNow });
  assert.equal(res.status, 'ok');

  // Verify tomorrow's plan was generated and saved into ll_plans
  const tomorrow = '2026-11-02';
  const tomorrowPlan = await env.store.getPlan(env.character.id, tomorrow);
  assert.ok(tomorrowPlan, 'Tomorrow plan must be pre-generated in the evening');
  assert.equal(tomorrowPlan.day, tomorrow);
  assert.match(env.character.data.data.post_history_instructions, /明日安排（2026-11-02/);

  env.db.close();
});

test('Point 4: buildCardSyncBlock appends tomorrow preview only after evening threshold', async () => {
  const env = createMockEnvironment();
  await env.store.init();
  const day = '2026-11-01';
  const tomorrow = '2026-11-02';
  const profile = createProfile(env.character, epoch(day, 12 * 60));
  profile.settings.tomorrowAfterHour = 18;

  // Save tomorrow plan
  const tomorrowPlan = {
    title: '冬日美术馆之行',
    mood: '期待',
    dayType: 'outing',
    source: 'generated',
    nodes: templateItems('outing')
  };
  await env.store.savePlan({
    characterId: env.character.id,
    day: tomorrow,
    ...tomorrowPlan
  });
  profile.plans[tomorrow] = tomorrowPlan;

  // 1. Afternoon at 15:00 (before 18:00 threshold): tomorrow preview must NOT be present
  const blockAfternoon = buildCardSyncBlock(profile, [], [], epoch(day, 15 * 60));
  assert.equal(blockAfternoon.includes('明日安排'), false, 'Tomorrow preview must be omitted before tomorrowAfterHour');

  // 2. Evening at 19:00 (after 18:00 threshold): tomorrow preview MUST be present
  const blockEvening = buildCardSyncBlock(profile, [], [], epoch(day, 19 * 60));
  assert.ok(blockEvening.includes('明日安排'), 'Tomorrow preview must be present after tomorrowAfterHour');
  assert.ok(blockEvening.includes('冬日美术馆之行'));

  env.db.close();
});

// -------------------------------------------------------------
// Point 5: Independent ll_plans Table & applyChange Range Math
// -------------------------------------------------------------
test('Point 5: applyChange correctly splits, truncates, covers nodes and records audit history', () => {
  const baseNodes = [
    { id: '1', start: 0, end: 480, kind: 'sleep', summary: '睡眠' },
    { id: '2', start: 480, end: 720, kind: 'study', summary: '自习' },
    { id: '3', start: 720, end: 840, kind: 'meal', summary: '午餐' },
    { id: '4', start: 840, end: 1080, kind: 'work', summary: '工作' },
    { id: '5', start: 1080, end: 1440, kind: 'sleep', summary: '睡眠' }
  ];

  // 1. Range split: insert change inside [14:00, 16:00] (840 to 960 inside work node 840-1080)
  const change1 = {
    start: '14:00', // 840
    end: '16:00',   // 960
    summary: '突发会议',
    detail: '与项目组商讨需求变更'
  };
  const changed1 = applyChange(baseNodes, change1);
  assert.ok(Array.isArray(changed1));
  assert.equal(changed1[0].start, 0);
  assert.equal(changed1[changed1.length - 1].end, 1440);

  const meetingNode = changed1.find(n => n.summary === '突发会议');
  assert.ok(meetingNode);
  assert.equal(meetingNode.start, 840);
  assert.equal(meetingNode.end, 960);
  assert.equal(meetingNode.source, 'change');

  // Node after meeting must be preserved with truncated start
  const remainderWork = changed1.find(n => n.summary === '工作');
  assert.ok(remainderWork);
  assert.equal(remainderWork.start, 960);
  assert.equal(remainderWork.end, 1080);

  // 2. Complete cover: change [11:30, 18:30] completely covers meal (12:00-14:00) and work
  const change2 = {
    start: '11:30',
    end: '18:30',
    summary: '全天外出考察'
  };
  const changed2 = applyChange(baseNodes, change2);
  const outingNode = changed2.find(n => n.summary === '全天外出考察');
  assert.ok(outingNode);
  assert.equal(outingNode.start, 11 * 60 + 30);
  assert.equal(outingNode.end, 18 * 60 + 30);
  assert.equal(changed2.some(n => n.summary === '午餐'), false, 'Covered meal node must be removed');

  // 3. Invalid clock validation
  assert.throws(() => applyChange(baseNodes, { start: '16:00', end: '14:00', summary: '逆向' }), /end 要晚于 start/);
  assert.throws(() => applyChange(baseNodes, { start: 'bad', end: '14:00', summary: '无效' }), /HH:MM/);
});

test('Point 5: store.applyPlanChange persists modifications and appends to changes array', async () => {
  const env = createMockEnvironment();
  await env.store.init();
  const day = '2026-11-01';

  await env.store.savePlan({
    characterId: env.character.id,
    day,
    title: '原定计划',
    mood: '平静',
    dayType: 'restday',
    source: 'generated',
    nodes: templateItems('restday')
  });

  const updatedPlan = await env.store.applyPlanChange(env.character.id, day, {
    start: '15:00',
    end: '17:00',
    summary: '与朋友喝下午茶',
    detail: '在街角咖啡馆品尝草莓千层'
  });

  assert.ok(updatedPlan);
  assert.ok(Array.isArray(updatedPlan.changes));
  assert.equal(updatedPlan.changes.length, 1);
  assert.equal(updatedPlan.changes[0].summary, '与朋友喝下午茶');
  assert.equal(updatedPlan.changes[0].start, '15:00');
  assert.equal(updatedPlan.changes[0].end, '17:00');

  // Verify persisted in database
  const loaded = await env.store.getPlan(env.character.id, day);
  assert.equal(loaded.changes.length, 1);
  assert.equal(loaded.changes[0].summary, '与朋友喝下午茶');

  env.db.close();
});

// -------------------------------------------------------------
// Point 6: Configurable Speaking Tone & Rules Injection
// -------------------------------------------------------------
test('Point 6: buildVoiceBlock and buildCardSyncBlock inject conversational rules and business priority', () => {
  const env = createMockEnvironment();
  const day = '2026-11-01';
  const profile = createProfile(env.character, epoch(day, 14 * 60));
  profile.settings.voiceRules = true;
  profile.settings.businessPriority = true;
  profile.settings.wokenBriefRule = true;

  // 1. Verify buildVoiceBlock placeholder replacement
  const voice = buildVoiceBlock(profile, { partnerName: '旅行者' });
  assert.ok(voice.includes('澪'), 'Character name placeholder must be replaced');
  assert.ok(voice.includes('旅行者'), 'Partner name placeholder must be replaced');
  assert.ok(voice.includes('口吻') || voice.includes('说话'));
  assert.ok(voice.includes('别报时间段') || voice.includes('不要说「按照日程'));

  // 2. Verify priorityLine
  const priority = priorityLine('澪', '旅行者');
  assert.ok(priority.includes('做正事'));
  assert.ok(priority.includes('旅行者'));

  // 3. Verify card sync block contains business priority and tone rules
  const blockAwake = buildCardSyncBlock(profile, [], [], epoch(day, 14 * 60));
  assert.ok(blockAwake.includes('做正事'), 'Business priority rule must be present in card sync block');
  assert.ok(blockAwake.includes('怎么把这些带进聊天') || blockAwake.includes('口吻说话'), 'Voice rules must be present in card sync block');

  // 4. Verify groggy wake-up rule when sleeping
  profile.settings.sleepStart = '23:30';
  profile.settings.sleepEnd = '08:00';
  const blockSleeping = buildCardSyncBlock(profile, [], [], epoch(day, 2 * 60)); // 02:00 asleep
  assert.ok(blockSleeping.includes('睡着了') || blockSleeping.includes('迷迷糊糊'), 'Groggy wake-up rule must be present during sleep');
});
