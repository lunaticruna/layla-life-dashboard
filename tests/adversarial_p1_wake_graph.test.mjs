import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractWakeMentions,
  extractWakeMention,
  wakeMinuteInterval,
  hasUnconfirmedWakeTime,
  memoryPayload,
  documentId,
  epoch
} from '../src/core.js';
import {
  buildGraph,
  graphContext,
  readTriples
} from '../src/memory-graph.js';

test('P1 Adversarial Challenge 1: Combinatorial Fuzzing (576 combinations) & Minute Interval Math', () => {
  const prePrefixes = ['大概', '大约', '约', ''];
  const timeSpecifiers = ['8点', '08:44', '8点半', '8点20分', '十点', '10:30'];
  const postSuffixes = ['多', '左右', '前后', '刚', '才', ''];
  const wakeVerbs = ['起床', '醒来', '从被窝里爬出来', '睁开眼'];

  const expectedTimes = {
    '8点': '08:00',
    '08:44': '08:44',
    '8点半': '08:30',
    '8点20分': '08:20',
    '十点': '10:00',
    '10:30': '10:30'
  };

  let totalTested = 0;
  const failures = [];

  for (const pre of prePrefixes) {
    for (const time of timeSpecifiers) {
      for (const post of postSuffixes) {
        for (const verb of wakeVerbs) {
          totalTested++;
          const text = `今天${pre}${time}${post}${verb}。`;
          const mentions = extractWakeMentions(text);

          if (mentions.length === 0) {
            failures.push({ text, reason: 'No mention extracted' });
            continue;
          }

          const m = mentions[0];
          const isFuzzy = Boolean(pre) || ['多', '左右', '前后'].includes(post);

          if (isFuzzy) {
            if (m.exact !== false) {
              failures.push({ text, phrase: m.phrase, reason: `Expected exact: false, got exact: ${m.exact}` });
            }
            if (m.minMinute == null || m.maxMinute == null) {
              failures.push({ text, phrase: m.phrase, reason: 'minMinute/maxMinute missing' });
            }
          }
        }
      }
    }
  }

  // If failures exist, assert fails with list of unhandled fuzzy combinations
  assert.equal(
    failures.length,
    0,
    `Combinatorial fuzzing found ${failures.length} unhandled/misclassified fuzzy combinations:\n` +
    JSON.stringify(failures.slice(0, 10), null, 2)
  );
  assert.equal(totalTested, 576);
});

test('P1 Adversarial Challenge 2: Conflict Interception Verification (Confirmed 08:44 Baseline)', () => {
  const confirmedTime = '08:44'; // Minute 524

  // Conflicting expressions must return true (hasUnconfirmedWakeTime === true)
  const conflictingExpressions = [
    '十点多才起床',
    '大概十点醒来',
    '七点左右从被窝里爬出来',
    '大约7:30醒来',
    '11点前后睁开眼',
    '今天早上大概6:30起床',
    '约12点醒来',
    '今天大约9:30起床',
    '7点前后起床',
    '今天大概07:50从被窝里爬出来',
    '大约10:30起床'
  ];

  for (const expr of conflictingExpressions) {
    const isConflict = hasUnconfirmedWakeTime(expr, confirmedTime);
    assert.equal(isConflict, true, `Expected conflict for "${expr}" against confirmed "${confirmedTime}"`);
  }

  // Compatible expressions must return false (hasUnconfirmedWakeTime === false)
  const compatibleExpressions = [
    '八点多起床',
    '大约8:30醒来',
    '8点半多才从被窝里爬出来',
    '8点40左右睁开眼',
    '大概8点35起床',
    '约8点半醒来',
    '8点44醒来'
  ];

  for (const expr of compatibleExpressions) {
    const isConflict = hasUnconfirmedWakeTime(expr, confirmedTime);
    assert.equal(isConflict, false, `Expected compatible for "${expr}" against confirmed "${confirmedTime}"`);
  }
});

test('P1 Adversarial Challenge 3: Plan Exclusions Adversarial Checks', () => {
  const cases = [
    {
      text: '平时计划大约8:00起床，今天8:44醒来',
      expectedPhrase: '8:44醒来',
      expectedTime: '08:44'
    },
    {
      text: '原本打算大概7:30起床，结果8点多才从被窝里爬出来',
      expectedPhrase: '8点多才从被窝里爬出来',
      expectedTime: '08:00',
      expectedExact: false
    },
    {
      text: '习惯早上约8点醒来，今天十点多才睁开眼',
      expectedPhrase: '十点多才睁开眼',
      expectedTime: '10:00',
      expectedExact: false
    },
    {
      text: '一般计划8点半起床，今天8:44醒来',
      expectedPhrase: '8:44醒来',
      expectedTime: '08:44'
    },
    {
      text: '打算早上大概7:00起床，实际十点多才醒',
      expectedPhrase: '十点多才醒',
      expectedTime: '10:00',
      expectedExact: false
    }
  ];

  const failures = [];
  for (const c of cases) {
    const mentions = extractWakeMentions(c.text);
    if (mentions.length !== 1) {
      failures.push({ text: c.text, gotLength: mentions.length, reason: 'Expected exactly 1 extracted mention' });
      continue;
    }
    const m = mentions[0];
    if (m.phrase !== c.expectedPhrase || m.time !== c.expectedTime) {
      failures.push({ text: c.text, expected: c.expectedPhrase, got: m.phrase });
    }
    if (c.expectedExact !== undefined && m.exact !== c.expectedExact) {
      failures.push({ text: c.text, expectedExact: c.expectedExact, gotExact: m.exact });
    }
  }

  assert.equal(
    failures.length,
    0,
    `Plan exclusions checks failed on ${failures.length} cases:\n` + JSON.stringify(failures, null, 2)
  );
});

test('P1 Adversarial Challenge 4: Graph Projection Invariance (Direct 1-Hop Ban for All Fuzzy Expressions)', () => {
  const roleName = '瑠璃子';
  const characterId = 'custom-6';
  const now = epoch('2026-11-01', 524);

  const testPhrases = [
    // Standard fuzzy phrases
    '十点多起床',
    '大概十点起床',
    '七点左右起床',
    '大约8:30醒来',
    '八点多起床',
    // Colon-formatted / minute-number fuzzy phrases with 多
    '10:30多起床',
    '8点20多起床'
  ];

  const violations = [];

  for (const phrase of testPhrases) {
    const mention = extractWakeMention(phrase);
    const docWakeTime = mention?.time || '08:44';

    const diaryDoc = {
      id: documentId(characterId, 'diary', '2026-11-01'),
      characterId,
      sessionId: 'sess-test',
      kind: 'diary',
      day: '2026-11-01',
      title: '日常测试',
      body: `今天${phrase}，随后在书房看书。`,
      summary: `${phrase}，看书。`,
      createdAt: now,
      syncStatus: 'pending',
      timelineFacts: { wakeTime: docWakeTime, wakeSource: 'manual' }
    };

    const gCtx = graphContext(diaryDoc, { rawText: diaryDoc.body, summary: diaryDoc.summary }, roleName);
    const mockTriples = JSON.stringify([
      { subject: gCtx.recordNode, relationship: '记录中作息', object: phrase },
      { subject: gCtx.recordNode, relationship: '记录中动作', object: '看书' }
    ]);

    const graphJson = buildGraph(mockTriples, gCtx, diaryDoc, { strict: false });
    const triples = readTriples(graphJson);

    // Direct 1-hop triples check:
    const directTriples = triples.filter(t => t.subject === roleName);
    for (const dt of directTriples) {
      if (dt.object.includes('起床') || dt.object.includes('醒来') || dt.object.includes(phrase) || dt.relationship.includes('作息')) {
        violations.push({
          phrase,
          projectedDirectTriple: dt,
          reason: 'Fuzzy wake phrase projected into 1-hop character direct attributes'
        });
      }
    }
  }

  assert.equal(
    violations.length,
    0,
    `Graph projection invariance violated for ${violations.length} phrases:\n` + JSON.stringify(violations, null, 2)
  );
});
