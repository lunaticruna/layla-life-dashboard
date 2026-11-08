import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore, SQL } from '../src/store.js';
import { createProfile, epoch, VERSION } from '../src/core.js';
import { templateItems } from '../src/schedule.js';
import { exportCharacterBackup, fetchAllNativeMemories } from '../src/export.js';
import { crc32 } from '../src/zip.js';

/**
 * Pure JavaScript PKZIP parser for verifying ZIP archives down to byte-level headers.
 */
function parseZipArchive(input) {
  const bytes = typeof input === 'string'
    ? Buffer.from(input, 'base64')
    : (input instanceof Uint8Array ? input : new Uint8Array(input));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('PKZIP End of Central Directory signature (0x06054b50) not found');
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const startDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const entries = [];
  const files = {};
  const decoder = new TextDecoder('utf-8');

  let curr = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    const cdSig = view.getUint32(curr, true);
    if (cdSig !== 0x02014b50) {
      throw new Error(`Invalid Central Directory header signature 0x${cdSig.toString(16)} at offset ${curr}`);
    }

    const versionMadeBy = view.getUint16(curr + 4, true);
    const versionNeeded = view.getUint16(curr + 6, true);
    const flags = view.getUint16(curr + 8, true);
    const method = view.getUint16(curr + 10, true);
    const modTime = view.getUint16(curr + 12, true);
    const modDate = view.getUint16(curr + 14, true);
    const crc = view.getUint32(curr + 16, true);
    const compSize = view.getUint32(curr + 20, true);
    const uncompSize = view.getUint32(curr + 24, true);
    const nameLen = view.getUint16(curr + 28, true);
    const extraLen = view.getUint16(curr + 30, true);
    const commentLen = view.getUint16(curr + 32, true);
    const localHeaderOffset = view.getUint32(curr + 42, true);

    const nameBytes = bytes.subarray(curr + 46, curr + 46 + nameLen);
    const name = decoder.decode(nameBytes);

    const localSig = view.getUint32(localHeaderOffset, true);
    if (localSig !== 0x04034b50) {
      throw new Error(`Invalid Local File Header signature 0x${localSig.toString(16)} for "${name}" at offset ${localHeaderOffset}`);
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);

    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const fileBytes = bytes.subarray(dataStart, dataStart + uncompSize);
    const text = decoder.decode(fileBytes);

    const entry = {
      name,
      method,
      crc,
      compSize,
      uncompSize,
      localHeaderOffset,
      bytes: fileBytes,
      text,
      json: () => JSON.parse(text)
    };

    entries.push(entry);
    files[name] = entry;

    curr += 46 + nameLen + extraLen + commentLen;
  }

  return {
    eocd: { diskNumber, startDisk, entriesOnDisk, totalEntries, cdSize, cdOffset, eocdOffset },
    entries,
    files
  };
}

function createMockEnvironment(characterOverride = null) {
  const db = new DatabaseSync(':memory:');
  const character = characterOverride || {
    id: 'char-adv-test',
    data: {
      data: {
        name: '对决测试角色·澪',
        description: '用于高并发、幂等性与 PKZIP 规范压力测试。'
      }
    }
  };

  const nativeMemories = [];

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
    memories: {
      list: async (characterId, offset = 0, limit = 50) => {
        const matching = nativeMemories.filter(m => m.character_id === characterId);
        return matching.slice(offset, offset + limit);
      }
    }
  };

  const store = createStore(client);
  return { db, client, store, character, nativeMemories };
}

/**
 * Generate N ISO days starting from a given date string.
 */
function generateDays(startDateStr, count) {
  const days = [];
  const start = new Date(`${startDateStr}T00:00:00Z`).getTime();
  for (let i = 0; i < count; i++) {
    const d = new Date(start + i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

test('Challenger Stress Test 1: Archive Migration 55-day Idempotency & High Concurrency (20 concurrent calls)', async t => {
  const env = createMockEnvironment();
  t.after(() => env.db.close());
  await env.store.init();

  const characterId = env.character.id;
  const days = generateDays('2026-08-01', 55); // 55 days: 2026-08-01 to 2026-09-24
  assert.equal(days.length, 55);

  // 1. Construct a legacy Profile v2 with 55 days in profile.plans
  const legacyPlans = {};
  const dayTypes = ['workday', 'restday', 'outing', 'slacking', 'overtime'];
  const moods = ['专注', '轻快', '疲惫', '悠闲', '平静'];

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const type = dayTypes[i % dayTypes.length];
    const mood = moods[i % moods.length];
    legacyPlans[day] = {
      title: `历史日程第 ${i + 1} 天: ${type}`,
      mood,
      dayType: i % 2 === 0 ? type : { id: type, name: `${type}模式` },
      source: i % 3 === 0 ? 'manual' : (i % 3 === 1 ? 'generated' : 'template'),
      generatedAt: epoch(day, 8 * 60),
      nodes: templateItems(type),
      changes: i % 4 === 0 ? [
        {
          at: epoch(day, 14 * 60),
          start: '14:00',
          end: '15:30',
          summary: `紧急调整 #${i}`,
          detail: '区间变更测试记录'
        }
      ] : []
    };
  }

  const legacyProfile = {
    schema: 2,
    characterId,
    name: '对决测试角色·澪',
    settings: {
      timezone: 'Asia/Shanghai',
      sleepStart: '23:30',
      sleepEnd: '08:00',
      home: '对决测试公寓'
    },
    state: { energy: 75, hunger: 30, mood: 0.2 },
    plans: legacyPlans
  };

  // Directly insert raw legacy profile JSON into database table ll_profiles
  await env.client.db.executeSql(
    `INSERT INTO ll_profiles (character_id, data) VALUES (?, ?)`,
    [characterId, JSON.stringify(legacyProfile)]
  );

  // Verify ll_plans is empty before migration
  const countBefore = await env.client.db.executeSql(
    `SELECT count(*) as cnt FROM ll_plans WHERE character_id = ?`,
    [characterId]
  );
  assert.equal(countBefore.rows[0].cnt, 0, 'll_plans must be 0 prior to migration');

  // 2. TRIGGER HIGH CONCURRENCY: 20 simultaneous calls to store.getProfile
  const concurrencyCount = 20;
  const promises = Array.from({ length: concurrencyCount }, () => env.store.getProfile(characterId));
  const results = await Promise.all(promises);

  // 3. ASSERT IDEMPOTENCY & STABILITY
  assert.equal(results.length, concurrencyCount);
  for (const prof of results) {
    assert.ok(prof, 'Profile must not be null');
    assert.equal(prof.schema, 3, 'Profile schema must be upgraded to 3');
    assert.equal(prof.characterId, characterId);
    assert.equal(Object.keys(prof.plans).length, 55, 'Profile plans accessor must contain all 55 days');
  }

  // 4. ASSERT EXACT ROW COUNT IN ll_plans: EXACTLY 55 ROWS, NO DUPLICATE KEYS
  const countAfter = await env.client.db.executeSql(
    `SELECT count(*) as cnt FROM ll_plans WHERE character_id = ?`,
    [characterId]
  );
  assert.equal(countAfter.rows[0].cnt, 55, 'll_plans must contain exactly 55 migrated rows without duplicate collisions');

  // Assert all 55 days are present in ll_plans
  const allMigratedPlans = await env.store.plans(characterId, { limit: 100 });
  assert.equal(allMigratedPlans.length, 55, 'store.plans must return all 55 plans');

  const migratedDays = allMigratedPlans.map(p => p.day).sort();
  assert.deepEqual(migratedDays, days.slice().sort(), 'All 55 days must match perfectly');

  // Check specific day data integrity
  const dayToCheck = days[10];
  const plan10 = await env.store.getPlan(characterId, dayToCheck);
  assert.ok(plan10);
  assert.equal(plan10.title, legacyPlans[dayToCheck].title);
  assert.equal(plan10.mood, legacyPlans[dayToCheck].mood);
  assert.equal(plan10.nodes.length, legacyPlans[dayToCheck].nodes.length);
  assert.equal(plan10.source, legacyPlans[dayToCheck].source);

  // 5. TEST RE-EXECUTION IDEMPOTENCY (Sequential calls)
  for (let run = 0; run < 3; run++) {
    const seqProf = await env.store.getProfile(characterId);
    assert.equal(seqProf.schema, 3);
    assert.equal(Object.keys(seqProf.plans).length, 55);
  }

  const countAfterSeq = await env.client.db.executeSql(
    `SELECT count(*) as cnt FROM ll_plans WHERE character_id = ?`,
    [characterId]
  );
  assert.equal(countAfterSeq.rows[0].cnt, 55, 'Sequential re-runs must remain strictly 55 rows');

  // 6. PERSISTENCE CHECK: saveProfile persists schema 3 in ll_profiles
  const profileToSave = results[0];
  await env.store.saveProfile(profileToSave);

  const rawSavedRow = await env.client.db.executeSql(
    `SELECT data FROM ll_profiles WHERE character_id = ?`,
    [characterId]
  );
  const parsedSavedProfile = JSON.parse(rawSavedRow.rows[0].data);
  assert.equal(parsedSavedProfile.schema, 3, 'Persisted profile schema must be 3 in ll_profiles table');
});

test('Challenger Stress Test 2: Migration Partial Conflict & Authoritative Non-Overwrite', async t => {
  const env = createMockEnvironment();
  t.after(() => env.db.close());
  await env.store.init();

  const characterId = 'char-partial-conflict';
  const dayConflicted = '2026-08-15';
  const dayFresh = '2026-08-16';

  // Seed an existing edited plan directly into ll_plans first
  await env.store.savePlan({
    characterId,
    day: dayConflicted,
    title: '用户在独立表中编辑的高优先级计划',
    mood: '极佳',
    dayType: 'outing',
    source: 'manual',
    nodes: templateItems('outing')
  });

  // Legacy profile in ll_profiles contains stale data for dayConflicted AND fresh data for dayFresh
  const legacyProfile = {
    schema: 2,
    characterId,
    name: '冲突测试角色',
    settings: { timezone: 'Asia/Shanghai' },
    state: {},
    plans: {
      [dayConflicted]: {
        title: '旧版陈旧计划 (必须被丢弃/不覆盖)',
        mood: '糟糕',
        source: 'template',
        nodes: templateItems('workday')
      },
      [dayFresh]: {
        title: '旧版新鲜计划 (应正常迁移)',
        mood: '平静',
        source: 'generated',
        nodes: templateItems('restday')
      }
    }
  };

  await env.client.db.executeSql(
    `INSERT INTO ll_profiles (character_id, data) VALUES (?, ?)`,
    [characterId, JSON.stringify(legacyProfile)]
  );

  // Concurrently load profile 5 times
  await Promise.all(Array.from({ length: 5 }, () => env.store.getProfile(characterId)));

  // Verify ll_plans has 2 plans
  const plans = await env.store.plans(characterId);
  assert.equal(plans.length, 2);

  // Conflicted day must preserve authoritative plan
  const planConflicted = await env.store.getPlan(characterId, dayConflicted);
  assert.equal(planConflicted.title, '用户在独立表中编辑的高优先级计划');
  assert.equal(planConflicted.mood, '极佳');

  // Fresh day must have been cleanly migrated
  const planFresh = await env.store.getPlan(characterId, dayFresh);
  assert.equal(planFresh.title, '旧版新鲜计划 (应正常迁移)');

  // Now perform an applyPlanChange on the migrated fresh day
  const updatedPlan = await env.store.applyPlanChange(characterId, dayFresh, {
    start: '09:00',
    end: '10:00',
    summary: '临时插入晨间会议'
  });
  assert.ok(updatedPlan.changes.length > 0);

  // Call getProfile again to verify idempotent migration does NOT revert applyPlanChange
  const reloaded = await env.store.getProfile(characterId);
  assert.equal(reloaded.plans[dayFresh].changes.length, 1);
  assert.equal(reloaded.plans[dayFresh].changes[0].summary, '临时插入晨间会议');
});

test('Challenger Stress Test 3: Export Format PKZIP Deep Byte Verification, Checksums & Spec v1.1.0', async t => {
  const env = createMockEnvironment();
  t.after(() => env.db.close());
  await env.store.init();

  const characterId = env.character.id;
  const fixedNow = epoch('2026-11-01', 22 * 60);

  // 1. Profile
  const profile = createProfile(env.character, fixedNow);
  profile.settings.timezone = 'Asia/Shanghai';
  profile.settings.sleepStart = '23:30';
  profile.settings.sleepEnd = '08:00';
  profile.settings.home = '测试研究中心';
  await env.store.putProfile(profile);

  // 2. Seed 55 plans in ll_plans
  const days = generateDays('2026-08-01', 55);
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    await env.store.savePlan({
      characterId,
      day,
      title: `计划日 #${i + 1}`,
      mood: i % 2 === 0 ? '专注' : '轻快',
      dayType: i % 2 === 0 ? 'workday' : 'restday',
      source: 'generated',
      generatedAt: fixedNow - (55 - i) * 86400000,
      nodes: templateItems(i % 2 === 0 ? 'workday' : 'restday'),
      changes: i === 0 ? [{ at: fixedNow, start: '14:00', end: '15:00', summary: '区间测试' }] : []
    });
  }

  // 3. Seed 5 documents
  const kinds = ['diary', 'dream', 'reflection', 'work', 'diary'];
  for (let i = 0; i < kinds.length; i++) {
    await env.store.putDoc({
      id: `doc-${i}`,
      characterId,
      sessionId: 'session-main',
      kind: kinds[i],
      day: days[i],
      title: `文稿标题 #${i}`,
      body: `这是文稿 #${i} 的正文内容，记录生活细节与反思。`,
      summary: `文稿 #${i} 摘要`,
      createdAt: fixedNow - i * 3600000,
      syncStatus: 'written',
      graphVerifiedJSON: JSON.stringify([
        { subject: `文稿实体#${i}`, relationship: '记录中动作', object: `行为#${i}` }
      ])
    });
  }

  // 4. Seed 5 scenes
  for (let i = 0; i < 5; i++) {
    await env.store.putScene({
      id: `scene-${i}`,
      characterId,
      key: `key-${i}`,
      day: days[i],
      generatedAt: fixedNow - i * 1800000,
      start: fixedNow - (i + 1) * 1800000,
      end: fixedNow - i * 1800000,
      phase: 'awake',
      summary: `微观场景概要 #${i}`,
      location: '书房',
      scene: `微观场景描写正文内容，详细刻画环境、光影与生理状态 #${i}。`
    });
  }

  // 5. Seed 30 runs
  for (let i = 0; i < 30; i++) {
    await env.store.addRun({
      id: `run-${i}`,
      characterId,
      at: fixedNow - i * 100000,
      kind: 'scene',
      status: 'ok',
      message: `后台运行流水 #${i}`
    });
  }

  // 6. Seed 15 native memories
  for (let i = 0; i < 15; i++) {
    env.nativeMemories.push({
      id: 800 + i,
      character_id: characterId,
      session_id: 'session-host',
      timestamp: fixedNow - i * 60000,
      rawText: `宿主原生记忆 #${i}`,
      summary: `原生记忆摘要 #${i}`
    });
  }

  // 7. GENERATE BACKUP
  const state = { character: env.character };
  const exportResult = await exportCharacterBackup(state, env.store, env.client, { now: fixedNow });

  // 8. VERIFY PKZIP BYTE STREAM INTEGRITY
  assert.equal(exportResult.isZip, true, 'Export must default to PKZIP archive');
  assert.equal(exportResult.filename, `life-backup-${characterId}-${fixedNow}.zip`);

  const rawBytes = Buffer.from(exportResult.base64, 'base64');
  assert.ok(rawBytes.length > 500);

  // Parse archive and verify structures
  const parsed = parseZipArchive(rawBytes);

  // EOCD verification
  assert.ok(parsed.eocd.eocdOffset > 0, 'EOCD offset must be valid');
  assert.equal(parsed.entries.length, 9, 'Must contain exactly 9 canonical archive sub-files');
  assert.equal(parsed.eocd.totalEntries, 9);

  // Byte-level CRC-32 & Local File Header verification
  for (const entry of parsed.entries) {
    assert.equal(entry.method, 0, `Entry ${entry.name} must be Method 0 (STORE)`);
    const expectedCrc = crc32(entry.bytes);
    assert.equal(entry.crc, expectedCrc, `Entry ${entry.name} CRC-32 mismatch`);
    assert.doesNotThrow(() => JSON.parse(entry.text), `Entry ${entry.name} must be valid JSON`);
  }

  // 9. VERIFY schedules/plans.json SPEC v1.1.0 COMPLIANCE
  assert.ok(parsed.files['schedules/plans.json'], 'schedules/plans.json must be present in archive');
  const exportedPlans = parsed.files['schedules/plans.json'].json();

  assert.equal(Array.isArray(exportedPlans), true, 'schedules/plans.json must be an array of PlanRecord');
  assert.equal(exportedPlans.length, 55, 'All 55 plans must be exported in schedules/plans.json');

  // Verify atomic fields of each PlanRecord conforming to EXPORT_FORMAT_SPEC.md Section 4.4
  for (const plan of exportedPlans) {
    assert.ok(typeof plan.id === 'string' && plan.id.length > 0, 'Plan id must be non-empty string');
    assert.equal(plan.characterId, characterId, 'Plan characterId must match');
    assert.match(plan.day, /^\d{4}-\d{2}-\d{2}$/, 'Plan day must be YYYY-MM-DD');
    assert.ok(typeof plan.title === 'string', 'Plan title must be string');
    assert.ok(typeof plan.mood === 'string', 'Plan mood must be string');
    assert.ok(plan.dayType !== undefined, 'Plan dayType must be present');
    assert.ok(typeof plan.source === 'string', 'Plan source must be string');
    assert.ok(Number.isFinite(plan.generatedAt), 'Plan generatedAt must be finite timestamp');
    assert.ok(Array.isArray(plan.changes), 'Plan changes must be array');
    assert.ok(Array.isArray(plan.nodes), 'Plan nodes must be array');
    assert.ok(plan.nodes.length >= 2, 'Plan nodes must have at least 2 nodes covering the day');

    // Verify first and last node span 00:00 to 24:00
    assert.equal(plan.nodes[0].start, 0, 'First node must start at 0');
    assert.equal(plan.nodes[plan.nodes.length - 1].end, 1440, 'Last node must end at 1440 (24:00)');

    for (const node of plan.nodes) {
      assert.ok(typeof node.id === 'string', 'Node id must be string');
      assert.ok(Number.isFinite(node.start), 'Node start must be finite number');
      assert.ok(Number.isFinite(node.end), 'Node end must be finite number');
      assert.ok(node.end > node.start, 'Node end must be strictly greater than start');
      assert.ok(['sleep', 'nap', 'meal', 'work', 'study', 'travel', 'leisure', 'rest'].includes(node.kind), `Invalid node kind: ${node.kind}`);
      assert.ok(typeof node.summary === 'string' && node.summary.length > 0, 'Node summary must be non-empty');
      assert.ok(typeof node.location === 'string', 'Node location must be string');
    }
  }

  // 10. VERIFY manifest.json SPEC v1.1.0 METADATA & RECORD COUNTS
  assert.ok(parsed.files['manifest.json'], 'manifest.json must be present');
  const manifest = parsed.files['manifest.json'].json();

  assert.equal(manifest.specVersion, '1.1.0', 'manifest.specVersion must be 1.1.0');
  assert.equal(manifest.exportVersion, '1.1.0', 'manifest.exportVersion must be 1.1.0');
  assert.equal(manifest.appVersion, VERSION, 'manifest.appVersion must match VERSION');
  assert.equal(manifest.version, VERSION, 'manifest.version must match VERSION');
  assert.equal(manifest.characterId, characterId);
  assert.equal(manifest.characterName, '对决测试角色·澪');

  assert.deepEqual(manifest.recordCounts, {
    documents: 5,
    scenes: 5,
    runs: 30,
    triples: 5,
    nativeMemories: 15,
    plans: 55
  }, 'manifest.recordCounts must match seeded counts exactly');

  assert.equal(manifest.summary.planCount, 55, 'manifest.summary.planCount must be 55');
  assert.equal(manifest.summary.documentCount, 5);
  assert.equal(manifest.summary.sceneCount, 5);
  assert.equal(manifest.summary.runCount, 30);
  assert.equal(manifest.summary.nativeMemoryCount, 15);

  const manifestPlansFile = manifest.files.find(f => f.path === 'schedules/plans.json');
  assert.ok(manifestPlansFile, 'manifest.files must declare schedules/plans.json');
});

test('Challenger Stress Test 4: JSON Fallback Mode (Explicit forceJson & Exception Fallback)', async t => {
  const env = createMockEnvironment();
  t.after(() => env.db.close());
  await env.store.init();

  const characterId = env.character.id;
  const fixedNow = epoch('2026-11-01', 12 * 60);

  // Seed 5 plans
  const days = generateDays('2026-11-01', 5);
  for (const day of days) {
    await env.store.savePlan({
      characterId,
      day,
      title: `测试计划 ${day}`,
      mood: '平静',
      dayType: 'workday',
      nodes: templateItems('workday')
    });
  }

  // 1. Explicit forceJson: true
  const fallbackResult = await exportCharacterBackup(
    { character: env.character },
    env.store,
    env.client,
    { now: fixedNow, forceJson: true }
  );

  assert.equal(fallbackResult.isZip, false, 'forceJson must yield isZip === false');
  assert.equal(fallbackResult.filename, `life-backup-${characterId}-${fixedNow}.json`);

  const fallbackJsonStr = Buffer.from(fallbackResult.base64, 'base64').toString('utf-8');
  const fallbackData = JSON.parse(fallbackJsonStr);

  // Verify spec versions in fallback JSON
  assert.equal(fallbackData.specVersion, '1.1.0', 'Fallback JSON must have specVersion 1.1.0');
  assert.equal(fallbackData.exportVersion, '1.1.0', 'Fallback JSON must have exportVersion 1.1.0');
  assert.equal(fallbackData.archiveMode, 'json_fallback');

  // Verify root plans array
  assert.ok(Array.isArray(fallbackData.plans), 'Fallback JSON must have plans array at root');
  assert.equal(fallbackData.plans.length, 5, 'Fallback JSON plans must have all 5 plans');
  for (const p of fallbackData.plans) {
    assert.equal(p.characterId, characterId);
    assert.ok(p.nodes.length >= 2);
  }

  // Verify fallback manifest
  assert.equal(fallbackData.manifest.archiveMode, 'json_fallback');
  assert.equal(fallbackData.manifest.recordCounts.plans, 5);

  // 2. Exception Fallback: simulate packaging crash
  const originalGetHours = Date.prototype.getHours;
  Date.prototype.getHours = function() {
    throw new Error('Adversarial binary compressor fault simulation');
  };

  try {
    const errorFallback = await exportCharacterBackup(
      { character: env.character },
      env.store,
      env.client,
      { now: fixedNow }
    );

    assert.equal(errorFallback.isZip, false, 'Compressor failure must fall back to JSON');
    assert.equal(errorFallback.filename, `life-backup-${characterId}-${fixedNow}.json`);

    const errJsonStr = Buffer.from(errorFallback.base64, 'base64').toString('utf-8');
    const errData = JSON.parse(errJsonStr);
    assert.ok(Array.isArray(errData.plans), 'Error fallback JSON must include plans array');
    assert.equal(errData.plans.length, 5);
    assert.equal(errData.specVersion, '1.1.0');
  } finally {
    Date.prototype.getHours = originalGetHours;
  }
});
