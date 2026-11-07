import { createZip, uint8ArrayToBase64, stringToBase64 } from './zip.js';
import { readTriples } from './memory-graph.js';
import { VERSION, dailyTimelineFacts, extractWakeMention } from './core.js';

/**
 * Safely extracts knowledge graph triples from a string or object.
 * @param {string | object} source
 * @returns {Array<{ subject: string, relationship: string, object: string }>}
 */
function extractTriplesFromSource(source) {
  if (!source) return [];
  try {
    return readTriples(source);
  } catch {
    try {
      const parsed = typeof source === 'string' ? JSON.parse(source) : source;
      const list = Array.isArray(parsed) ? parsed : (parsed?.triples || parsed?.relations || parsed?.edges || []);
      if (!Array.isArray(list)) return [];
      const result = [];
      for (const item of list) {
        const subject = String(item?.subject ?? item?.from ?? item?.source ?? '').trim();
        const relationship = String(item?.relationship ?? item?.relation ?? item?.label ?? '').trim();
        const object = String(item?.object ?? item?.to ?? item?.target ?? '').trim();
        if (subject && relationship && object) {
          result.push({ subject, relationship, object });
        }
      }
      return result;
    } catch {
      return [];
    }
  }
}

/**
 * Consolidates and deduplicates knowledge graph triples across documents and native memories.
 * @param {Array<object>} documents
 * @param {Array<object>} nativeMemories
 * @returns {Array<{ subject: string, relationship: string, object: string }>}
 */
export function consolidateKnowledgeGraph(documents = [], nativeMemories = []) {
  const map = new Map();

  for (const doc of (documents || [])) {
    const list = extractTriplesFromSource(doc?.graphVerifiedJSON || doc?.graphDraftJSON);
    for (const t of list) {
      const key = `${t.subject}::${t.relationship}::${t.object}`;
      if (!map.has(key)) map.set(key, t);
    }
  }

  for (const mem of (nativeMemories || [])) {
    const list = extractTriplesFromSource(mem?.knowledgeGraphJSON);
    for (const t of list) {
      const key = `${t.subject}::${t.relationship}::${t.object}`;
      if (!map.has(key)) map.set(key, t);
    }
  }

  return Array.from(map.values());
}

/**
 * Extracts schedule plans and timeline facts from profile and documents.
 * @param {object} profile
 * @param {Array<object>} documents
 * @returns {object}
 */
export function extractScheduleAndTimelineFacts(profile = {}, documents = [], { scenes = [], now = Date.now() } = {}) {
  const dailyFacts = {};
  for (const doc of (documents || [])) {
    if (doc?.day && doc.timelineFacts) {
      if (!dailyFacts[doc.day] || doc.kind === 'diary') {
        dailyFacts[doc.day] = doc.timelineFacts;
      }
    } else if (doc?.day && doc.kind === 'diary') {
      const wake = extractWakeMention(doc.summary) || extractWakeMention(doc.body);
      if (wake && (!dailyFacts[doc.day] || doc.kind === 'diary')) {
        dailyFacts[doc.day] = {
          day: doc.day,
          wakeTime: wake.time,
          wakePhrase: wake.phrase,
          wakeSource: 'diary',
          wakeSummary: `${wake.time}（日记记录“${wake.phrase}”）`
        };
      }
    }
  }
  for (const day of Object.keys(profile.wakeRecords || {})) {
    const facts = dailyTimelineFacts(profile, scenes, day, now, documents);
    if (facts.wakeTime) dailyFacts[day] = facts;
  }

  return {
    timezone: profile?.settings?.timezone || 'Asia/Shanghai',
    sleepSettings: {
      sleepStart: profile?.settings?.sleepStart || '23:30',
      sleepEnd: profile?.settings?.sleepEnd || '08:00',
      home: profile?.settings?.home || '家里'
    },
    plans: profile?.plans || {},
    dailyFacts,
    timelineFacts: dailyFacts
  };
}

/**
 * Paginates through client.memories.list to retrieve all native memories for a character.
 * @param {object} client
 * @param {string} characterId
 * @returns {Promise<Array<object>>}
 */
export async function fetchAllNativeMemories(client, characterId) {
  if (!client?.memories || typeof client.memories.list !== 'function') return [];
  const memories = [];
  const limit = 50;
  const maxPages = 200; // Safe upper bound: up to 10,000 memories
  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;
    try {
      const batch = await client.memories.list(characterId, offset, limit);
      if (!Array.isArray(batch) || batch.length === 0) break;
      memories.push(...batch);
      if (batch.length < limit) break;
    } catch (err) {
      console.warn('Native memories read fallback:', err);
      break;
    }
  }
  return memories;
}

/**
 * Exports full character backup as a structured ZIP archive, with graceful fallback to single structured JSON.
 * @param {object} state
 * @param {object} store
 * @param {object} client
 * @param {object} [opts]
 * @returns {Promise<{ filename: string, base64: string, isZip: boolean, stats: object }>}
 */
export async function exportCharacterBackup(state, store, client, opts = {}) {
  const characterId = state?.character?.id || state?.profile?.characterId || 'default-character';
  const characterName = state?.character?.data?.data?.name || state?.profile?.name || characterId;
  const now = opts.now || Date.now();

  // 1. Fetch Profile
  const profile = state?.profile || (store?.getProfile ? await store.getProfile(characterId) : null) || {};

  // 2. Fetch Documents
  const documents = (state?.docs && state.docs.length) ? state.docs : (store?.docs ? await store.docs(characterId) : []) || [];

  // 3. Fetch Scenes (all scenes for character)
  let scenes = [];
  try {
    scenes = store?.scenes ? await store.scenes(characterId, { limit: 10000000 }) : (state?.scenes || []);
  } catch (err) {
    console.warn('Failed to fetch scenes for backup, falling back to state:', err);
    scenes = state?.scenes || [];
  }

  // 4. Fetch Runs (all historical runs)
  let runs = [];
  try {
    runs = store?.allRuns ? await store.allRuns(characterId) : (store?.runs ? await store.runs(characterId) : (state?.runs || []));
  } catch (err) {
    console.warn('Failed to fetch all runs for backup, falling back to store.runs:', err);
    runs = store?.runs ? await store.runs(characterId) : (state?.runs || []);
  }

  // 5. Fetch Native Memories
  const nativeMemories = await fetchAllNativeMemories(client, characterId);

  // 6. Extract Schedule and Timeline Facts & Plans
  const scheduleFacts = extractScheduleAndTimelineFacts(profile, documents, { scenes, now });

  let plans = [];
  try {
    plans = store?.plans ? await store.plans(characterId, { limit: 10000 }) : [];
  } catch (err) {
    console.warn('Failed to fetch plans from store, falling back to profile.plans:', err);
  }
  if (!plans.length && profile?.plans) {
    plans = Object.entries(profile.plans).map(([day, p]) => ({
      id: `${characterId}-${day}`,
      characterId,
      day,
      title: p.title || '',
      mood: p.mood || '',
      dayType: p.dayType || null,
      nodes: p.nodes || [],
      changes: p.changes || [],
      source: p.source || 'generated',
      generatedAt: p.generatedAt || now
    }));
  }

  // Build DailyFact[] array conforming to EXPORT_FORMAT_SPEC.md Section 4.3 & 5.3
  const dailyFactDays = Object.keys(scheduleFacts.dailyFacts);
  const dailyFactsArray = dailyFactDays.map(day => {
    const fact = scheduleFacts.dailyFacts[day] || {};
    const diaryDoc = (documents || []).find(d => d.day === day && d.kind === 'diary');
    const dreamDoc = (documents || []).find(d => d.day === day && d.kind === 'dream');
    return {
      day,
      characterId,
      plannedSleepStart: fact.plannedSleepStart || profile?.settings?.sleepStart || '23:30',
      plannedWakeTime: fact.plannedWakeTime || profile?.settings?.sleepEnd || '08:00',
      wakeTime: fact.wakeTime || '',
      wakePhrase: fact.wakePhrase || '',
      wakeSource: fact.wakeSource || 'schedule',
      wakeSummary: fact.wakeSummary || '',
      firstAwakeTime: fact.firstAwakeTime ?? (fact.wakeSource === 'scene' ? fact.wakeTime || '' : ''),
      timelineItems: fact.timelineItems || [],
      todayDiaryTitle: diaryDoc?.title || fact.todayDiaryTitle || '',
      todayDiarySummary: diaryDoc?.summary || fact.todayDiarySummary || '',
      todayDreamTitle: dreamDoc?.title || fact.todayDreamTitle || '',
      todayDreamSummary: dreamDoc?.summary || fact.todayDreamSummary || ''
    };
  });

  // 7. Consolidate Knowledge Graph Triples & Entities conforming to Section 4.7 & 5.7
  const triples = consolidateKnowledgeGraph(documents, nativeMemories);
  const entityMap = new Map();
  for (const t of triples) {
    if (t.subject && !entityMap.has(t.subject)) {
      entityMap.set(t.subject, {
        id: t.subject,
        name: t.subject,
        type: t.subject === characterName || t.subject === characterId ? 'character' : 'concept',
        description: `图谱主体实体：${t.subject}`
      });
    }
    if (t.object && !entityMap.has(t.object)) {
      entityMap.set(t.object, {
        id: t.object,
        name: t.object,
        type: 'concept',
        description: `图谱客体/属性实体：${t.object}`
      });
    }
  }
  const graphData = {
    entities: Array.from(entityMap.values()),
    triples
  };

  // 8. Build Manifest conforming to EXPORT_FORMAT_SPEC.md Section 4.1
  const recordCounts = {
    documents: documents.length,
    scenes: scenes.length,
    runs: runs.length,
    triples: triples.length,
    nativeMemories: nativeMemories.length,
    plans: plans.length
  };

  const isZipInit = !opts.forceJson;
  const manifest = {
    exportVersion: '1.1.0',
    specVersion: '1.1.0',
    appVersion: VERSION,
    version: VERSION,
    exportedAt: now,
    exportedAtISO: new Date(now).toISOString(),
    characterId,
    characterName,
    archiveMode: isZipInit ? 'zip' : 'json_fallback',
    recordCounts,
    summary: {
      documentCount: documents.length,
      sceneCount: scenes.length,
      runCount: runs.length,
      tripleCount: triples.length,
      nativeMemoryCount: nativeMemories.length,
      planCount: plans.length
    },
    files: [
      { path: 'manifest.json', description: '导出元数据清单' },
      { path: 'profile.json', description: '角色配置与作息状态' },
      { path: 'schedules/daily_facts.json', description: '日程节点与时间线事实' },
      { path: 'schedules/plans.json', description: '每日日程全量规划与区间调整记录' },
      { path: 'documents/documents.json', description: '生活文稿（日记、梦境、反思、作品）正文与摘要' },
      { path: 'scenes/scenes.json', description: '已细化的生活片段与场景记录' },
      { path: 'runs/history_runs.json', description: '全量系统与后台运行执行记录' },
      { path: 'knowledge-graph/graph.json', description: '知识图谱实体与三元组数据' },
      { path: 'native-memories/native_memories.json', description: 'Layla SDK 原生长期记忆快照' }
    ]
  };

  // 9. Prepare ZIP entries
  const zipFiles = [
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'profile.json', data: JSON.stringify(profile, null, 2) },
    { name: 'schedules/daily_facts.json', data: JSON.stringify(dailyFactsArray, null, 2) },
    { name: 'schedules/plans.json', data: JSON.stringify(plans, null, 2) },
    { name: 'documents/documents.json', data: JSON.stringify(documents, null, 2) },
    { name: 'scenes/scenes.json', data: JSON.stringify(scenes, null, 2) },
    { name: 'runs/history_runs.json', data: JSON.stringify(runs, null, 2) },
    { name: 'knowledge-graph/graph.json', data: JSON.stringify(graphData, null, 2) },
    { name: 'native-memories/native_memories.json', data: JSON.stringify(nativeMemories, null, 2) }
  ];

  let isZip = true;
  let filename = `life-backup-${characterId}-${now}.zip`;
  let base64 = '';

  const buildFallbackJson = () => JSON.stringify({
    exportVersion: '1.1.0',
    specVersion: '1.1.0',
    appVersion: VERSION,
    archiveMode: 'json_fallback',
    version: manifest.version,
    exportedAt: manifest.exportedAt,
    characterId,
    characterName,
    manifest: { ...manifest, archiveMode: 'json_fallback' },
    profile,
    schedules: dailyFactsArray,
    plans,
    documents,
    scenes,
    runs,
    knowledgeGraph: graphData,
    nativeMemories
  }, null, 2);

  if (opts.forceJson) {
    isZip = false;
    filename = `life-backup-${characterId}-${now}.json`;
    base64 = stringToBase64(buildFallbackJson());
  } else {
    try {
      const zipBytes = createZip(zipFiles);
      base64 = uint8ArrayToBase64(zipBytes);
    } catch (err) {
      console.warn('ZIP generation failed, gracefully falling back to structured JSON:', err);
      isZip = false;
      filename = `life-backup-${characterId}-${now}.json`;
      base64 = stringToBase64(buildFallbackJson());
    }
  }

  return {
    filename,
    base64,
    isZip,
    stats: recordCounts
  };
}
