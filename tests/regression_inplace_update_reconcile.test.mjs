import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import { createProfile, epoch } from '../src/core.js';
import { buildGraph, formatMemoryToast, memoryBasis, readTriples } from '../src/memory-graph.js';
import { enrichMemory, generateDocument, recordWakeTime, writeMemory } from '../src/workflow.js';
import { exportCharacterBackup } from '../src/export.js';

const fixedDay = '2026-11-01';
const morningTs = epoch(fixedDay, 8 * 60 + 44, 'Asia/Shanghai');
const eveningTs = epoch(fixedDay, 21 * 60 + 30, 'Asia/Shanghai');

const baseCharacter = {
  id: 'char-p1-inplace',
  data: {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '澪',
      description: '安静细致的文学系学生',
      personality: '温和认真',
      scenario: '',
      post_history_instructions: ''
    }
  }
};

function createFixture(t, { existingDb = null } = {}) {
  const db = existingDb || new DatabaseSync(':memory:');
  if (!existingDb) t.after(() => db.close());

  const role = structuredClone(baseCharacter);
  const memories = [];
  let docResponse = {
    title: '初版晨读日记',
    body: '今天早上08:44起床，上午在窗边整理了文学阅读笔记。',
    summary: '早上08:44起床，上午在窗边整理了文学阅读笔记。'
  };
  let updateBehavior = 'ok'; // 'ok' | 'fail-before-commit' | 'lost-receipt-after-commit' | 'drop-graph-lost-receipt' | 'keep-old-graph-lost-receipt' | 'stale-receipt-noop' | 'crash-sending-before-commit' | 'crash-sending-after-commit'
  let onBeforeCreateOrUpdate = null;

  const counters = {
    createCalls: 0,
    updateCalls: 0,
    createOrUpdateCalls: 0,
    listCalls: 0,
    llmDocCalls: 0,
    llmGraphCalls: 0
  };

  const resetCounters = () => {
    counters.createCalls = 0;
    counters.updateCalls = 0;
    counters.createOrUpdateCalls = 0;
    counters.listCalls = 0;
    counters.llmDocCalls = 0;
    counters.llmGraphCalls = 0;
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
      list: async () => [role],
      update: async updated => {
        role.data = structuredClone(updated.data);
        return updated.id;
      }
    },
    personas: {
      get: async () => ({ name: '测试读者', description: '' })
    },
    chat: {
      getChatSessions: async () => ({ sessions: [{ session_id: 'sess-main' }] }),
      getChatHistory: async () => [
        { id: 1, role: 'user', content: '今天过得怎么样？', timestamp: morningTs + 60000, character_id: role.id, session_id: 'sess-main' }
      ],
      completions: {
        create: async request => {
          const sys = String(request.messages?.[0]?.content || '');
          if (sys.includes('TASK:MEMORY_GRAPH')) {
            counters.llmGraphCalls++;
            const ctx = JSON.parse(request.messages[1].content);
            const triples = [];
            if (ctx.rawText.includes('红茶')) {
              triples.push({ subject: ctx.recordNode, relationship: '记录中物件', object: '红茶' });
            }
            if (ctx.rawText.includes('书架')) {
              triples.push({ subject: ctx.recordNode, relationship: '记录中动作', object: '整理了书架' });
            }
            if (ctx.rawText.includes('文学阅读笔记')) {
              triples.push({ subject: ctx.recordNode, relationship: '记录中动作', object: '整理了文学阅读笔记' });
            }
            if (!triples.length) {
              triples.push({ subject: ctx.recordNode, relationship: '记录中细节', object: ctx.summary.slice(-6) });
            }
            return { choices: [{ message: { content: JSON.stringify(triples) } }] };
          }
          if (sys.includes('TASK:SCENE')) {
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    scene: '澪坐在靠窗的木桌前翻开笔记本，将今天读到的段落慢慢摘抄下来，屋内安静而温暖。'
                  })
                }
              }]
            };
          }
          counters.llmDocCalls++;
          return { choices: [{ message: { content: JSON.stringify(docResponse) } }] };
        }
      }
    },
    memories: {
      getTopMemories: async () => memories.map(m => structuredClone(m)),
      list: async (charId, offset = 0, limit = 50, options = {}) => {
        counters.listCalls++;
        return memories
          .filter(m => {
            if (charId && m.character_id !== charId) return false;
            if (options.minTimestamp != null && m.timestamp < options.minTimestamp) return false;
            if (options.maxTimestamp != null && m.timestamp > options.maxTimestamp) return false;
            return true;
          })
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(offset, offset + limit)
          .map(m => structuredClone(m));
      },
      create: async () => {
        counters.createCalls++;
        throw new Error('Unexpected direct memories.create call');
      },
      update: async () => {
        counters.updateCalls++;
        throw new Error('Unexpected direct memories.update call');
      },
      createOrUpdate: async rows => {
        counters.createOrUpdateCalls++;
        if (onBeforeCreateOrUpdate) await onBeforeCreateOrUpdate(rows);
        const out = [];
        for (const row of rows) {
          if (row.id <= 0) {
            counters.createCalls++;
            const created = { ...structuredClone(row), id: 100 + memories.length };
            memories.push(created);
            out.push(structuredClone(created));
            continue;
          }
          counters.updateCalls++;
          const idx = memories.findIndex(m => m.id === row.id);
          assert.ok(idx >= 0, `Expected existing native memory #${row.id}`);
          if (updateBehavior === 'fail-before-commit') {
            throw new Error('网络中断：宿主落库前连接断开');
          }
          if (updateBehavior === 'stale-receipt-noop') {
            // Buggy host returns old memory row without committing the update
            out.push(structuredClone(memories[idx]));
            continue;
          }
          const prevGraph = memories[idx].knowledgeGraphJSON;
          const nextRow = { ...structuredClone(row) };
          if (updateBehavior === 'drop-graph-lost-receipt') {
            nextRow.knowledgeGraphJSON = null;
          } else if (updateBehavior === 'keep-old-graph-lost-receipt') {
            nextRow.knowledgeGraphJSON = prevGraph;
          }
          memories[idx] = nextRow;
          out.push(structuredClone(nextRow));
          if (
            updateBehavior === 'lost-receipt-after-commit' ||
            updateBehavior === 'drop-graph-lost-receipt' ||
            updateBehavior === 'keep-old-graph-lost-receipt'
          ) {
            throw new Error('网络超时：宿主已落库但回执丢失');
          }
        }
        return out;
      }
    }
  };

  return {
    db,
    role,
    client,
    store: createStore(client),
    memories,
    counters,
    resetCounters,
    get totalWriteCalls() {
      return counters.createCalls + counters.updateCalls + counters.createOrUpdateCalls;
    },
    setDoc(next) { docResponse = next; },
    setUpdateBehavior(mode) { updateBehavior = mode; },
    setBeforeCreateOrUpdate(fn) { onBeforeCreateOrUpdate = fn; }
  };
}

async function setupWrittenDiaryA(f) {
  await f.store.init();
  await f.store.putProfile(createProfile(f.role, morningTs - 60000));
  await recordWakeTime(f.client, f.store, f.role, fixedDay, '08:44', { now: morningTs });

  f.setDoc({
    title: '初版晨读日记',
    body: '今天早上08:44起床，上午在窗边整理了文学阅读笔记。',
    summary: '早上08:44起床，上午在窗边整理了文学阅读笔记。'
  });
  const diaryA = await generateDocument(f.client, f.store, f.role, 'diary', { now: eveningTs - 3600000, generateScene: false });
  const writtenA = await writeMemory(f.client, f.store, diaryA.id);

  assert.equal(writtenA.syncStatus, 'written');
  assert.equal(writtenA.graphStatus, 'ready');
  assert.equal(writtenA.memoryId, 100);
  assert.equal(f.memories.length, 1);

  return { diaryA: writtenA, nativeASnapshot: structuredClone(f.memories[0]) };
}

test('Issue #1 Comment 6705080726 AC1 & AC3: In-place update fails BEFORE host commit -> reconcileOnly keeps local B pending update (not written), preserves native A, 0 writes, and allows clean retry', async t => {
  const f = createFixture(t);
  const { diaryA, nativeASnapshot } = await setupWrittenDiaryA(f);

  // 1. Regenerate same-day diary B in place
  f.setDoc({
    title: '晚间补充红茶日记',
    body: '今天早上08:44起床，上午在窗边整理了文学阅读笔记，傍晚又煮了一壶大吉岭红茶并整理了书架。',
    summary: '早上08:44起床，整理文学笔记，傍晚煮红茶并整理了书架。'
  });
  const diaryB = await generateDocument(f.client, f.store, f.role, 'diary', { now: eveningTs, force: true, generateScene: false });
  assert.equal(diaryB.id, diaryA.id);
  assert.equal(diaryB.memoryId, 100);
  assert.equal(diaryB.syncStatus, 'stale');

  // 2. Attempt in-place update -> fails BEFORE host DB updates #100
  f.setUpdateBehavior('fail-before-commit');
  await assert.rejects(
    writeMemory(f.client, f.store, diaryB.id),
    /宿主落库前连接断开/
  );

  const afterFail = await f.store.getDoc(diaryB.id);
  assert.equal(afterFail.syncStatus, 'uncertain');
  assert.equal(afterFail.memoryId, 100);
  assert.ok(afterFail.pendingWrite, 'pendingWrite must be persisted before calling createOrUpdate');
  assert.equal(afterFail.pendingWrite.op, 'update');
  assert.equal(afterFail.pendingWrite.targetMemoryId, 100);
  assert.match(afterFail.pendingWrite.summary, /晚间补充红茶日记/);

  // Native #100 must still hold version A untouched
  assert.equal(f.memories.length, 1);
  assert.deepEqual(f.memories[0], nativeASnapshot);

  // 3. Read-only reconciliation ("核对写入")
  f.resetCounters();
  const reconciled = await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });

  assert.equal(f.totalWriteCalls, 0, 'Read-only reconciliation must invoke native write APIs 0 times');
  assert.equal(f.counters.llmGraphCalls, 0, 'Read-only reconciliation must invoke LLM 0 times');
  assert.equal(f.memories.length, 1, 'Native memory count must remain 1');
  assert.equal(reconciled.memoryId, 100, 'Native memoryId must remain 100');
  assert.deepEqual(f.memories[0], nativeASnapshot, 'Native version A must be preserved byte-for-byte');

  // Local B MUST NOT be misclassified as written!
  assert.notEqual(reconciled.syncStatus, 'written', 'Local version B must NOT be falsely marked written');
  assert.equal(reconciled.syncStatus, 'stale', 'Local version B returns to stale (待更新记忆) so user can retry');
  assert.notEqual(reconciled.graphStatus, 'ready', 'Version A graph must NOT be accepted onto version B');
  assert.equal(reconciled.graphVerifiedJSON, null);
  assert.match(reconciled.syncError, /初版晨读日记/);
  assert.match(reconciled.syncError, /晚间补充红茶日记/);

  // Idempotent if reconcileOnly is called a second time
  f.resetCounters();
  const reconciledAgain = await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });
  assert.equal(f.totalWriteCalls, 0);
  assert.equal(reconciledAgain.syncStatus, 'stale');
  assert.equal(reconciledAgain.memoryId, 100);

  // 4. Subsequent active retry ("更新原记忆") updates #100 in place to B without extra graph LLM call
  f.setUpdateBehavior('ok');
  f.resetCounters();
  const retried = await writeMemory(f.client, f.store, diaryB.id);
  assert.equal(retried.syncStatus, 'written');
  assert.equal(retried.graphStatus, 'ready');
  assert.equal(retried.memoryId, 100);
  assert.equal(retried.pendingWrite, null);
  assert.equal(retried.syncError, '');
  assert.equal(f.memories.length, 1);
  assert.equal(f.counters.llmGraphCalls, 0, 'Durable graph draft is reused on retry without extra LLM call');
  assert.match(f.memories[0].summary, /晚间补充红茶日记/);
  const triplesB = readTriples(f.memories[0].knowledgeGraphJSON);
  assert.ok(triplesB.some(tr => tr.object === '红茶'));
});

test('Issue #1 Comment 6705080726 AC2 & AC3: In-place update commits B in host DB then loses receipt -> reconcileOnly recovers B as written with 0 writes', async t => {
  const f = createFixture(t);
  await setupWrittenDiaryA(f);

  f.setDoc({
    title: '晚间补充红茶日记',
    body: '今天早上08:44起床，上午整理笔记，傍晚煮了一壶红茶并整理了书架。',
    summary: '早上08:44起床，整理笔记，傍晚煮红茶并整理了书架。'
  });
  const diaryB = await generateDocument(f.client, f.store, f.role, 'diary', { now: eveningTs, force: true, generateScene: false });

  f.setUpdateBehavior('lost-receipt-after-commit');
  await assert.rejects(
    writeMemory(f.client, f.store, diaryB.id),
    /宿主已落库但回执丢失/
  );

  const afterLost = await f.store.getDoc(diaryB.id);
  assert.equal(afterLost.syncStatus, 'uncertain');
  assert.equal(afterLost.memoryId, 100);
  assert.ok(afterLost.pendingWrite);
  assert.equal(f.memories.length, 1);
  assert.match(f.memories[0].summary, /晚间补充红茶日记/);

  f.resetCounters();
  const recovered = await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });

  assert.equal(f.totalWriteCalls, 0, 'Read-only reconciliation must make 0 native write calls');
  assert.equal(f.counters.llmGraphCalls, 0);
  assert.equal(f.memories.length, 1);
  assert.equal(recovered.memoryId, 100);
  assert.equal(recovered.syncStatus, 'written');
  assert.equal(recovered.graphStatus, 'ready');
  assert.equal(recovered.pendingWrite, null);
  assert.equal(recovered.syncError, '');
  assert.ok(readTriples(recovered.graphVerifiedJSON).some(tr => tr.object === '红茶'));
});

test('Issue #1 Comment 6705080726 AC4: App restart (brand-new Store instance over persisted SQLite) accurately distinguishes pre-commit failure vs post-commit lost receipt, including mid-flight sending crashes', async t => {
  // Sub-case A: Mid-flight crash while syncStatus === "sending" BEFORE host DB commits
  {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());

    const f1 = createFixture(t, { existingDb: db });
    const { nativeASnapshot } = await setupWrittenDiaryA(f1);

    f1.setDoc({
      title: '重启前未落库的新版日记',
      body: '今天早上08:44起床，晚上煮了红茶。',
      summary: '早上08:44起床，晚上煮了红茶。'
    });
    const diaryB = await generateDocument(f1.client, f1.store, f1.role, 'diary', { now: eveningTs, force: true, generateScene: false });

    // Simulate abrupt WebView termination right as createOrUpdate is invoked (doc in SQLite is 'sending' with pendingWrite)
    f1.setBeforeCreateOrUpdate(async () => {
      const rawRow = db.prepare('SELECT data FROM ll_documents WHERE id = ?').get(diaryB.id);
      const persisted = JSON.parse(rawRow.data);
      assert.equal(persisted.syncStatus, 'sending', 'SQLite must persist sending status BEFORE createOrUpdate runs');
      assert.equal(persisted.pendingWrite?.op, 'update');
      assert.equal(persisted.pendingWrite?.targetMemoryId, 100);
      throw new Error('模拟宿主进程在落库前闪退');
    });

    await assert.rejects(writeMemory(f1.client, f1.store, diaryB.id), /闪退/);

    // Also force raw SQLite status back to 'sending' (as if catch block never even executed due to hard SIGKILL!)
    const killedDoc = JSON.parse(db.prepare('SELECT data FROM ll_documents WHERE id = ?').get(diaryB.id).data);
    killedDoc.syncStatus = 'sending';
    killedDoc.syncError = '';
    db.prepare('UPDATE ll_documents SET data = ? WHERE id = ?').run(JSON.stringify(killedDoc), diaryB.id);

    // Simulate fresh app restart: brand-new store instance reading from the same SQLite DB
    const restartedStore = createStore(f1.client);
    await restartedStore.init();
    f1.setBeforeCreateOrUpdate(null);
    f1.resetCounters();

    const reconciledAfterRestart = await writeMemory(f1.client, restartedStore, diaryB.id, { reconcileOnly: true });
    assert.equal(f1.totalWriteCalls, 0);
    assert.equal(f1.memories.length, 1);
    assert.equal(reconciledAfterRestart.memoryId, 100);
    assert.equal(reconciledAfterRestart.syncStatus, 'stale');
    assert.notEqual(reconciledAfterRestart.syncStatus, 'written');
    assert.deepEqual(f1.memories[0], nativeASnapshot);
  }

  // Sub-case B: Mid-flight crash while syncStatus === "sending" AFTER host DB committed B
  {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());

    const f2 = createFixture(t, { existingDb: db });
    await setupWrittenDiaryA(f2);

    f2.setDoc({
      title: '重启前已落库的新版日记',
      body: '今天早上08:44起床，傍晚整理了书架并煮了红茶。',
      summary: '早上08:44起床，傍晚整理了书架并煮了红茶。'
    });
    const diaryB = await generateDocument(f2.client, f2.store, f2.role, 'diary', { now: eveningTs, force: true, generateScene: false });

    f2.setUpdateBehavior('lost-receipt-after-commit');
    await assert.rejects(writeMemory(f2.client, f2.store, diaryB.id), /回执丢失/);

    // Simulate hard SIGKILL where local DB stayed in 'sending' with pendingWrite
    const killedDoc = JSON.parse(db.prepare('SELECT data FROM ll_documents WHERE id = ?').get(diaryB.id).data);
    killedDoc.syncStatus = 'sending';
    killedDoc.syncError = '';
    db.prepare('UPDATE ll_documents SET data = ? WHERE id = ?').run(JSON.stringify(killedDoc), diaryB.id);

    const restartedStore = createStore(f2.client);
    await restartedStore.init();
    f2.resetCounters();

    const recoveredAfterRestart = await writeMemory(f2.client, restartedStore, diaryB.id, { reconcileOnly: true });
    assert.equal(f2.totalWriteCalls, 0);
    assert.equal(f2.memories.length, 1);
    assert.equal(recoveredAfterRestart.memoryId, 100);
    assert.equal(recoveredAfterRestart.syncStatus, 'written');
    assert.equal(recoveredAfterRestart.graphStatus, 'ready');
    assert.equal(recoveredAfterRestart.pendingWrite, null);

    const persistedAfter = await restartedStore.getDoc(diaryB.id);
    assert.equal(persistedAfter.syncStatus, 'written');
    assert.equal(persistedAfter.pendingWrite, null);
  }
});

test('Issue #1 Comment 6705080726 AC2 Graph Isolation: Reconcile recovers text B as written while independently rejecting dropped or stale old-A knowledge graph', async t => {
  // Case 4A: Host updated text to B, dropped knowledgeGraphJSON (null), lost receipt
  {
    const f = createFixture(t);
    await setupWrittenDiaryA(f);

    f.setDoc({
      title: '新版文本无图谱回读',
      body: '今天早上08:44起床，傍晚煮了红茶。',
      summary: '早上08:44起床，傍晚煮了红茶。'
    });
    const diaryB = await generateDocument(f.client, f.store, f.role, 'diary', { now: eveningTs, force: true, generateScene: false });

    f.setUpdateBehavior('drop-graph-lost-receipt');
    await assert.rejects(writeMemory(f.client, f.store, diaryB.id), /回执丢失/);

    f.resetCounters();
    const reconciled = await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });
    assert.equal(f.totalWriteCalls, 0);
    assert.equal(reconciled.syncStatus, 'written', 'Text B was committed, so syncStatus recovers to written');
    assert.equal(reconciled.graphStatus, 'draft', 'Dropped native graph must stay draft, not ready');
    assert.equal(reconciled.graphVerifiedJSON, null);

    // Subsequent enrichMemory writes B's durable draft without re-calling LLM
    f.setUpdateBehavior('ok');
    f.resetCounters();
    const enriched = await enrichMemory(f.client, f.store, diaryB.id);
    assert.equal(enriched.graphStatus, 'ready');
    assert.equal(f.counters.llmGraphCalls, 0);
    assert.equal(f.counters.updateCalls, 1);
  }

  // Case 4B: Host updated text to B, ignored knowledgeGraphJSON and kept Diary A's old graph, lost receipt
  {
    const f = createFixture(t);
    await setupWrittenDiaryA(f);

    f.setDoc({
      title: '新版文本残留旧图谱',
      body: '今天早上08:44起床，傍晚煮了红茶。',
      summary: '早上08:44起床，傍晚煮了红茶。'
    });
    const diaryB = await generateDocument(f.client, f.store, f.role, 'diary', { now: eveningTs, force: true, generateScene: false });

    f.setUpdateBehavior('keep-old-graph-lost-receipt');
    await assert.rejects(writeMemory(f.client, f.store, diaryB.id), /回执丢失/);

    f.resetCounters();
    const reconciled = await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });
    assert.equal(f.totalWriteCalls, 0);
    assert.equal(reconciled.syncStatus, 'written', 'Text B was committed, so syncStatus recovers to written');
    assert.equal(reconciled.graphStatus, 'uncertain', 'Old graph A must NOT be accepted as ready for text B');
    assert.equal(reconciled.graphVerifiedJSON, null);
    assert.match(reconciled.graphError, /图谱/);

    // Subsequent enrichMemory also refuses to blindly accept old graph A
    const enriched = await enrichMemory(f.client, f.store, diaryB.id);
    assert.equal(enriched.graphStatus, 'error');
    assert.equal(enriched.graphVerifiedJSON, null);
  }
});

test('Adversarial Edge Cases: Body-only update diff, external native edit protection, and stale receipt defense', async t => {
  // 5A: Body-only change (identical title & summary) still detects version mismatch on pre-commit failure
  {
    const f = createFixture(t);
    await setupWrittenDiaryA(f);

    f.setDoc({
      title: '初版晨读日记',
      body: '今天早上08:44起床，上午在窗边整理了文学阅读笔记，并在页边补上了两句新的批注。',
      summary: '早上08:44起床，上午在窗边整理了文学阅读笔记。'
    });
    const diaryB = await generateDocument(f.client, f.store, f.role, 'diary', { now: eveningTs, force: true, generateScene: false });

    f.setUpdateBehavior('fail-before-commit');
    await assert.rejects(writeMemory(f.client, f.store, diaryB.id), /宿主落库前连接断开/);

    f.resetCounters();
    const reconciled = await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });
    assert.equal(f.totalWriteCalls, 0);
    assert.equal(reconciled.syncStatus, 'stale');
    assert.match(reconciled.syncError, /正文尚未更新到当前本地版本/);
  }

  // 5B: External edit in Layla UI while local doc is uncertain keeps syncStatus === 'uncertain' and blocks blind overwrite
  {
    const f = createFixture(t);
    await setupWrittenDiaryA(f);

    f.setDoc({
      title: '晚间补充红茶日记',
      body: '今天早上08:44起床，傍晚煮了红茶。',
      summary: '早上08:44起床，傍晚煮了红茶。'
    });
    const diaryB = await generateDocument(f.client, f.store, f.role, 'diary', { now: eveningTs, force: true, generateScene: false });

    f.setUpdateBehavior('fail-before-commit');
    await assert.rejects(writeMemory(f.client, f.store, diaryB.id), /宿主落库前连接断开/);

    // Simulate user editing native #100 directly in Layla to a third version C
    f.memories[0].summary = '用户在 Layla 原生界面手动修订的第三版摘要';

    f.resetCounters();
    const reconciled = await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });
    assert.equal(f.totalWriteCalls, 0);
    assert.equal(reconciled.syncStatus, 'uncertain', 'Must stay uncertain when native matches neither B nor pre-update A');
    assert.match(reconciled.syncError, /手动修订的第三版摘要/);

    // Active write refuses to blindly overwrite external edit C
    f.setUpdateBehavior('ok');
    f.resetCounters();
    await assert.rejects(writeMemory(f.client, f.store, diaryB.id), /不一致/);
    assert.equal(f.totalWriteCalls, 0);
    assert.equal(f.memories[0].summary, '用户在 Layla 原生界面手动修订的第三版摘要');
  }

  // 5C: Buggy host returning stale version A receipt without throwing is caught and never marked written
  {
    const f = createFixture(t);
    await setupWrittenDiaryA(f);

    f.setDoc({
      title: '防御旧回执日记',
      body: '今天早上08:44起床，晚上整理了书架。',
      summary: '早上08:44起床，晚上整理了书架。'
    });
    const diaryB = await generateDocument(f.client, f.store, f.role, 'diary', { now: eveningTs, force: true, generateScene: false });

    f.setUpdateBehavior('stale-receipt-noop');
    await assert.rejects(writeMemory(f.client, f.store, diaryB.id), /旧版本|不一致/);
    const afterStaleReceipt = await f.store.getDoc(diaryB.id);
    assert.equal(afterStaleReceipt.syncStatus, 'uncertain');
  }
});

test('Export Conformance: exportCharacterBackup serializes syncError & pendingWrite while pending and clears pendingWrite after written', async t => {
  const f = createFixture(t);
  await setupWrittenDiaryA(f);

  f.setDoc({
    title: '导出校验新版日记',
    body: '今天早上08:44起床，傍晚煮了红茶。',
    summary: '早上08:44起床，傍晚煮了红茶。'
  });
  const diaryB = await generateDocument(f.client, f.store, f.role, 'diary', { now: eveningTs, force: true, generateScene: false });

  f.setUpdateBehavior('fail-before-commit');
  await assert.rejects(writeMemory(f.client, f.store, diaryB.id), /宿主落库前连接断开/);
  await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });

  // 1. Export while pending update (stale with pendingWrite & syncError)
  const backupPending = await exportCharacterBackup(
    { character: f.role, profile: await f.store.getProfile(f.role.id) },
    f.store,
    f.client,
    { forceJson: true, now: eveningTs + 1000 }
  );
  const parsedPending = JSON.parse(Buffer.from(backupPending.base64, 'base64').toString('utf8'));
  assert.equal(parsedPending.exportVersion, '1.1.0');
  assert.equal(parsedPending.specVersion, '1.1.0');
  assert.equal(parsedPending.documents.length, 1);
  const exportedDocPending = parsedPending.documents[0];
  assert.equal(exportedDocPending.syncStatus, 'stale');
  assert.equal(typeof exportedDocPending.syncError, 'string');
  assert.ok(exportedDocPending.syncError.length > 0);
  assert.equal(exportedDocPending.pendingWrite.op, 'update');
  assert.equal(exportedDocPending.pendingWrite.targetMemoryId, 100);
  assert.equal(typeof exportedDocPending.pendingWrite.rawText, 'string');
  assert.equal(typeof exportedDocPending.pendingWrite.summary, 'string');
  assert.equal(typeof exportedDocPending.pendingWrite.payloadHash, 'string');
  assert.equal(typeof exportedDocPending.pendingWrite.attemptedAt, 'number');

  // 2. Complete update and re-export -> pendingWrite is null and syncError is ''
  f.setUpdateBehavior('ok');
  await writeMemory(f.client, f.store, diaryB.id);

  const backupWritten = await exportCharacterBackup(
    { character: f.role, profile: await f.store.getProfile(f.role.id) },
    f.store,
    f.client,
    { forceJson: true, now: eveningTs + 2000 }
  );
  const parsedWritten = JSON.parse(Buffer.from(backupWritten.base64, 'base64').toString('utf8'));
  const exportedDocWritten = parsedWritten.documents[0];
  assert.equal(exportedDocWritten.syncStatus, 'written');
  assert.equal(exportedDocWritten.syncError, '');
  assert.equal(exportedDocWritten.pendingWrite, null);
});

test('Auditor BUG-1 Regression: Lost-receipt initial create A + same-day regenerate B never falsely marks B written over native A', async t => {
  const f = createFixture(t);
  await f.store.init();
  await f.store.putProfile(createProfile(f.role, morningTs - 60000));
  await recordWakeTime(f.client, f.store, f.role, fixedDay, '08:44', { now: morningTs });

  f.setDoc({
    title: '初版未收到回执日记',
    body: '今天早上08:44起床，上午在窗边整理了文学阅读笔记。',
    summary: '早上08:44起床，上午在窗边整理了文学阅读笔记。'
  });
  const diaryA = await generateDocument(f.client, f.store, f.role, 'diary', { now: eveningTs - 3600000, generateScene: false });

  // Simulate lost receipt right AFTER initial create committed #100 in host DB
  const origCreateOrUpdate = f.client.memories.createOrUpdate;
  let loseCreateReceiptOnce = true;
  f.client.memories.createOrUpdate = async rows => {
    const res = await origCreateOrUpdate(rows);
    if (loseCreateReceiptOnce) {
      loseCreateReceiptOnce = false;
      throw new Error('首次新建宿主已落库但回执丢失');
    }
    return res;
  };

  await assert.rejects(writeMemory(f.client, f.store, diaryA.id), /首次新建宿主已落库但回执丢失/);
  const afterCreateLost = await f.store.getDoc(diaryA.id);
  assert.equal(afterCreateLost.syncStatus, 'uncertain');
  assert.equal(afterCreateLost.memoryId, null);
  assert.equal(f.memories.length, 1);
  const nativeASnapshot = structuredClone(f.memories[0]);

  // Before reconciling A, user regenerates same-day Diary B
  f.setDoc({
    title: '重整后的晚间红茶日记',
    body: '今天早上08:44起床，傍晚煮了一壶红茶并整理了书架。',
    summary: '早上08:44起床，傍晚煮红茶并整理书架。'
  });
  const diaryB = await generateDocument(f.client, f.store, f.role, 'diary', { now: eveningTs, force: true, generateScene: false });
  assert.equal(diaryB.memoryId, null);
  assert.equal(diaryB.syncStatus, 'pending');

  // 1. Read-only reconcile on B discovers #100 (version A), keeps B as stale (NOT written!), 0 writes
  f.resetCounters();
  const reconciledB = await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });
  assert.equal(f.totalWriteCalls, 0);
  assert.equal(reconciledB.memoryId, 100);
  assert.equal(reconciledB.syncStatus, 'stale');
  assert.notEqual(reconciledB.graphStatus, 'ready');
  assert.deepEqual(f.memories[0], nativeASnapshot);

  // 2. Also test starting straight from pending B (memoryId: null) -> active writeMemory(B) updates #100 in place to B!
  const resetB = await generateDocument(f.client, f.store, f.role, 'diary', { now: eveningTs + 1000, force: true, generateScene: false });
  // Reset memoryId to null as if reconcileOnly hadn't run first
  resetB.memoryId = null;
  resetB.syncStatus = 'pending';
  await f.store.putDoc(resetB);

  f.resetCounters();
  const updatedB = await writeMemory(f.client, f.store, resetB.id);
  assert.equal(updatedB.memoryId, 100);
  assert.equal(updatedB.syncStatus, 'written');
  assert.equal(updatedB.graphStatus, 'ready');
  assert.equal(f.memories.length, 1, 'Must update #100 in place without creating duplicate row');
  assert.match(f.memories[0].summary, /重整后的晚间红茶日记/);
  assert.ok(readTriples(f.memories[0].knowledgeGraphJSON).some(tr => tr.object === '红茶'));
});

test('Auditor BUG-2 & UI Toast Regression: Failed prepareGraphDraft + leftover old graph G_A is rejected by follow-up enrichMemory, and formatMemoryToast never falsely reports saved', async t => {
  const f = createFixture(t);
  await setupWrittenDiaryA(f);

  f.setDoc({
    title: '图谱抽取失败的新版日记',
    body: '今天早上08:44起床，傍晚在厨房煮了红茶。',
    summary: '早上08:44起床，傍晚煮了红茶。'
  });
  const diaryB = await generateDocument(f.client, f.store, f.role, 'diary', { now: eveningTs, force: true, generateScene: false });

  // Force graph LLM failure during writeMemory(B) so graphDraftJSON === null while host keeps old graph A and loses receipt
  const origCompletions = f.client.chat.completions.create;
  f.client.chat.completions.create = async req => {
    if (String(req.messages?.[0]?.content || '').includes('TASK:MEMORY_GRAPH')) {
      throw new Error('图谱模型临时超时');
    }
    return origCompletions(req);
  };
  f.setUpdateBehavior('keep-old-graph-lost-receipt');

  await assert.rejects(writeMemory(f.client, f.store, diaryB.id), /回执丢失/);

  const reconciled = await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });
  assert.equal(reconciled.syncStatus, 'written');
  assert.equal(reconciled.graphDraftJSON, null);
  assert.equal(reconciled.graphStatus, 'uncertain');
  assert.equal(reconciled.graphVerifiedJSON, null);

  // Follow-up enrichMemory MUST NOT accept old Diary A's graph G_A onto Diary B!
  f.client.chat.completions.create = origCompletions;
  const enriched = await enrichMemory(f.client, f.store, diaryB.id);
  assert.notEqual(enriched.graphStatus, 'ready');
  assert.equal(enriched.graphStatus, 'error');
  assert.equal(enriched.graphVerifiedJSON, null);

  // UI formatMemoryToast verification (AC5)
  const toastStale = formatMemoryToast({ syncStatus: 'stale', syncError: '原生记忆 #100 仍为旧版本' }, false);
  assert.equal(toastStale.error, true);
  assert.doesNotMatch(toastStale.text, /文本已保存/);
  assert.match(toastStale.text, /仍为旧版本/);

  const toastUncertain = formatMemoryToast({ syncStatus: 'uncertain', syncError: '' }, false);
  assert.equal(toastUncertain.error, true);
  assert.doesNotMatch(toastUncertain.text, /文本已保存/);

  const toastWrittenGraphUncertain = formatMemoryToast(reconciled, false);
  assert.equal(toastWrittenGraphUncertain.error, true);
  assert.match(toastWrittenGraphUncertain.text, /文本已保存，图谱未完成/);
});

async function generateRetryDiaryB(f) {
  f.setDoc({
    title: '更新后的红茶日记',
    body: '今天早上08:44起床，傍晚煮了红茶并整理了书架。',
    summary: '早上08:44起床，傍晚煮红茶并整理书架。'
  });
  return generateDocument(f.client, f.store, f.role, 'diary', { now: eveningTs, force: true, generateScene: false });
}

test('UAT P1: stale retry preserves native edits made after read-only reconciliation, including after restart', async t => {
  for (const edit of ['text', 'graph']) {
    await t.test(edit, async t => {
      const f = createFixture(t);
      await setupWrittenDiaryA(f);
      const diaryB = await generateRetryDiaryB(f);
      f.setUpdateBehavior('fail-before-commit');
      await assert.rejects(writeMemory(f.client, f.store, diaryB.id), /落库前/);
      const stale = await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });
      assert.equal(stale.syncStatus, 'stale');
      const savedIntent = structuredClone(stale.pendingWrite);

      if (edit === 'text') f.memories[0].summary = '用户在原生界面补充的第三版 C';
      else f.memories[0].knowledgeGraphJSON = JSON.stringify([{ subject: '澪', relationship: '手动核对', object: '第三版图谱 C' }]);
      const nativeC = structuredClone(f.memories[0]);
      const restartedStore = createStore(f.client);
      await restartedStore.init();
      f.setUpdateBehavior('ok'); f.resetCounters();

      await assert.rejects(writeMemory(f.client, restartedStore, diaryB.id), /基准不一致/);
      assert.equal(f.totalWriteCalls, 0);
      assert.equal(f.counters.llmGraphCalls, 0);
      assert.deepEqual(f.memories[0], nativeC);
      assert.equal(f.memories.length, 1);
      const blocked = await restartedStore.getDoc(diaryB.id);
      assert.equal(blocked.syncStatus, 'uncertain');
      assert.deepEqual(blocked.pendingWrite, savedIntent, 'Keep the original baseline instead of adopting C');
      assert.notEqual(blocked.graphStatus, 'ready');

      const reconciled = await writeMemory(f.client, restartedStore, diaryB.id, { reconcileOnly: true });
      assert.equal(reconciled.syncStatus, 'uncertain');
      assert.equal(f.totalWriteCalls, 0);
      assert.deepEqual(f.memories[0], nativeC);
    });
  }
});

test('UAT P1: unchanged native baseline still permits an in-place stale retry after restart', async t => {
  const f = createFixture(t);
  await setupWrittenDiaryA(f);
  const diaryB = await generateRetryDiaryB(f);
  f.setUpdateBehavior('fail-before-commit');
  await assert.rejects(writeMemory(f.client, f.store, diaryB.id));
  await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });
  const restartedStore = createStore(f.client);
  await restartedStore.init();
  f.setUpdateBehavior('ok'); f.resetCounters();
  const retried = await writeMemory(f.client, restartedStore, diaryB.id);
  assert.equal(retried.syncStatus, 'written');
  assert.equal(retried.graphStatus, 'ready');
  assert.equal(retried.pendingWrite, null);
  assert.equal(retried.memoryId, 100);
  assert.equal(f.memories.length, 1);
  assert.equal(f.counters.updateCalls, 1);
  assert.equal(f.counters.llmGraphCalls, 0);
});

test('UAT P1: native text and graph edits during graph generation survive the final pre-write read', async t => {
  for (const edit of ['text', 'graph']) {
    await t.test(edit, async t => {
      const f = createFixture(t);
      await setupWrittenDiaryA(f);
      const diaryB = await generateRetryDiaryB(f);
      const complete = f.client.chat.completions.create;
      let nativeC;
      f.client.chat.completions.create = async request => {
        if (String(request.messages[0].content).includes('TASK:MEMORY_GRAPH')) {
          if (edit === 'text') f.memories[0].summary = '模型等待期间用户手动修订 C';
          else f.memories[0].knowledgeGraphJSON = JSON.stringify([{ subject: '澪', relationship: '手动核对', object: '等待期间修订的图谱 C' }]);
          nativeC = structuredClone(f.memories[0]);
        }
        return complete(request);
      };
      f.resetCounters();
      await assert.rejects(writeMemory(f.client, f.store, diaryB.id), /处理期间原生记忆或图谱已变化/);
      assert.equal(f.totalWriteCalls, 0);
      assert.deepEqual(f.memories[0], nativeC);
      const blocked = await f.store.getDoc(diaryB.id);
      assert.equal(blocked.syncStatus, 'uncertain');
      assert.ok(blocked.pendingWrite?.previousBasis);
      assert.notEqual(blocked.graphStatus, 'ready');
      const reconciled = await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });
      assert.equal(reconciled.syncStatus, 'uncertain');
      assert.equal(f.totalWriteCalls, 0);
    });
  }
});

test('UAT P2: a corrected native graph is accepted against its current draft despite old errors', async t => {
  for (const hadError of [false, true]) {
    await t.test(hadError ? 'after a failed repair attempt' : 'after read-only reconciliation', async t => {
      const f = createFixture(t);
      await setupWrittenDiaryA(f);
      const diaryB = await generateRetryDiaryB(f);
      f.setUpdateBehavior('keep-old-graph-lost-receipt');
      await assert.rejects(writeMemory(f.client, f.store, diaryB.id), /回执丢失/);
      let d = await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });
      assert.equal(d.graphStatus, 'uncertain');
      if (hadError) {
        d = await enrichMemory(f.client, f.store, diaryB.id);
        assert.equal(d.graphStatus, 'error');
      }
      const fixedGraph = readTriples(d.graphDraftJSON).reverse();
      f.memories[0].knowledgeGraphJSON = JSON.stringify([...fixedGraph, fixedGraph[0]]);
      const nativeB = structuredClone(f.memories[0]);
      const restartedStore = createStore(f.client);
      await restartedStore.init();
      f.resetCounters();
      const accepted = await enrichMemory(f.client, restartedStore, diaryB.id);
      assert.equal(accepted.syncStatus, 'written');
      assert.equal(accepted.graphStatus, 'ready');
      assert.equal(accepted.graphError, '');
      assert.equal(accepted.graphBasis, memoryBasis(nativeB));
      assert.equal(accepted.graphVerifiedJSON, nativeB.knowledgeGraphJSON);
      assert.equal(accepted.retrievalStatus, 'unverified');
      assert.equal(f.totalWriteCalls, 0);
      assert.equal(f.counters.llmGraphCalls, 0);
      assert.deepEqual(f.memories[0], nativeB);
      assert.equal((await restartedStore.getDoc(diaryB.id)).graphStatus, 'ready');
    });
  }
});

test('UAT P2: graph equality from an obsolete text basis cannot clear an old-graph warning', async t => {
  const f = createFixture(t);
  await setupWrittenDiaryA(f);
  const diaryB = await generateRetryDiaryB(f);
  f.setUpdateBehavior('keep-old-graph-lost-receipt');
  await assert.rejects(writeMemory(f.client, f.store, diaryB.id));
  const d = await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });
  f.memories[0].knowledgeGraphJSON = d.graphDraftJSON;
  f.memories[0].summary += '（原生端另有修订）';
  const changedNative = structuredClone(f.memories[0]);
  f.resetCounters();
  const result = await enrichMemory(f.client, f.store, diaryB.id);
  assert.equal(result.graphStatus, 'error');
  assert.equal(result.graphVerifiedJSON, null);
  assert.equal(f.totalWriteCalls, 0);
  assert.equal(f.counters.llmGraphCalls, 0);
  assert.deepEqual(f.memories[0], changedNative);
});

test('UAT P2: a graph appearing during repair is accepted only if it matches the current draft', async t => {
  for (const arrives of ['old graph', 'current draft']) {
    await t.test(arrives, async t => {
      const f = createFixture(t);
      const { nativeASnapshot } = await setupWrittenDiaryA(f);
      const diaryB = await generateRetryDiaryB(f);
      const complete = f.client.chat.completions.create;
      f.client.chat.completions.create = async request => {
        if (String(request.messages[0].content).includes('TASK:MEMORY_GRAPH')) throw new Error('图谱模型超时');
        return complete(request);
      };
      f.setUpdateBehavior('keep-old-graph-lost-receipt');
      await assert.rejects(writeMemory(f.client, f.store, diaryB.id), /回执丢失/);
      const d = await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });
      assert.equal(d.syncStatus, 'written');
      assert.equal(d.graphStatus, 'uncertain');
      assert.equal(d.graphDraftJSON, null);
      f.memories[0].knowledgeGraphJSON = null;
      let arrivingGraph;
      f.client.chat.completions.create = async request => {
        const result = await complete(request);
        if (String(request.messages[0].content).includes('TASK:MEMORY_GRAPH')) {
          const context = JSON.parse(request.messages[1].content);
          arrivingGraph = arrives === 'old graph' ? nativeASnapshot.knowledgeGraphJSON : buildGraph(result.choices[0].message.content, context, d);
          f.memories[0].knowledgeGraphJSON = arrivingGraph;
        }
        return result;
      };
      f.resetCounters();
      const result = await enrichMemory(f.client, f.store, diaryB.id);
      assert.equal(result.syncStatus, 'written');
      assert.equal(f.totalWriteCalls, 0);
      assert.equal(f.counters.llmGraphCalls, 1);
      assert.equal(f.memories[0].knowledgeGraphJSON, arrivingGraph);
      if (arrives === 'old graph') {
        assert.equal(result.graphStatus, 'error');
        assert.equal(result.graphVerifiedJSON, null);
        assert.match(result.graphError, /原生图谱已变化/);
        assert.equal((await enrichMemory(f.client, f.store, diaryB.id)).graphStatus, 'error');
      } else {
        assert.equal(result.graphStatus, 'ready');
        assert.equal(result.graphVerifiedJSON, arrivingGraph);
        assert.equal(result.graphError, '');
      }
      assert.equal(f.totalWriteCalls, 0);
    });
  }
});

test('UAT P2: repeated checks cannot accept a draft after native text changed during the previous check', async t => {
  const f = createFixture(t);
  await setupWrittenDiaryA(f);
  const diaryB = await generateRetryDiaryB(f);
  f.setUpdateBehavior('keep-old-graph-lost-receipt');
  await assert.rejects(writeMemory(f.client, f.store, diaryB.id));
  const d = await writeMemory(f.client, f.store, diaryB.id, { reconcileOnly: true });
  f.memories[0].knowledgeGraphJSON = null;
  const list = f.client.memories.list;
  let reads = 0;
  f.client.memories.list = async (...args) => {
    if (++reads === 2) {
      f.memories[0].summary += '（核对期间原生端修订 C）';
      f.memories[0].knowledgeGraphJSON = d.graphDraftJSON;
    }
    return list(...args);
  };
  f.resetCounters();
  const first = await enrichMemory(f.client, f.store, diaryB.id);
  assert.equal(first.graphStatus, 'error');
  assert.match(first.graphError, /原生记忆已变化/);
  const nativeC = structuredClone(f.memories[0]);
  assert.notEqual(first.graphDraftBasis, memoryBasis(nativeC));

  const restartedStore = createStore(f.client);
  await restartedStore.init();
  for (const reconcileOnly of [true, false, true]) {
    const checked = await enrichMemory(f.client, restartedStore, diaryB.id, { reconcileOnly });
    assert.notEqual(checked.graphStatus, 'ready');
    assert.equal(checked.graphVerifiedJSON, null);
    assert.deepEqual(f.memories[0], nativeC);
  }
  assert.equal(f.totalWriteCalls, 0);
  assert.equal(f.counters.llmGraphCalls, 0);
});
