import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore, SQL } from '../src/store.js';
import { createProfile, epoch, documentId } from '../src/core.js';
import { templateItems } from '../src/schedule.js';
import { generatePlan, generateDocument, runBackground, writeMemory } from '../src/workflow.js';
import { createMockSQL } from '../src/demo.js';

function createMockStore() {
  const db = new DatabaseSync(':memory:');
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
    }
  };
  const store = createStore(client);
  return { db, client, store };
}

const baseRole = {
  id: 'challenger-role',
  data: {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '爱丽丝',
      description: '生活伴侣角色',
      personality: '温和',
      scenario: '日常',
      post_history_instructions: ''
    }
  }
};

const fixedNow = epoch('2026-11-01', 22 * 60);

function createWorkflowFixture() {
  const db = new DatabaseSync(':memory:');
  let creates = 0, calls = 0, customDoc = null;
  const role = structuredClone(baseRole), memories = [], requests = [];
  const client = {
    db: {
      executeSql: async (q, args = []) => {
        const stmt = db.prepare(q);
        if (/^SELECT/i.test(q.trim())) return { rows: stmt.all(...args), rowsAffected: 0, insertId: 0 };
        const r = stmt.run(...args);
        return { rows: [], rowsAffected: Number(r.changes), insertId: Number(r.lastInsertRowid) };
      }
    },
    characters: { list: async () => [role], update: async updated => { role.data = structuredClone(updated.data); return updated.id; } },
    chat: {
      getChatSessions: async () => ({ sessions: [{ session_id: 'sess-adv' }] }),
      getChatHistory: async () => [{ id: 1, role: 'user', content: '今天辛苦啦', timestamp: fixedNow - 10000, character_id: 'challenger-role', session_id: 'sess-adv' }],
      completions: {
        create: async request => {
          calls++;
          requests.push(request);
          return {
            choices: [{
              message: {
                content: JSON.stringify(
                  request.messages[0].content.includes('TASK:SCENE')
                    ? { scene: '角色坐在桌前整理笔记，目光平静柔和。' }
                    : (customDoc || { title: '日常手记', body: '今天整理了房间，读了半小时书。', summary: '整理房间并读书。' })
                )
              }
            }]
          };
        }
      }
    },
    personas: { get: async () => ({ name: '用户', description: '' }) },
    memories: {
      getTopMemories: async () => memories,
      list: async (_id, offset, limit) => memories.slice(offset, offset + limit),
      createOrUpdate: async rows => {
        const saved = rows.map(m => {
          if (m.id > 0) {
            const i = memories.findIndex(x => x.id === m.id);
            if (i < 0) throw new Error('missing memory id');
            memories[i] = { ...m };
            return memories[i];
          }
          creates++;
          const added = { ...m, id: 200 + memories.length };
          memories.push(added);
          return added;
        });
        return saved;
      }
    }
  };
  return {
    client,
    store: createStore(client),
    db,
    role,
    memories,
    requests,
    get creates() { return creates; },
    get calls() { return calls; },
    setDoc(d) { customDoc = d; }
  };
}

// =========================================================================
// DEFECT 3 ADVERSARIAL CHALLENGES: SQLite CAS Concurrency Protection
// =========================================================================

test('Defect 3 Empirical Challenge 1: Adversarial concurrent saveSettings (autoPlan: true, timezone: Asia/Tokyo) during getProfile legacy migration', async () => {
  const { db, client, store } = createMockStore();
  await store.init();

  const charId = 'char-cas-adv-1';
  const legacyProfile = {
    schema: 2,
    characterId: charId,
    name: '爱丽丝',
    settings: { timezone: 'Asia/Shanghai', autoPlan: false, sleepStart: '23:30', sleepEnd: '08:00' },
    state: { energy: 80 },
    plans: {
      '2026-11-01': { title: '历史日程1', mood: '平静', source: 'generated', nodes: templateItems('workday') },
      '2026-11-02': { title: '历史日程2', mood: '愉快', source: 'generated', nodes: templateItems('weekend') }
    }
  };

  // Insert raw legacy profile JSON into ll_profiles table
  await client.db.executeSql(SQL.putProfile, [charId, JSON.stringify(legacyProfile)]);

  let casStatementsSeen = 0;
  let concurrentWriteFired = false;
  const origExec = client.db.executeSql;

  client.db.executeSql = async (q, args) => {
    // Intercept when persistPlan begins writing the first plan into ll_plans
    if (!concurrentWriteFired && (q.includes('insertLegacyPlan') || q.includes('INSERT OR IGNORE INTO ll_plans'))) {
      concurrentWriteFired = true;
      // Adversarially simulate concurrent saveSettings modifying autoPlan: true, timezone: Asia/Tokyo
      const concurrentProfile = {
        ...legacyProfile,
        schema: 3,
        settings: {
          ...legacyProfile.settings,
          autoPlan: true,
          timezone: 'Asia/Tokyo'
        },
        state: { ...legacyProfile.state, energy: 95, customFlag: 'concurrent-ok' }
      };
      delete concurrentProfile.plans; // Normal saveSettings has no plans property
      await origExec(SQL.putProfile, [charId, JSON.stringify(concurrentProfile)]);
    }
    if (q === SQL.casProfile) {
      casStatementsSeen++;
    }
    return origExec(q, args);
  };

  const loaded = await store.getProfile(charId);

  // 1. Verify concurrent write was triggered
  assert.equal(concurrentWriteFired, true, 'Concurrent write must have triggered during migration');

  // 2. Verify CAS query was executed
  assert.ok(casStatementsSeen >= 1, 'SQL.casProfile must be called to attempt conditional update');

  // 3. Verify returned profile reflects concurrent settings (NOT stale legacy snapshot)
  assert.equal(loaded.settings.autoPlan, true, 'Returned profile must have autoPlan: true');
  assert.equal(loaded.settings.timezone, 'Asia/Tokyo', 'Returned profile must have timezone: Asia/Tokyo');
  assert.equal(loaded.state.customFlag, 'concurrent-ok', 'Returned profile must have concurrent state updates');
  assert.equal(loaded.state.energy, 95, 'Returned profile must have energy: 95');

  // 4. Verify DB row in ll_profiles retained concurrent settings and was not overwritten
  const row = db.prepare('SELECT data FROM ll_profiles WHERE character_id = ?').get(charId);
  const dbData = JSON.parse(row.data);
  assert.equal(dbData.settings.autoPlan, true, 'DB ll_profiles must retain autoPlan: true');
  assert.equal(dbData.settings.timezone, 'Asia/Tokyo', 'DB ll_profiles must retain timezone: Asia/Tokyo');
  assert.equal(dbData.state.customFlag, 'concurrent-ok', 'DB ll_profiles must retain concurrent customFlag');
  assert.equal(dbData.plans, undefined, 'DB ll_profiles must not have plans field');

  // 5. Verify both legacy plans were migrated into ll_plans table
  const p1 = await store.getPlan(charId, '2026-11-01');
  const p2 = await store.getPlan(charId, '2026-11-02');
  assert.ok(p1, 'Legacy plan 2026-11-01 must exist in ll_plans');
  assert.ok(p2, 'Legacy plan 2026-11-02 must exist in ll_plans');
  assert.equal(p1.title, '历史日程1');
  assert.equal(p2.title, '历史日程2');

  // 6. Verify returned profile.plans is populated from ll_plans
  assert.equal(loaded.plans['2026-11-01'].title, '历史日程1');
  assert.equal(loaded.plans['2026-11-02'].title, '历史日程2');

  db.close();
});

test('Defect 3 Empirical Challenge 2: Batch migration via store.profiles() preserves concurrent settings', async () => {
  const { db, client, store } = createMockStore();
  await store.init();

  const char1 = 'char-batch-1';
  const char2 = 'char-batch-2';

  const legacy1 = {
    schema: 2,
    characterId: char1,
    name: '角色一',
    settings: { timezone: 'Asia/Shanghai', autoPlan: false },
    plans: { '2026-11-01': { title: '计划1', mood: '平静', nodes: templateItems('workday') } }
  };
  const legacy2 = {
    schema: 2,
    characterId: char2,
    name: '角色二',
    settings: { timezone: 'Asia/Shanghai', autoPlan: false },
    plans: { '2026-11-01': { title: '计划2', mood: '平静', nodes: templateItems('workday') } }
  };

  await client.db.executeSql(SQL.putProfile, [char1, JSON.stringify(legacy1)]);
  await client.db.executeSql(SQL.putProfile, [char2, JSON.stringify(legacy2)]);

  let char2Interception = false;
  const origExec = client.db.executeSql;
  client.db.executeSql = async (q, args) => {
    // Intercept when char2 plan is being persisted
    if (!char2Interception && (q.includes('insertLegacyPlan') || q.includes('INSERT OR IGNORE INTO ll_plans')) && args.includes(char2)) {
      char2Interception = true;
      const updated2 = {
        ...legacy2,
        schema: 3,
        settings: { timezone: 'Asia/Seoul', autoPlan: true }
      };
      delete updated2.plans;
      await origExec(SQL.putProfile, [char2, JSON.stringify(updated2)]);
    }
    return origExec(q, args);
  };

  const allProfiles = await store.profiles();
  assert.equal(char2Interception, true, 'Concurrent update to char2 should have fired');

  const p2 = allProfiles.find(p => p.characterId === char2);
  assert.ok(p2, 'char2 must be returned in profiles list');
  assert.equal(p2.settings.autoPlan, true, 'p2 must have autoPlan: true');
  assert.equal(p2.settings.timezone, 'Asia/Seoul', 'p2 must have timezone: Asia/Seoul');

  const row2 = db.prepare('SELECT data FROM ll_profiles WHERE character_id = ?').get(char2);
  const dbData2 = JSON.parse(row2.data);
  assert.equal(dbData2.settings.autoPlan, true, 'DB ll_profiles for char2 must retain autoPlan: true');
  assert.equal(dbData2.settings.timezone, 'Asia/Seoul', 'DB ll_profiles for char2 must retain timezone: Asia/Seoul');

  db.close();
});

test('Defect 3 Empirical Challenge 3: Double concurrent getProfile() calls on same legacy profile (CAS race condition)', async () => {
  const { db, client, store } = createMockStore();
  await store.init();

  const charId = 'char-double-race';
  const legacyProfile = {
    schema: 2,
    characterId: charId,
    name: '竞态角色',
    settings: { timezone: 'Asia/Shanghai', autoPlan: false },
    plans: {
      '2026-11-01': { title: '并行计划', mood: '平静', nodes: templateItems('workday') }
    }
  };
  await client.db.executeSql(SQL.putProfile, [charId, JSON.stringify(legacyProfile)]);

  // Run two getProfile calls in parallel
  const [res1, res2] = await Promise.all([
    store.getProfile(charId),
    store.getProfile(charId)
  ]);

  // Both should succeed cleanly without crashing or corrupting
  assert.ok(res1);
  assert.ok(res2);
  assert.equal(res1.schema, 3);
  assert.equal(res2.schema, 3);
  assert.ok(res1.plans['2026-11-01']);
  assert.ok(res2.plans['2026-11-01']);

  const row = db.prepare('SELECT data FROM ll_profiles WHERE character_id = ?').get(charId);
  const dbData = JSON.parse(row.data);
  assert.equal(dbData.plans, undefined, 'll_profiles must have plans stripped');

  db.close();
});

// =========================================================================
// DEFECT 4 ADVERSARIAL CHALLENGES: Document Exception Safe Merge & Retry Cooldown Retention
// =========================================================================

test('Defect 4 Empirical Challenge 1: Plan generation fails, followed immediately by Document LLM generation failure: BOTH cooldowns retained', async () => {
  const f = createWorkflowFixture();
  await f.store.init();

  const p = createProfile(f.role, fixedNow);
  p.settings.background = true;
  p.settings.autoPlan = true;
  p.settings.planAheadHour = 20; // 20:00 < 22:00 -> preGenerate triggers
  p.settings.diaryHour = 21;     // 21:00 < 22:00 -> diary generation triggers
  await f.store.putProfile(p);

  // Simulate failures:
  // 1. generatePlan LLM call throws
  // 2. generateDocument LLM call throws
  f.client.chat.completions.create = async req => {
    if (req.messages[0].content.includes('TASK:PLAN') || req.messages[0].content.includes('TASK:SCHEDULE')) {
      throw new Error('LLM plan generator outage');
    }
    if (req.messages[0].content.includes('TASK:DIARY')) {
      throw new Error('LLM diary generator outage');
    }
    return { choices: [{ message: { content: '{}' } }] };
  };

  const res = await runBackground(f.client, f.store, { now: fixedNow });
  assert.equal(res.status, 'ok');

  // Verify resulting profile in store
  const savedProfile = await f.store.getProfile(f.role.id);

  assert.equal(savedProfile.state.tomorrowAttemptAt, fixedNow, 'tomorrowAttemptAt cooldown MUST be preserved');
  assert.equal(savedProfile.state.documentAttemptAt, fixedNow, 'documentAttemptAt cooldown MUST be recorded');
  assert.match(res.message, /次日日程暂未生成/);
  assert.match(res.message, /文稿生成或写入异常/);

  f.db.close();
});

test('Defect 4 Empirical Challenge 2: Plan generation fails, followed by Document Strict Wake Interception failure: BOTH cooldowns retained & draft kept', async () => {
  const f = createWorkflowFixture();
  await f.store.init();

  const p = createProfile(f.role, fixedNow);
  p.settings.background = true;
  p.settings.autoPlan = true;
  p.settings.autoWrite = true;   // autoWrite enabled
  p.settings.planAheadHour = 20; // 20:00 < 22:00 -> preGenerate triggers
  p.settings.diaryHour = 21;     // 21:00 < 22:00 -> diary triggers
  await f.store.putProfile(p);

  // Plan fails, diary generates draft with unconfirmed wake time ("09:15起床")
  f.client.chat.completions.create = async req => {
    if (req.messages[0].content.includes('TASK:PLAN')) {
      throw new Error('LLM plan generation failed');
    }
    if (req.messages[0].content.includes('TASK:DIARY')) {
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              title: '晨光与工作',
              body: '今天09:15起床，泡了咖啡开始写作。',
              summary: '09:15起床，喝咖啡写作。'
            })
          }
        }]
      };
    }
    return { choices: [{ message: { content: '{}' } }] };
  };

  const res = await runBackground(f.client, f.store, { now: fixedNow });
  assert.equal(res.status, 'ok');

  const savedProfile = await f.store.getProfile(f.role.id);

  // 1. Both cooldown timestamps must be intact
  assert.equal(savedProfile.state.tomorrowAttemptAt, fixedNow, 'tomorrowAttemptAt must not be clobbered by wake interception error');
  assert.equal(savedProfile.state.documentAttemptAt, fixedNow, 'documentAttemptAt must be recorded');

  // 2. Native memory write was blocked
  assert.equal(f.creates, 0, 'No native memory write should have occurred');

  // 3. Draft document preserved in local store
  const docs = await f.store.docs(f.role.id);
  const diaryDoc = docs.find(d => d.kind === 'diary');
  assert.ok(diaryDoc, 'Local diary draft must be preserved');
  assert.equal(diaryDoc.syncStatus, 'pending', 'Draft syncStatus must remain pending');

  // 4. Proper error recorded in runs
  const runs = (await f.store.runs(f.role.id)).map(r => r.data || r);
  const diaryRun = runs.find(r => r.status === 'error' && r.kind === 'diary');
  assert.ok(diaryRun, 'Error run record must be created');
  assert.match(diaryRun.message, /严格拦截写入原生记忆/);

  f.db.close();
});

test('Defect 4 Empirical Challenge 3: Subsequent runBackground invocation within 20min cooldown triggers ZERO duplicate attempts', async () => {
  const f = createWorkflowFixture();
  await f.store.init();

  const p = createProfile(f.role, fixedNow);
  p.settings.background = true;
  p.settings.autoPlan = true;
  p.settings.planAheadHour = 20;
  p.settings.diaryHour = 21;
  await f.store.putProfile(p);

  let llmAttempts = 0;
  f.client.chat.completions.create = async req => {
    llmAttempts++;
    f.requests.push(req);
    if (req.messages[0].content.includes('TASK:PLAN')) throw new Error('plan error');
    if (req.messages[0].content.includes('TASK:DIARY')) throw new Error('diary error');
    return { choices: [{ message: { content: '{}' } }] };
  };

  // First run at fixedNow: both fail and set cooldown
  await runBackground(f.client, f.store, { now: fixedNow });
  const attemptsAfterFirstRun = llmAttempts;
  assert.ok(attemptsAfterFirstRun > 0, 'First run must have attempted LLM generation');

  const profileAfter1st = await f.store.getProfile(f.role.id);
  assert.equal(profileAfter1st.state.tomorrowAttemptAt, fixedNow);
  assert.equal(profileAfter1st.state.documentAttemptAt, fixedNow);

  // Second run 5 minutes later (300,000 ms < 20 min cooldown)
  const fiveMinLater = fixedNow + 5 * 60 * 1000;
  const res2 = await runBackground(f.client, f.store, { now: fiveMinLater });

  // Verify that NO new LLM generation was attempted for plan or doc
  // (Notice: scene generation might or might not call completions depending on refreshLife, so check plan/diary specifically)
  const reqsSecondRun = f.requests.slice(attemptsAfterFirstRun);
  const planReqs = reqsSecondRun.filter(r => r.messages[0].content.includes('TASK:PLAN'));
  const diaryReqs = reqsSecondRun.filter(r => r.messages[0].content.includes('TASK:DIARY'));

  assert.equal(planReqs.length, 0, 'Zero plan LLM requests should be made within cooldown');
  assert.equal(diaryReqs.length, 0, 'Zero diary LLM requests should be made within cooldown');

  // Verify timestamps remain intact
  const profileAfter2nd = await f.store.getProfile(f.role.id);
  assert.equal(profileAfter2nd.state.tomorrowAttemptAt, fixedNow);
  assert.equal(profileAfter2nd.state.documentAttemptAt, fixedNow);

  // Third run 25 minutes later (1,500,000 ms > 20 min cooldown)
  const twentyFiveMinLater = fixedNow + 25 * 60 * 1000;
  await runBackground(f.client, f.store, { now: twentyFiveMinLater });

  const reqsThirdRun = f.requests.slice(attemptsAfterFirstRun);
  const planReqs3 = reqsThirdRun.filter(r => r.messages[0].content.includes('TASK:PLAN'));
  const diaryReqs3 = reqsThirdRun.filter(r => r.messages[0].content.includes('TASK:DIARY'));
  assert.ok(planReqs3.length > 0, 'Plan should retry after cooldown expires');
  assert.ok(diaryReqs3.length > 0, 'Diary should retry after cooldown expires');

  f.db.close();
});

test('Defect 4 Empirical Challenge 4: Concurrent state modification during document exception preserves concurrent state AND both cooldowns', async () => {
  const f = createWorkflowFixture();
  await f.store.init();

  const p = createProfile(f.role, fixedNow);
  p.settings.background = true;
  p.settings.autoPlan = true;
  p.settings.planAheadHour = 20;
  p.settings.diaryHour = 21;
  p.state.initialMetric = 100;
  await f.store.putProfile(p);

  // Intercept completion create:
  // 1. Plan fails
  // 2. When Diary fails, simulate concurrent task modifying store profile with concurrentMetric: 999
  f.client.chat.completions.create = async req => {
    if (req.messages[0].content.includes('TASK:PLAN')) {
      throw new Error('LLM plan generation failed');
    }
    if (req.messages[0].content.includes('TASK:DIARY')) {
      // Simulate concurrent task updating profile
      const current = await f.store.getProfile(f.role.id);
      current.state.concurrentMetric = 999;
      await f.store.putProfile(current);
      throw new Error('LLM diary generation failed');
    }
    return { choices: [{ message: { content: '{}' } }] };
  };

  const res = await runBackground(f.client, f.store, { now: fixedNow });
  assert.equal(res.status, 'ok');

  const finalProfile = await f.store.getProfile(f.role.id);

  // Assertions:
  // 1. tomorrowAttemptAt is preserved
  assert.equal(finalProfile.state.tomorrowAttemptAt, fixedNow, 'tomorrowAttemptAt must be preserved');
  // 2. documentAttemptAt is recorded
  assert.equal(finalProfile.state.documentAttemptAt, fixedNow, 'documentAttemptAt must be recorded');
  // 3. concurrent state is merged and preserved
  assert.equal(finalProfile.state.concurrentMetric, 999, 'concurrentMetric must be preserved via lock-protected safe merge');
  assert.equal(finalProfile.state.initialMetric, 100, 'initialMetric must be preserved');

  f.db.close();
});

test('Defect 4 Empirical Challenge 5: Morning Dream generation exception preserves tomorrowAttemptAt from previous night', async () => {
  const f = createWorkflowFixture();
  await f.store.init();

  const morningNow = epoch('2026-11-02', 9 * 60); // 09:00 AM next morning
  const lastNightPlanFailureAt = morningNow - 11 * 3600000; // 22:00 previous night

  const p = createProfile(f.role, morningNow);
  p.settings.background = true;
  p.settings.autoPlan = false;
  p.settings.diaryHour = 21; // 21:00 > 09:00, not diary time
  p.state.tomorrowAttemptAt = lastNightPlanFailureAt; // from previous night
  p.state.lastSleepEnd = morningNow - 3600000; // woke up 1 hour ago
  p.state.recentSleepHours = 8; // >= 3h, qualifies for dream generation
  await f.store.putProfile(p);

  // Force dream generation to fail
  f.client.chat.completions.create = async req => {
    if (req.messages[0].content.includes('TASK:DREAM')) {
      throw new Error('LLM dream generation failed');
    }
    return { choices: [{ message: { content: '{}' } }] };
  };

  const res = await runBackground(f.client, f.store, { now: morningNow });
  assert.equal(res.status, 'ok');

  const finalProfile = await f.store.getProfile(f.role.id);

  // Verify dream failure preserved previous tomorrowAttemptAt
  assert.equal(finalProfile.state.tomorrowAttemptAt, lastNightPlanFailureAt, 'Previous tomorrowAttemptAt must NOT be lost');
  assert.equal(finalProfile.state.documentAttemptAt, morningNow, 'documentAttemptAt must be set to morningNow');

  // Verify error run was logged for dream
  const runs = (await f.store.runs(f.role.id)).map(r => r.data || r);
  const dreamRun = runs.find(r => r.status === 'error' && r.kind === 'dream');
  assert.ok(dreamRun, 'Error run record must exist for dream');

  f.db.close();
});

test('Defect 3 Empirical Challenge 4: createMockSQL (demo environment) handles CAS concurrency correctly', async () => {
  const charId = 'char-mocksql-cas';
  const initialData = {
    profiles: {
      [charId]: {
        schema: 2,
        characterId: charId,
        name: '演示角色',
        settings: { timezone: 'Asia/Shanghai', autoPlan: false },
        plans: {
          '2026-11-01': { title: '演示计划', mood: '平静', nodes: templateItems('workday') }
        }
      }
    },
    documents: {},
    runs: {},
    locks: {},
    scenes: {},
    plans: {}
  };

  const mockDb = createMockSQL(initialData);
  let concurrentUpdateDone = false;

  const client = {
    db: {
      executeSql: async (q, args = []) => {
        // Intercept when persistPlan writes into ll_plans
        if (!concurrentUpdateDone && (q.includes('insertLegacyPlan') || q.includes('INSERT OR IGNORE INTO ll_plans'))) {
          concurrentUpdateDone = true;
          // Concurrent settings save
          const concurrentProfile = {
            ...initialData.profiles[charId],
            schema: 3,
            settings: { autoPlan: true, timezone: 'Asia/Tokyo' }
          };
          delete concurrentProfile.plans;
          mockDb.execute(SQL.putProfile, [charId, JSON.stringify(concurrentProfile)]);
        }
        return mockDb.execute(q, args);
      }
    }
  };

  const store = createStore(client);
  await store.init();

  const loaded = await store.getProfile(charId);

  assert.equal(concurrentUpdateDone, true, 'Concurrent write must trigger in mock SQL');
  assert.equal(loaded.settings.autoPlan, true, 'Mock SQL must retain autoPlan: true');
  assert.equal(loaded.settings.timezone, 'Asia/Tokyo', 'Mock SQL must retain timezone: Asia/Tokyo');
  assert.ok(loaded.plans['2026-11-01'], 'Legacy plan must be migrated in mock SQL');
  assert.equal(initialData.profiles[charId].settings.autoPlan, true, 'Stored data must retain autoPlan: true');
  assert.equal(initialData.profiles[charId].plans, undefined, 'Stored data must have plans stripped');
});

test('Defect 4 Empirical Challenge 6: Tomorrow Plan succeeds, Document fails: Tomorrow plan preserved and documentAttemptAt recorded', async () => {
  const f = createWorkflowFixture();
  await f.store.init();

  const p = createProfile(f.role, fixedNow);
  p.settings.background = true;
  p.settings.autoPlan = true;
  p.settings.planAheadHour = 20; // 20:00 < 22:00 -> preGenerate triggers
  p.settings.diaryHour = 21;     // 21:00 < 22:00 -> diary triggers
  await f.store.putProfile(p);

  // Plan succeeds, Diary fails
  f.client.chat.completions.create = async req => {
    if (req.messages[0].content.includes('TASK:PLAN')) {
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              title: '明日精彩行程',
              mood: '期待',
              nodes: templateItems('workday')
            })
          }
        }]
      };
    }
    if (req.messages[0].content.includes('TASK:DIARY')) {
      throw new Error('LLM diary failure');
    }
    return { choices: [{ message: { content: '{}' } }] };
  };

  const res = await runBackground(f.client, f.store, { now: fixedNow });
  assert.equal(res.status, 'ok');

  const finalProfile = await f.store.getProfile(f.role.id);

  // 1. Tomorrow plan must be successfully created and saved in ll_plans
  const tomorrowDay = '2026-11-02';
  const savedPlan = await f.store.getPlan(f.role.id, tomorrowDay);
  assert.ok(savedPlan, 'Tomorrow plan must exist in store');
  assert.equal(savedPlan.title, '明日精彩行程');

  // 2. documentAttemptAt must be recorded
  assert.equal(finalProfile.state.documentAttemptAt, fixedNow, 'documentAttemptAt must be recorded');

  // 3. tomorrowAttemptAt should NOT be set since plan succeeded
  assert.equal(finalProfile.state.tomorrowAttemptAt, undefined, 'tomorrowAttemptAt should not be set when plan succeeds');

  f.db.close();
});

