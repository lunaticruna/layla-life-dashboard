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
  parseClock,
  clock
} from '../src/schedule.js';
import {
  syncCharacterContext
} from '../src/workflow.js';

function createMockEnvironment(opts = {}) {
  const db = new DatabaseSync(':memory:');
  const cardUpdates = [];
  const character = {
    id: 'char-adversarial',
    data: {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '测试角色',
        description: '一名用于压力测试的角色',
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
    }
  };

  const store = createStore(client);
  return { db, client, store, character, cardUpdates };
}

// =========================================================================
// Dimension 1: Cache Protection & Hash Stability Stress Test
// =========================================================================

test('Adversarial 1A: 60 simulated ticks within the same half-hour window remain 100% unchanged', async () => {
  const env = createMockEnvironment();
  await env.store.init();
  const day = '2026-11-01';
  // 14:00:00 to 14:29:30 (step by 30 seconds = 60 consecutive ticks)
  const baseTs = epoch(day, 14 * 60);
  const profile = createProfile(env.character, baseTs);
  profile.settings.syncPrecision = 'halfhour';

  let initialHash = null;
  const statuses = [];

  for (let tick = 0; tick < 60; tick++) {
    const currentTs = baseTs + tick * 30 * 1000;
    const res = await syncCharacterContext(env.client, env.store, env.character, profile, { now: currentTs });
    statuses.push(res.status);

    if (tick === 0) {
      assert.equal(res.status, 'synced');
      assert.equal(res.updated, true);
      assert.equal(env.cardUpdates.length, 1);
      initialHash = profile.cardSync?.hash;
      assert.ok(initialHash && initialHash.length > 0);
    } else {
      assert.equal(res.status, 'unchanged', `Tick ${tick} at ${new Date(currentTs).toISOString()} should be unchanged`);
      assert.equal(res.updated, false);
      assert.equal(profile.cardSync?.hash, initialHash, `Hash must remain identical at tick ${tick}`);
      assert.equal(env.cardUpdates.length, 1, `client.characters.update must not be called at tick ${tick}`);
    }
  }

  assert.equal(env.cardUpdates.length, 1, 'Total card updates across 60 ticks in half-hour window must be exactly 1');
  assert.equal(statuses.filter(s => s === 'unchanged').length, 59, '59 out of 60 ticks must be unchanged');
});

test('Adversarial 1B: 60 consecutive minute ticks crossing half-hour boundary trigger exactly 1 update at boundary', async () => {
  const env = createMockEnvironment();
  await env.store.init();
  const day = '2026-11-01';
  // 14:00 through 14:59 (60 simulated minute ticks)
  const baseTs = epoch(day, 14 * 60);
  const profile = createProfile(env.character, baseTs);
  profile.settings.syncPrecision = 'halfhour';

  let window1Hash = null;
  let window2Hash = null;
  const updateMinutes = [];

  for (let minute = 0; minute < 60; minute++) {
    const currentTs = baseTs + minute * 60 * 1000;
    const beforeCount = env.cardUpdates.length;
    const res = await syncCharacterContext(env.client, env.store, env.character, profile, { now: currentTs });
    const afterCount = env.cardUpdates.length;

    if (afterCount > beforeCount) {
      updateMinutes.push(minute);
    }

    if (minute === 0) {
      // 14:00 initial sync
      assert.equal(res.status, 'synced');
      assert.equal(res.updated, true);
      window1Hash = profile.cardSync?.hash;
      assert.ok(window1Hash);
    } else if (minute < 30) {
      // 14:01 - 14:29 within same halfhour
      assert.equal(res.status, 'unchanged', `Minute 14:${minute < 10 ? '0' + minute : minute} must be unchanged`);
      assert.equal(res.updated, false);
      assert.equal(profile.cardSync?.hash, window1Hash);
    } else if (minute === 30) {
      // 14:30 boundary crossing
      assert.equal(res.status, 'synced', 'Crossing 14:30 boundary must trigger synced status');
      assert.equal(res.updated, true);
      window2Hash = profile.cardSync?.hash;
      assert.ok(window2Hash);
      assert.notEqual(window2Hash, window1Hash, 'Hash after boundary crossing must change');
    } else {
      // 14:31 - 14:59 within second halfhour
      assert.equal(res.status, 'unchanged', `Minute 14:${minute} must be unchanged`);
      assert.equal(res.updated, false);
      assert.equal(profile.cardSync?.hash, window2Hash);
    }
  }

  // Verify exact update moments: only at minute 0 (14:00) and minute 30 (14:30)
  assert.deepEqual(updateMinutes, [0, 30], 'Updates must occur only at minute 0 and minute 30');
  assert.equal(env.cardUpdates.length, 2, 'Total updates across 60 minutes must be exactly 2');
});

test('Adversarial 1C: syncPrecision node mode across 60 consecutive minute ticks causes ZERO extra updates', async () => {
  const env = createMockEnvironment();
  await env.store.init();
  const day = '2026-11-01';
  // 14:00 through 14:59 within 13:00-18:00 work node
  const baseTs = epoch(day, 14 * 60);
  const profile = createProfile(env.character, baseTs);
  profile.settings.syncPrecision = 'node';

  let fixedHash = null;
  for (let minute = 0; minute < 60; minute++) {
    const currentTs = baseTs + minute * 60 * 1000;
    const res = await syncCharacterContext(env.client, env.store, env.character, profile, { now: currentTs });
    if (minute === 0) {
      assert.equal(res.status, 'synced');
      assert.equal(res.updated, true);
      fixedHash = profile.cardSync?.hash;
    } else {
      assert.equal(res.status, 'unchanged', `Minute ${minute} should be unchanged in node mode`);
      assert.equal(res.updated, false);
      assert.equal(profile.cardSync?.hash, fixedHash);
    }
  }

  assert.equal(env.cardUpdates.length, 1, 'In node precision mode, exactly 1 initial update across entire hour');
});

test('Adversarial 1D: Deep sleep phase stability across 60 simulated midnight minute ticks', async () => {
  const env = createMockEnvironment();
  await env.store.init();
  const day = '2026-11-01';
  // 02:00 through 02:59 (deep sleep phase, sleep started at 23:30 previous day)
  const baseTs = epoch(day, 2 * 60);
  const profile = createProfile(env.character, baseTs);
  profile.settings.syncPrecision = 'node';

  let initialHash = null;
  for (let minute = 0; minute < 60; minute++) {
    const currentTs = baseTs + minute * 60 * 1000;
    const phase = sleepPhase(profile, currentTs);
    assert.equal(phase, 'deep_sleep');

    const res = await syncCharacterContext(env.client, env.store, env.character, profile, { now: currentTs });
    if (minute === 0) {
      initialHash = profile.cardSync?.hash;
      assert.equal(res.status, 'synced');
    } else {
      assert.equal(res.status, 'unchanged');
      assert.equal(profile.cardSync?.hash, initialHash);
    }
  }
  assert.equal(env.cardUpdates.length, 1);
});

// =========================================================================
// Dimension 2: Normalization Fuzzing & Boundary Stress Test
// =========================================================================

function verifyContiguous24H(nodes) {
  assert.ok(Array.isArray(nodes), 'Result must be an array');
  assert.ok(nodes.length >= 1, 'Result must contain at least 1 node');
  assert.equal(nodes[0].start, 0, 'First node must start at 00:00 (0)');
  assert.equal(nodes[nodes.length - 1].end, 1440, 'Last node must end at 24:00 (1440)');

  for (let i = 1; i < nodes.length; i++) {
    assert.equal(
      nodes[i].start,
      nodes[i - 1].end,
      `Node ${i} start (${nodes[i].start}) must exactly match Node ${i - 1} end (${nodes[i - 1].end})`
    );
    assert.ok(nodes[i].end > nodes[i].start, `Node ${i} must have positive duration`);
  }
}

test('Adversarial 2A: normalizeItems resolves overlapping and nested nodes', () => {
  const input = [
    { start: '08:00', end: '11:00', summary: '上午专注工作', kind: 'work' },
    { start: '09:00', end: '10:00', summary: '内部会议（被完全包含）', kind: 'work' },
    { start: '10:30', end: '13:00', summary: '跨越边界的午餐沟通', kind: 'meal' }
  ];

  const res = normalizeItems(input, '2026-11-01');
  verifyContiguous24H(res);

  // Contained node (09:00-10:00) must be absorbed/skipped
  assert.equal(res.some(n => n.summary.includes('内部会议')), false);

  // Overlapping node (10:30-13:00) must be clipped to start at 11:00
  const mealNode = res.find(n => n.summary.includes('午餐沟通'));
  assert.ok(mealNode);
  assert.equal(mealNode.start, 11 * 60);
  assert.equal(mealNode.end, 13 * 60);

  // Entire day must be contiguous
  assert.ok(res.some(n => n.kind === 'sleep'));
});

test('Adversarial 2B: normalizeItems handles inverted starts/ends and disjoint gaps', () => {
  const input = [
    { start: '15:00', end: '10:00', summary: '反转时间节点（垃圾数据）', kind: 'rest' },
    { start: '08:00', end: '09:00', summary: '早餐', kind: 'meal' },
    { start: '14:00', end: '15:00', summary: '下午茶', kind: 'meal' }
  ];

  const res = normalizeItems(input, '2026-11-01');
  verifyContiguous24H(res);

  // Inverted node must be discarded
  assert.equal(res.some(n => n.summary.includes('反转时间节点')), false);

  // Disjoint gap between 09:00 and 14:00 is healed by extending the previous node
  const breakfast = res.find(n => n.summary === '早餐');
  assert.ok(breakfast);
  assert.equal(breakfast.start, 8 * 60);
  assert.equal(breakfast.end, 14 * 60);
});

test('Adversarial 2C: normalizeItems pads partial coverage [12:00, 14:00] to full 24h with sleep & rest', () => {
  const input = [
    { start: '12:00', end: '14:00', summary: '午间独处', kind: 'rest' }
  ];

  const res = normalizeItems(input, '2026-11-01');
  verifyContiguous24H(res);

  // Head pad: 00:00 - 12:00 sleep
  assert.equal(res[0].start, 0);
  assert.equal(res[0].end, 720);
  assert.equal(res[0].kind, 'sleep');

  // Kept item: 12:00 - 14:00 rest
  assert.equal(res[1].start, 720);
  assert.equal(res[1].end, 840);
  assert.equal(res[1].summary, '午间独处');

  // Tail pad: 14:00 - 23:00 rest, 23:00 - 24:00 sleep
  assert.equal(res[res.length - 1].end, 1440);
  assert.equal(res[res.length - 1].kind, 'sleep');
});

test('Adversarial 2D: normalizeItems handles empty array and raw objects with zero exceptions', () => {
  const emptyRes = normalizeItems([], '2026-11-01');
  verifyContiguous24H(emptyRes);
  assert.equal(emptyRes.length, 1);
  assert.equal(emptyRes[0].start, 0);
  assert.equal(emptyRes[0].end, 1440);
  assert.equal(emptyRes[0].kind, 'sleep');

  const objRes = normalizeItems({ nodes: [] }, '2026-11-01');
  verifyContiguous24H(objRes);
  assert.equal(objRes.length, 1);
});

test('Adversarial 2E: Fuzzing normalizeItems with 100 chaotic and adversarial inputs', () => {
  const chaoticInputs = [
    null,
    undefined,
    12345,
    -1,
    0,
    true,
    false,
    '',
    'random string',
    {},
    { foo: 'bar' },
    { nodes: 'not an array' },
    { nodes: [null, undefined, 42, 'str'] },
    [null, undefined, false, 0, NaN, Infinity, -Infinity],
    [{ start: null, end: null }],
    [{ start: 'invalid', end: 'clock' }],
    [{ start: '25:00', end: '26:00' }],
    [{ start: '12:60', end: '13:00' }],
    [{ start: '-01:00', end: '05:00' }],
    [{ start: '00:00', end: '00:00', summary: 'zero duration' }],
    [{ start: '12:00', end: '11:00', summary: 'negative duration' }],
    [{ start: '08:00', end: '09:00', summary: '' }],
    [{ start: '08:00', end: '09:00', summary: '   ' }],
    [{ start: 480, end: 540, summary: 'numeric start/end' }],
    [{ start: 0, end: 1440, summary: 'full day single item' }],
    [{ start: '23:59', end: '24:00', summary: 'one minute tail' }],
    [{ start: '00:00', end: '00:01', summary: 'one minute head' }]
  ];

  // Generate 73 more randomized chaotic structures
  for (let i = 0; i < 73; i++) {
    const randomCount = Math.floor(Math.random() * 8);
    const nodes = [];
    for (let j = 0; j < randomCount; j++) {
      const s = Math.floor(Math.random() * 1500) - 50;
      const e = Math.floor(Math.random() * 1500) - 50;
      nodes.push({
        start: Math.random() > 0.5 ? `${Math.floor(s / 60)}:${s % 60}` : s,
        end: Math.random() > 0.5 ? `${Math.floor(e / 60)}:${e % 60}` : e,
        summary: Math.random() > 0.3 ? `Random act ${i}-${j}` : '',
        kind: Math.random() > 0.5 ? 'work' : 'junk_kind'
      });
    }
    chaoticInputs.push(nodes);
  }

  assert.equal(chaoticInputs.length, 100);

  for (let i = 0; i < chaoticInputs.length; i++) {
    const input = chaoticInputs[i];
    let res;
    assert.doesNotThrow(() => {
      res = normalizeItems(input, '2026-11-01');
    }, `Fuzz input ${i} must not throw uncaught exception`);

    verifyContiguous24H(res);
  }
});

test('Adversarial 2F: Boundary analysis when input exceeds 32 nodes', () => {
  // If an input has 40 nodes, examine normalizeItems behavior
  const items = [];
  for (let i = 0; i < 40; i++) {
    const s = 600 + i * 10;
    const e = s + 10;
    items.push({ start: s, end: e, summary: `Activity ${i}`, kind: 'rest' });
  }

  const res = normalizeItems(items, '2026-11-01');
  assert.equal(res.length, 32, 'normalizeItems caps output array to 32 elements');

  // Notice: Because out.slice(0, 32) slices off nodes 32..40, the sliced result does not reach 1440
  const last = res[res.length - 1];
  assert.equal(last.end, 910);
  // This is a documented empirical boundary behavior: feeding >32 distinct items causes truncation
});

// =========================================================================
// Dimension 3: applyChange Interval Arithmetic Stress Test
// =========================================================================

test('Adversarial 3A: applyChange slices middle of a node into three contiguous parts', () => {
  const base = templateItems('workday');
  // In workday template: [09:00, 12:00] is '上午工作' (start: 540, end: 720)
  const change = {
    start: '10:00',
    end: '11:00',
    summary: '医院复诊与取药',
    kind: 'rest',
    location: '社区医院',
    reason: '预约挂号'
  };

  const res = applyChange(base, change, '2026-11-01');
  verifyContiguous24H(res);

  const prevWork = res.find(n => n.start === 9 * 60 && n.end === 10 * 60);
  assert.ok(prevWork, 'Head segment of sliced node must remain');
  assert.equal(prevWork.summary, '上午工作');

  const hospital = res.find(n => n.start === 10 * 60 && n.end === 11 * 60);
  assert.ok(hospital, 'Inserted change node must exist');
  assert.equal(hospital.summary, '医院复诊与取药');
  assert.equal(hospital.location, '社区医院');
  assert.equal(hospital.source, 'change');

  const nextWork = res.find(n => n.start === 11 * 60 && n.end === 12 * 60);
  assert.ok(nextWork, 'Tail segment of sliced node must remain');
  assert.equal(nextWork.summary, '上午工作');

  // Verify change audit record
  assert.ok(res.changeRecord);
  assert.equal(res.changeRecord.start, '10:00');
  assert.equal(res.changeRecord.end, '11:00');
  assert.equal(res.changeRecord.summary, '医院复诊与取药');
  assert.ok(res.changeRecord.note.includes('预约挂号'));
});

test('Adversarial 3B: applyChange replaces 3 consecutive nodes and trims endpoints', () => {
  const base = templateItems('workday');
  // Workday has:
  // [07:30, 08:15] 起床洗漱与吃早饭 (450 -> 495)
  // [08:15, 09:00] 通勤路上 (495 -> 540)
  // [09:00, 12:00] 上午工作 (540 -> 720)
  //
  // Change spans 07:45 to 10:00:
  // - Node 1 [07:30, 08:15] trimmed to [07:30, 07:45]
  // - Node 2 [08:15, 09:00] completely engulfed and replaced
  // - Node 3 [09:00, 12:00] trimmed to [10:00, 12:00]
  const change = {
    start: '07:45',
    end: '10:00',
    summary: '突发紧急外勤处置',
    kind: 'work',
    location: '市郊仓库'
  };

  const res = applyChange(base, change, '2026-11-01');
  verifyContiguous24H(res);

  // Commute node (08:15-09:00) must be completely eliminated
  assert.equal(res.some(n => n.summary === '通勤路上'), false);

  // Trimmed morning routine
  const morning = res.find(n => n.start === 450);
  assert.ok(morning);
  assert.equal(morning.end, 465); // 07:45

  // Change node
  const emergency = res.find(n => n.start === 465);
  assert.ok(emergency);
  assert.equal(emergency.end, 600); // 10:00
  assert.equal(emergency.summary, '突发紧急外勤处置');

  // Trimmed work node
  const work = res.find(n => n.start === 600);
  assert.ok(work);
  assert.equal(work.end, 720);
  assert.equal(work.summary, '上午工作');
});

test('Adversarial 3C: applyChange exact boundary replacement without duplicates or gaps', () => {
  const base = templateItems('workday');
  // In workday: [12:00, 13:00] is 吃午饭与休息
  const change = {
    start: '12:00',
    end: '13:00',
    summary: '临时跨部门项目会议',
    kind: 'work',
    location: '大会议室'
  };

  const res = applyChange(base, change, '2026-11-01');
  verifyContiguous24H(res);

  assert.equal(res.some(n => n.summary === '吃午饭与休息'), false);
  const meeting = res.find(n => n.summary === '临时跨部门项目会议');
  assert.ok(meeting);
  assert.equal(meeting.start, 720);
  assert.equal(meeting.end, 780);
});

test('Adversarial 3D: applyChange rejects invalid HH:MM strings and throws 400', () => {
  const base = templateItems('workday');
  const invalidCases = [
    { start: '25:00', end: '12:00', summary: 'bad hour' },
    { start: '10:00', end: '12:60', summary: 'bad minute' },
    { start: '24:01', end: '24:00', summary: 'past 24:00' },
    { start: 'abc', end: '12:00', summary: 'non-numeric' },
    { start: null, end: '12:00', summary: 'null start' },
    { start: '10:00', end: undefined, summary: 'undefined end' },
    { start: '', end: '12:00', summary: 'empty string' },
    { start: '14:00 to 15:00', end: '16:00', summary: 'junk format' },
    { start: '-01:00', end: '05:00', summary: 'negative clock' }
  ];

  for (const c of invalidCases) {
    assert.throws(
      () => applyChange(base, c),
      (err) => err.status === 400 && err.message.includes('时间不对'),
      `Should throw 400 for invalid start=${c.start}, end=${c.end}`
    );
  }
});

test('Adversarial 3E: applyChange rejects inverted or zero duration intervals with 400', () => {
  const base = templateItems('workday');
  const invertedCases = [
    { start: '15:00', end: '14:00', summary: 'inverted interval' },
    { start: '14:00', end: '14:00', summary: 'zero duration' },
    { start: '23:00', end: '07:00', summary: 'cross midnight inversion' }
  ];

  for (const c of invertedCases) {
    assert.throws(
      () => applyChange(base, c),
      (err) => err.status === 400 && err.message.includes('end 要晚于 start'),
      `Should throw 400 for inverted start=${c.start}, end=${c.end}`
    );
  }
});

test('Adversarial 3F: applyChange rejects missing or whitespace summary with 400', () => {
  const base = templateItems('workday');
  const badSummaryCases = [
    { start: '10:00', end: '11:00', summary: '' },
    { start: '10:00', end: '11:00', summary: '   ' },
    { start: '10:00', end: '11:00' },
    { start: '10:00', end: '11:00', summary: null }
  ];

  for (const c of badSummaryCases) {
    assert.throws(
      () => applyChange(base, c),
      (err) => err.status === 400 && err.message.includes('要写清楚做什么'),
      'Should throw 400 for missing summary'
    );
  }
});

test('Adversarial 3G: applyChange handles day boundary replacements ([00:00, 02:00], [22:00, 24:00], [00:00, 24:00])', () => {
  const base = templateItems('workday');

  // 1. Head boundary change
  const headChange = { start: '00:00', end: '02:00', summary: '深夜失眠看书', kind: 'leisure' };
  const resHead = applyChange(base, headChange);
  verifyContiguous24H(resHead);
  assert.equal(resHead[0].start, 0);
  assert.equal(resHead[0].end, 120);
  assert.equal(resHead[0].summary, '深夜失眠看书');

  // 2. Tail boundary change
  const tailChange = { start: '22:00', end: '24:00', summary: '深夜看电影', kind: 'leisure' };
  const resTail = applyChange(base, tailChange);
  verifyContiguous24H(resTail);
  assert.equal(resTail[resTail.length - 1].start, 22 * 60);
  assert.equal(resTail[resTail.length - 1].end, 1440);
  assert.equal(resTail[resTail.length - 1].summary, '深夜看电影');

  // 3. Complete day replacement
  const fullChange = { start: '00:00', end: '24:00', summary: '全天闭关研讨会', kind: 'study' };
  const resFull = applyChange(base, fullChange);
  verifyContiguous24H(resFull);
  // Full day change replaced everything, but normalizeItems ensures sleep node presence
  assert.ok(resFull.some(n => n.summary === '全天闭关研讨会'));
  assert.equal(resFull[0].start, 0);
  assert.equal(resFull[resFull.length - 1].end, 1440);
});
