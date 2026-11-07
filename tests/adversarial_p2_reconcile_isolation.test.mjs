import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore, SQL } from '../src/store.js';
import {
  createProfile,
  documentId,
  epoch,
  memoryPayload
} from '../src/core.js';
import {
  enrichMemory,
  writeMemory
} from '../src/memory.js';

const role = { id: 'role-p2-adversarial', data: { data: { name: '瑠璃子' } } };
const fixedDate = '2026-11-01';
const wakeEpoch = epoch(fixedDate, 524); // 08:44 in Asia/Shanghai

function createP2Fixture(t) {
  const db = new DatabaseSync(':memory:');
  if (t?.after) t.after(() => db.close());

  const memories = [];
  const writes = [];
  let createCalls = 0;
  let updateCalls = 0;
  let createOrUpdateCalls = 0;
  let listCalls = 0;

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
      list: async (id, offset, limit, options) => {
        listCalls++;
        return memories
          .filter(m => m.character_id === id && m.timestamp >= options.minTimestamp && m.timestamp <= options.maxTimestamp)
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(offset, offset + limit)
          .map(m => structuredClone(m));
      },
      createOrUpdate: async rows => {
        createOrUpdateCalls++;
        const output = [];
        for (const m of rows) {
          writes.push(structuredClone(m));
          if (!m.id || m.id <= 0) {
            createCalls++;
            const added = { ...m, id: 200 + memories.length };
            memories.push(added);
            output.push(structuredClone(added));
          } else {
            updateCalls++;
            const i = memories.findIndex(x => x.id === m.id);
            assert.ok(i >= 0, 'updates must target an existing id');
            memories[i] = { ...m };
            output.push(structuredClone(m));
          }
        }
        return output;
      },
      create: async () => {
        createCalls++;
        throw new Error('Native memories.create should NEVER be called');
      },
      update: async () => {
        updateCalls++;
        throw new Error('Native memories.update should NEVER be called');
      }
    },
    chat: {
      completions: {
        create: async () => {
          throw new Error('Unexpected LLM completion call during read-only reconcile');
        }
      }
    }
  };

  const store = createStore(client);

  return {
    db,
    client,
    store,
    memories,
    writes,
    get createCalls() { return createCalls; },
    get updateCalls() { return updateCalls; },
    get createOrUpdateCalls() { return createOrUpdateCalls; },
    get totalWriteCalls() { return createCalls + updateCalls + writes.length; },
    get listCalls() { return listCalls; },
    resetCounters() {
      createCalls = 0;
      updateCalls = 0;
      createOrUpdateCalls = 0;
      writes.length = 0;
      listCalls = 0;
    },
    async init(d, native = null, profileInit = null) {
      await store.init();
      const p = profileInit || createProfile(role, wakeEpoch);
      if (p) await store.putProfile(p);
      if (d) await store.putDoc(d);
      if (native) memories.push(structuredClone(native));
    }
  };
}

function createBaseDiaryDoc(syncStatus = 'uncertain', memoryId = null) {
  return {
    id: documentId(role.id, 'diary', fixedDate),
    characterId: role.id,
    sessionId: 'p2-session-1',
    kind: 'diary',
    day: fixedDate,
    title: '晨起随笔',
    body: '今天08:44起床，随后在书房整理案头的笔记。阳光正好。',
    summary: '08:44起床，整理案头笔记。',
    createdAt: wakeEpoch,
    nativeTimestamp: wakeEpoch,
    syncStatus,
    memoryId,
    timelineFacts: { wakeTime: '08:44', wakeSource: 'manual' }
  };
}

// ==============================================================================
// Challenge 1: Reconcile Under Extreme Profile Mutations
// ==============================================================================

test('P2 Adversarial 1.A: Reconcile with cleared wake records (profile.wakeRecords = {})', async t => {
  const f = createP2Fixture(t);
  const doc = createBaseDiaryDoc('uncertain', null);
  const native = { ...memoryPayload(doc), id: 501, timestamp: wakeEpoch };
  
  const p = createProfile(role, wakeEpoch);
  p.wakeRecords[fixedDate] = { at: wakeEpoch, timezone: 'Asia/Shanghai' };
  await f.init(doc, native, p);

  // Adversarially clear all wake records
  const loadedProfile = await f.store.getProfile(role.id);
  loadedProfile.wakeRecords = {};
  await f.store.putProfile(loadedProfile);

  f.resetCounters();

  // Execute reconcileOnly
  const reconciled = await writeMemory(f.client, f.store, doc.id, { reconcileOnly: true });

  // Verification
  assert.equal(reconciled.syncStatus, 'written', 'syncStatus must be restored to "written"');
  assert.equal(reconciled.memoryId, 501, 'memoryId must match native id 501');
  assert.equal(f.createCalls, 0, 'memories.create call count must be ZERO');
  assert.equal(f.updateCalls, 0, 'memories.update call count must be ZERO');
  assert.equal(f.createOrUpdateCalls, 0, 'memories.createOrUpdate call count must be ZERO');
  assert.equal(f.totalWriteCalls, 0, 'Total native write calls must be ZERO');

  const storedDoc = await f.store.getDoc(doc.id);
  assert.equal(storedDoc.syncStatus, 'written');
  assert.equal(storedDoc.memoryId, 501);
});

test('P2 Adversarial 1.B1: Reconcile with completely conflicting wake record (profile.wakeRecords[day] = "14:30")', async t => {
  const f = createP2Fixture(t);
  const doc = createBaseDiaryDoc('uncertain', null);
  const native = { ...memoryPayload(doc), id: 502, timestamp: wakeEpoch };
  
  const p = createProfile(role, wakeEpoch);
  p.wakeRecords[fixedDate] = { at: wakeEpoch, timezone: 'Asia/Shanghai' };
  await f.init(doc, native, p);

  // Adversarially set conflicting wake record as raw string
  const loadedProfile = await f.store.getProfile(role.id);
  loadedProfile.wakeRecords[fixedDate] = '14:30';
  await f.store.putProfile(loadedProfile);

  f.resetCounters();

  // Execute reconcileOnly
  const reconciled = await writeMemory(f.client, f.store, doc.id, { reconcileOnly: true });

  // Verification
  assert.equal(reconciled.syncStatus, 'written');
  assert.equal(reconciled.memoryId, 502);
  assert.equal(f.createCalls, 0);
  assert.equal(f.updateCalls, 0);
  assert.equal(f.createOrUpdateCalls, 0);
  assert.equal(f.totalWriteCalls, 0);

  const storedDoc = await f.store.getDoc(doc.id);
  assert.equal(storedDoc.syncStatus, 'written');
  assert.equal(storedDoc.memoryId, 502);
});

test('P2 Adversarial 1.B2: Reconcile with conflicting wake timestamp object (14:30 in Asia/Shanghai)', async t => {
  const f = createP2Fixture(t);
  const doc = createBaseDiaryDoc('uncertain', null);
  const native = { ...memoryPayload(doc), id: 503, timestamp: wakeEpoch };
  
  const p = createProfile(role, wakeEpoch);
  p.wakeRecords[fixedDate] = { at: wakeEpoch, timezone: 'Asia/Shanghai' };
  await f.init(doc, native, p);

  // Adversarially set conflicting wake timestamp (14:30)
  const conflictingEpoch = epoch(fixedDate, 14 * 60 + 30);
  const loadedProfile = await f.store.getProfile(role.id);
  loadedProfile.wakeRecords[fixedDate] = { at: conflictingEpoch, timezone: 'Asia/Shanghai' };
  await f.store.putProfile(loadedProfile);

  f.resetCounters();

  // Execute reconcileOnly
  const reconciled = await writeMemory(f.client, f.store, doc.id, { reconcileOnly: true });

  // Verification
  assert.equal(reconciled.syncStatus, 'written');
  assert.equal(reconciled.memoryId, 503);
  assert.equal(f.createCalls, 0);
  assert.equal(f.updateCalls, 0);
  assert.equal(f.createOrUpdateCalls, 0);
  assert.equal(f.totalWriteCalls, 0);
});

test('P2 Adversarial 1.C1: Reconcile when profile is deleted entirely from SQLite store', async t => {
  const f = createP2Fixture(t);
  const doc = createBaseDiaryDoc('uncertain', null);
  const native = { ...memoryPayload(doc), id: 504, timestamp: wakeEpoch };
  await f.init(doc, native);

  // Adversarially delete profile row from SQLite database entirely
  await f.client.db.executeSql('DELETE FROM ll_profiles WHERE character_id = ?', [role.id]);
  const checkProfile = await f.store.getProfile(role.id);
  assert.equal(checkProfile, null, 'Profile must be completely missing from DB');

  f.resetCounters();

  // Execute reconcileOnly
  const reconciled = await writeMemory(f.client, f.store, doc.id, { reconcileOnly: true });

  // Verification: should cleanly succeed even with zero profile row
  assert.equal(reconciled.syncStatus, 'written');
  assert.equal(reconciled.memoryId, 504);
  assert.equal(f.totalWriteCalls, 0);

  const storedDoc = await f.store.getDoc(doc.id);
  assert.equal(storedDoc.syncStatus, 'written');
  assert.equal(storedDoc.memoryId, 504);
});

test('P2 Adversarial 1.C2: Reconcile when profile is set to empty object ({}) in SQLite store', async t => {
  const f = createP2Fixture(t);
  const doc = createBaseDiaryDoc('uncertain', null);
  const native = { ...memoryPayload(doc), id: 505, timestamp: wakeEpoch };
  await f.init(doc, native);

  // Adversarially set empty profile in SQLite
  await f.client.db.executeSql(SQL.putProfile, [role.id, '{}']);

  f.resetCounters();

  // Execute reconcileOnly
  const reconciled = await writeMemory(f.client, f.store, doc.id, { reconcileOnly: true });

  assert.equal(reconciled.syncStatus, 'written');
  assert.equal(reconciled.memoryId, 505);
  assert.equal(f.totalWriteCalls, 0);
});

// ==============================================================================
// Challenge 2: Strict Interception on Active Writes
// ==============================================================================

test('P2 Adversarial 2.A: Active write with conflicting wake record strictly throws and blocks createOrUpdate', async t => {
  const f = createP2Fixture(t);
  const doc = createBaseDiaryDoc('uncertain', null);
  const native = { ...memoryPayload(doc), id: 506, timestamp: wakeEpoch };

  const conflictingEpoch = epoch(fixedDate, 14 * 60 + 30);
  const p = createProfile(role, wakeEpoch);
  p.wakeRecords[fixedDate] = { at: conflictingEpoch, timezone: 'Asia/Shanghai' };
  await f.init(doc, native, p);

  f.resetCounters();

  // Active write (reconcileOnly: false) MUST throw
  await assert.rejects(
    writeMemory(f.client, f.store, doc.id, { reconcileOnly: false }),
    /文稿包含未确认或冲突的起床时间，已严格拦截写入原生记忆/
  );

  // Native call count must be 0
  assert.equal(f.totalWriteCalls, 0, 'No active write should be dispatched');

  // Verify doc status remained uncertain and was not corrupted
  const storedDoc = await f.store.getDoc(doc.id);
  assert.equal(storedDoc.syncStatus, 'uncertain');
});

test('P2 Adversarial 2.B: Active write on fresh pending document with conflicting wake record strictly throws', async t => {
  const f = createP2Fixture(t);
  const doc = createBaseDiaryDoc('pending', null);

  const conflictingEpoch = epoch(fixedDate, 14 * 60 + 30);
  const p = createProfile(role, wakeEpoch);
  p.wakeRecords[fixedDate] = { at: conflictingEpoch, timezone: 'Asia/Shanghai' };
  await f.init(doc, null, p);

  f.resetCounters();

  // Active write on pending document
  await assert.rejects(
    writeMemory(f.client, f.store, doc.id, { reconcileOnly: false }),
    /文稿包含未确认或冲突的起床时间，已严格拦截写入原生记忆/
  );

  assert.equal(f.totalWriteCalls, 0);
});

test('P2 Adversarial 2.C: Active in-place update on stale document with conflicting wake record strictly throws', async t => {
  const f = createP2Fixture(t);
  const doc = createBaseDiaryDoc('stale', 507);
  const native = { ...memoryPayload(doc), id: 507, timestamp: wakeEpoch };

  const conflictingEpoch = epoch(fixedDate, 14 * 60 + 30);
  const p = createProfile(role, wakeEpoch);
  p.wakeRecords[fixedDate] = { at: conflictingEpoch, timezone: 'Asia/Shanghai' };
  await f.init(doc, native, p);

  f.resetCounters();

  // Active write on stale document
  await assert.rejects(
    writeMemory(f.client, f.store, doc.id, { reconcileOnly: false }),
    /文稿包含未确认或冲突的起床时间，已严格拦截写入原生记忆/
  );

  assert.equal(f.totalWriteCalls, 0);
});

// ==============================================================================
// Challenge 3: Stale Status Reconcile
// ==============================================================================

test('P2 Adversarial 3: Stale document with conflicting wake records reconciles cleanly without error', async t => {
  const f = createP2Fixture(t);
  const doc = createBaseDiaryDoc('stale', 508);
  const native = { ...memoryPayload(doc), id: 508, timestamp: wakeEpoch };

  const conflictingEpoch = epoch(fixedDate, 14 * 60 + 30);
  const p = createProfile(role, wakeEpoch);
  p.wakeRecords[fixedDate] = { at: conflictingEpoch, timezone: 'Asia/Shanghai' };
  await f.init(doc, native, p);

  f.resetCounters();

  // Reconcile stale document
  const reconciled = await writeMemory(f.client, f.store, doc.id, { reconcileOnly: true });

  assert.equal(reconciled.syncStatus, 'stale', 'Stale status must be preserved');
  assert.equal(reconciled.memoryId, 508);
  assert.equal(f.totalWriteCalls, 0, 'No write call must be made');

  const storedDoc = await f.store.getDoc(doc.id);
  assert.equal(storedDoc.syncStatus, 'stale');
  assert.equal(storedDoc.memoryId, 508);
});

// ==============================================================================
// Challenge 4: Concurrency & Idempotency
// ==============================================================================

test('P2 Adversarial 4.A: 10 parallel reconcileOnly calls with lock-retry resolve cleanly to idempotent state with 0 writes', async t => {
  const f = createP2Fixture(t);
  const doc = createBaseDiaryDoc('uncertain', null);
  const native = { ...memoryPayload(doc), id: 509, timestamp: wakeEpoch };

  // Set conflicting wake time in profile to ensure no assertion trips during parallel reconciles
  const conflictingEpoch = epoch(fixedDate, 14 * 60 + 30);
  const p = createProfile(role, wakeEpoch);
  p.wakeRecords[fixedDate] = { at: conflictingEpoch, timezone: 'Asia/Shanghai' };
  await f.init(doc, native, p);

  f.resetCounters();

  // Helper with retry on lock contention
  async function concurrentReconcileWorker(workerId) {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const res = await writeMemory(f.client, f.store, doc.id, { reconcileOnly: true });
        return { workerId, success: true, res, attempts: attempt + 1 };
      } catch (err) {
        if (err.message && err.message.includes('正在处理另一项任务')) {
          // Lock contention, wait a jittered delay and retry
          await new Promise(resolve => setTimeout(resolve, 5 + Math.random() * 15));
          continue;
        }
        return { workerId, success: false, error: err.message };
      }
    }
    throw new Error(`Worker ${workerId} exceeded retry limit`);
  }

  // Launch 10 parallel workers simultaneously
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => concurrentReconcileWorker(i + 1))
  );

  // Verify all 10 workers succeeded
  for (const r of results) {
    assert.equal(r.success, true, `Worker ${r.workerId} failed: ${r.error}`);
    assert.equal(r.res.syncStatus, 'written', `Worker ${r.workerId} syncStatus mismatch`);
    assert.equal(r.res.memoryId, 509, `Worker ${r.workerId} memoryId mismatch`);
  }

  // Verify ZERO native writes across all 10 parallel workers!
  assert.equal(f.createCalls, 0);
  assert.equal(f.updateCalls, 0);
  assert.equal(f.createOrUpdateCalls, 0);
  assert.equal(f.totalWriteCalls, 0);

  // Final document state in SQLite store
  const storedDoc = await f.store.getDoc(doc.id);
  assert.equal(storedDoc.syncStatus, 'written');
  assert.equal(storedDoc.memoryId, 509);
});

test('P2 Adversarial 4.B: 10 consecutive reconcileOnly calls are 100% idempotent with 0 writes and 0 errors', async t => {
  const f = createP2Fixture(t);
  const doc = createBaseDiaryDoc('uncertain', null);
  const native = { ...memoryPayload(doc), id: 510, timestamp: wakeEpoch };
  await f.init(doc, native);

  f.resetCounters();

  for (let i = 0; i < 10; i++) {
    const res = await writeMemory(f.client, f.store, doc.id, { reconcileOnly: true });
    assert.equal(res.syncStatus, 'written');
    assert.equal(res.memoryId, 510);
  }

  assert.equal(f.totalWriteCalls, 0, 'Consecutive reconciles must produce 0 writes');
});

test('P2 Adversarial 4.C: Raw Promise.allSettled concurrency respects store lock without corrupting document state', async t => {
  const f = createP2Fixture(t);
  const doc = createBaseDiaryDoc('uncertain', null);
  const native = { ...memoryPayload(doc), id: 511, timestamp: wakeEpoch };
  await f.init(doc, native);

  f.resetCounters();

  // Launch 10 raw simultaneous requests without retry
  const outcomes = await Promise.allSettled(
    Array.from({ length: 10 }, () => writeMemory(f.client, f.store, doc.id, { reconcileOnly: true }))
  );

  const fulfilled = outcomes.filter(o => o.status === 'fulfilled');
  const rejected = outcomes.filter(o => o.status === 'rejected');

  // At least one must succeed
  assert.ok(fulfilled.length >= 1, 'At least one concurrent caller must acquire lock');

  // Any rejected calls must strictly be lock contention errors
  for (const rej of rejected) {
    assert.match(rej.reason.message, /正在处理另一项任务/, 'Rejections must only be lock contention');
  }

  // ZERO native writes
  assert.equal(f.totalWriteCalls, 0);

  // Verify DB state is cleanly written (not left uncertain or corrupted)
  const storedDoc = await f.store.getDoc(doc.id);
  assert.equal(storedDoc.syncStatus, 'written');
  assert.equal(storedDoc.memoryId, 511);
});

// ==============================================================================
// Challenge 5: Missing Native Receipt Under Uncertain Reconcile
// ==============================================================================

test('P2 Adversarial 5: Uncertain doc with missing native memory throws receipt-not-found error, NOT wake validation error', async t => {
  const f = createP2Fixture(t);
  const doc = createBaseDiaryDoc('uncertain', null);

  // Set conflicting wake record
  const conflictingEpoch = epoch(fixedDate, 14 * 60 + 30);
  const p = createProfile(role, wakeEpoch);
  p.wakeRecords[fixedDate] = { at: conflictingEpoch, timezone: 'Asia/Shanghai' };
  
  // Note: memories array is empty (no native memory exists)
  await f.init(doc, null, p);

  f.resetCounters();

  // Must throw receipt-not-found error, NOT wake validation error
  await assert.rejects(
    writeMemory(f.client, f.store, doc.id, { reconcileOnly: true }),
    /暂未找到写入回执，已保留待核对状态；请检查原生记忆，避免重复新增/
  );

  assert.equal(f.totalWriteCalls, 0);
  
  // Doc remains in uncertain state
  const stored = await f.store.getDoc(doc.id);
  assert.equal(stored.syncStatus, 'uncertain');
});

// ==============================================================================
// Challenge 6: Graph Adoption Under Cleared Wake Records
// ==============================================================================

test('P2 Adversarial 6: Reconcile and enrichLocked adopt existing native graph even when wake records are cleared or conflicting', async t => {
  const f = createP2Fixture(t);
  const existingGraph = JSON.stringify([
    { subject: '瑠璃子', relationship: '2026-11-01作息', object: '8:44起床' },
    { subject: '瑠璃子', relationship: '2026-11-01动作', object: '整理案头笔记' }
  ]);
  const doc = createBaseDiaryDoc('uncertain', null);
  const native = {
    ...memoryPayload(doc),
    id: 512,
    timestamp: wakeEpoch,
    knowledgeGraphJSON: existingGraph
  };

  const conflictingEpoch = epoch(fixedDate, 14 * 60 + 30);
  const p = createProfile(role, wakeEpoch);
  p.wakeRecords[fixedDate] = { at: conflictingEpoch, timezone: 'Asia/Shanghai' };
  await f.init(doc, native, p);

  f.resetCounters();

  // 1. Reconcile recovers written AND adopts native graph
  const reconciled = await writeMemory(f.client, f.store, doc.id, { reconcileOnly: true });
  assert.equal(reconciled.syncStatus, 'written');
  assert.equal(reconciled.memoryId, 512);
  assert.equal(reconciled.graphStatus, 'ready');
  assert.equal(reconciled.graphVerifiedJSON, existingGraph);
  assert.equal(f.totalWriteCalls, 0);

  // 2. Clear wake records completely
  const loaded = await f.store.getProfile(role.id);
  loaded.wakeRecords = {};
  await f.store.putProfile(loaded);

  // 3. enrichMemory adopts existing graph without error or write
  const enriched = await enrichMemory(f.client, f.store, doc.id);
  assert.equal(enriched.graphStatus, 'ready');
  assert.equal(enriched.graphVerifiedJSON, existingGraph);
  assert.equal(f.totalWriteCalls, 0);
});
