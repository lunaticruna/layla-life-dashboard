import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import { createProfile, epoch } from '../src/core.js';
import { templateItems } from '../src/schedule.js';

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

test('Migration R2: legacy profile with profile.plans automatically migrates into ll_plans and bumps schema to 3', async () => {
  const { db, client, store } = createMockStore();
  await store.init();

  const characterId = 'char-legacy-mig';
  const now = epoch('2026-11-01', 12 * 60);

  // 1. Construct a legacy Schema v2 profile containing multiple days in profile.plans
  const legacyProfile = {
    schema: 2,
    characterId,
    name: '澪',
    settings: {
      timezone: 'Asia/Shanghai',
      sleepStart: '23:30',
      sleepEnd: '08:00',
      home: '公寓'
    },
    state: {},
    plans: {
      '2026-10-30': {
        title: '整理旧书与写作',
        mood: '专注',
        source: 'manual',
        nodes: [
          { start: 0, end: 480, kind: 'sleep', summary: '睡眠' },
          { start: 480, end: 720, kind: 'work', summary: '整理旧书' },
          { start: 720, end: 1440, kind: 'sleep', summary: '休息' }
        ]
      },
      '2026-10-31': {
        title: '万圣节街区漫步',
        mood: '好奇',
        source: 'generated',
        nodes: templateItems('outing')
      },
      '2026-11-01': {
        title: '十一月的第一天',
        mood: '平静',
        source: 'generated',
        nodes: templateItems('restday')
      }
    }
  };

  // Directly insert raw legacy profile JSON into database without going through store.putProfile
  await client.db.executeSql(
    `INSERT INTO ll_profiles (character_id, data) VALUES (?, ?)`,
    [characterId, JSON.stringify(legacyProfile)]
  );

  // Verify ll_plans table is currently empty
  const initialPlans = await store.plans(characterId);
  assert.equal(initialPlans.length, 0, 'll_plans must be empty prior to profile loading');

  // 2. Load the profile via store.getProfile (triggers automatic migration)
  const loadedProfile = await store.getProfile(characterId);
  assert.ok(loadedProfile);
  assert.equal(loadedProfile.schema, 3, 'Schema must be bumped to 3');

  // 3. Verify all historical days were migrated into ll_plans table
  const migratedPlans = await store.plans(characterId);
  assert.equal(migratedPlans.length, 3, 'All 3 legacy plans must be migrated into ll_plans');

  const days = migratedPlans.map(p => p.day).sort();
  assert.deepEqual(days, ['2026-10-30', '2026-10-31', '2026-11-01']);

  // Check details of migrated plan
  const plan30 = await store.getPlan(characterId, '2026-10-30');
  assert.ok(plan30);
  assert.equal(plan30.title, '整理旧书与写作');
  assert.equal(plan30.mood, '专注');
  assert.equal(plan30.source, 'manual');
  assert.equal(plan30.nodes.length, 3);
  assert.equal(plan30.nodes[1].summary, '整理旧书');

  // 4. Verify backward-compatible accessor: profile.plans remains fully accessible
  assert.ok(loadedProfile.plans);
  assert.ok(loadedProfile.plans['2026-10-30']);
  assert.equal(loadedProfile.plans['2026-10-30'].title, '整理旧书与写作');
  assert.ok(loadedProfile.plans['2026-10-31']);
  assert.ok(loadedProfile.plans['2026-11-01']);

  db.close();
});

test('Migration R2: migration is idempotent and does not overwrite existing records in ll_plans', async () => {
  const { db, client, store } = createMockStore();
  await store.init();

  const characterId = 'char-idempotent';
  const day = '2026-11-01';

  // Seed an existing plan in ll_plans with newer edits
  await store.savePlan({
    characterId,
    day,
    title: '用户最新编辑的计划',
    mood: '兴奋',
    dayType: 'outing',
    source: 'manual',
    nodes: templateItems('outing')
  });

  // Legacy profile has an older/stale version of the same day in profile.plans
  const legacyProfile = {
    schema: 2,
    characterId,
    name: '澪',
    settings: { timezone: 'Asia/Shanghai' },
    state: {},
    plans: {
      [day]: {
        title: '陈旧的计划',
        mood: '无聊',
        source: 'template',
        nodes: templateItems('workday')
      }
    }
  };

  await client.db.executeSql(
    `INSERT INTO ll_profiles (character_id, data) VALUES (?, ?)`,
    [characterId, JSON.stringify(legacyProfile)]
  );

  // Load profile multiple times
  const p1 = await store.getProfile(characterId);
  const p2 = await store.getProfile(characterId);

  // Existing plan in ll_plans must NOT be overwritten by stale profile.plans
  const currentPlan = await store.getPlan(characterId, day);
  assert.equal(currentPlan.title, '用户最新编辑的计划');
  assert.equal(currentPlan.mood, '兴奋');

  // Verify profile.plans[day] reflects the existing authoritative plan
  assert.equal(p1.plans[day].title, '用户最新编辑的计划');
  assert.equal(p2.plans[day].title, '用户最新编辑的计划');

  db.close();
});

test('Migration R2: profiles without plans or with empty plans migrate cleanly without error', async () => {
  const { db, client, store } = createMockStore();
  await store.init();

  const characterId = 'char-empty-plans';
  const legacyProfile = {
    schema: 1,
    characterId,
    name: '空计划角色',
    settings: { timezone: 'Asia/Shanghai' },
    state: {},
    plans: null
  };

  await client.db.executeSql(
    `INSERT INTO ll_profiles (character_id, data) VALUES (?, ?)`,
    [characterId, JSON.stringify(legacyProfile)]
  );

  const loaded = await store.getProfile(characterId);
  assert.ok(loaded);
  assert.equal(loaded.schema, 3);
  assert.ok(typeof loaded.plans === 'object' && loaded.plans !== null);

  const plansList = await store.plans(characterId);
  assert.equal(plansList.length, 0);

  db.close();
});
