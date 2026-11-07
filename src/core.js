import { DEFAULT_DAY_TYPES, pickDayType, normalizeItems, templateItems, applyChange, formatSyncTime, DEFAULT_VOICE, priorityLine, voiceText, buildVoiceBlock, isSleep } from './schedule.js';
export { DEFAULT_DAY_TYPES, pickDayType, normalizeItems, templateItems, applyChange, formatSyncTime, DEFAULT_VOICE, priorityLine, voiceText, buildVoiceBlock };

// Life model inspired by Mai_life. All state belongs to the character simulation.
export const VERSION = '0.3.0';
export const CARD_SYNC_START = '【生活手记·实时状态】';
export const CARD_SYNC_END = '【/生活手记·实时状态】';
export const KINDS = { sleep: '睡眠', nap: '午休', meal: '用餐', work: '工作', study: '学习', travel: '出行', leisure: '闲暇', rest: '休息' };
export const PHASES = { awake: '清醒', falling_asleep: '入睡中', light_sleep: '浅睡', deep_sleep: '深睡', woken: '被叫醒' };
export const DOC_KINDS = { diary: '日记', dream: '梦境', reflection: '反思', work: '创作' };
export const TIMEZONES = { 'Asia/Shanghai': { name: '北京时间', offset: 480 }, 'Asia/Tokyo': { name: '日本时间', offset: 540 }, UTC: { name: '协调世界时', offset: 0 } };
export const clone = x => JSON.parse(JSON.stringify(x));
export const clamp = (x, a, b) => Math.max(a, Math.min(b, Number(x)));
export const pad = x => String(x).padStart(2, '0');
export function hash(text) { let x = 2166136261; for (let i = 0; i < text.length; i++) x = Math.imul(x ^ text.charCodeAt(i), 16777619); return (x >>> 0).toString(36); }
export const uid = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
export function normalizeTimestamp(value) {
  const t = Number(value); if (!Number.isFinite(t) || t <= 0) return 0;
  return t < 100000000000 ? t * 1000 : t;
}
export function parts(ts, timezone = 'Asia/Shanghai') {
  // Fixed-offset zones work in headless QuickJS even when Intl is unavailable.
  const offset = TIMEZONES[timezone]?.offset ?? 480;
  const d = new Date(Number(ts) + offset * 60000);
  return { day: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, minute: d.getUTCHours() * 60 + d.getUTCMinutes(), second: d.getUTCSeconds(), weekday: d.getUTCDay(), year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, date: d.getUTCDate() };
}
export function epoch(day, minute = 0, timezone = 'Asia/Shanghai') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期格式应为 YYYY-MM-DD');
  return Date.parse(`${day}T00:00:00Z`) + (Number(minute) - (TIMEZONES[timezone]?.offset ?? 480)) * 60000;
}
export const nextDay = day => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
export const hhmm = minute => minute === 1440 ? '24:00' : `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
export function parseTime(value, allowEnd = false) {
  if (allowEnd && value === '24:00') return 1440;
  if (!/^\d{2}:\d{2}$/.test(String(value))) return null;
  const [h, m] = value.split(':').map(Number); return h < 24 && m < 60 ? h * 60 + m : null;
}
export function formatTime(ts, tz) { const p = parts(ts, tz); return `${p.day} ${hhmm(p.minute)}`; }
export function moodLabel(v) { return v > .55 ? '愉快' : v > .15 ? '轻快' : v >= -.15 ? '平静' : v > -.55 ? '低落' : '疲惫低落'; }
export function createProfile(character, now = Date.now()) {
  return { schema: 3, characterId: character.id, name: character.data.data.name || '未命名角色', createdAt: now,
    settings: { timezone: 'Asia/Shanghai', home: '', sleepStart: '23:30', sleepEnd: '08:00', healthNote: '', weatherNote: '', weatherCity: '', weatherAt: 0, autoScene: true, autoPlan: false, background: false, autoWrite: false, syncCard: true, memorySessionMode: 'isolated', diaryHour: 21, dayType: '', holidayNotes: '', syncPrecision: 'halfhour', dayTypes: clone(DEFAULT_DAY_TYPES), extraRules: '', voiceRules: true, businessPriority: true, wokenBriefRule: true, customVoiceRules: '', planAheadHour: 22, tomorrowAfterHour: 18 },
    state: { energy: 70, hunger: 25, mood: .15, arousal: .4, updatedAt: now, awakeUntil: 0, lastSleepEnd: 0, recentSleepHours: 0, appliedNodes: [], seenMessages: [] },
    plans: {}, wakeRecords: {}, selectedSessionId: '', lastNativeAt: 0, lastRunAt: 0, calendar: [], sceneIdentity: '', currentScene: null, sceneAttempt: null,
    cardSync: { hash: '', syncedAt: 0, day: '', status: 'idle', error: '', preview: '' } };
}
export function upgradeProfile(input) {
  const base = createProfile({ id: input.characterId, data: { data: { name: input.name } } }, input.createdAt || input.state?.updatedAt || Date.now());
  const settings = {
    ...base.settings,
    ...input.settings,
    dayTypes: (input.settings?.dayTypes && Array.isArray(input.settings.dayTypes) && input.settings.dayTypes.length) ? input.settings.dayTypes : clone(DEFAULT_DAY_TYPES)
  };
  const plans = (input.plans && typeof input.plans === 'object') ? input.plans : {};
  const wakeRecords = (input.wakeRecords && typeof input.wakeRecords === 'object' && !Array.isArray(input.wakeRecords)) ? { ...input.wakeRecords } : {};
  return { ...base, ...input, schema: 3, settings, plans, wakeRecords, state: { ...base.state, ...input.state }, cardSync: { ...base.cardSync, ...(input.cardSync || {}) } };
}
export function templatePlan(day, profile) {
  const s = profile.settings, start = parseTime(s.sleepStart) ?? 1410, end = parseTime(s.sleepEnd) ?? 480;
  // Explicit editable daily template. It does not invent school/work identities.
  const out = []; let cursor = 0;
  const add = (a, b, kind, summary) => { if (b > a) out.push({ id: `${day}-${a}`, start: a, end: b, kind, summary, location: s.home || '未设定', scene: '', source: 'template' }); };
  if (start > end) { add(0, end, 'sleep', '夜间休息'); cursor = end; }
  const sleepAt = start > end ? start : 1440;
  if (start < end) { add(0, start, 'leisure', '日常活动'); add(start, end, 'sleep', '休息'); cursor = end; }
  if (cursor < sleepAt) {
    const firstMealEnd = Math.min(cursor + 45, sleepAt);
    add(cursor, firstMealEnd, 'meal', '起身与用餐'); cursor = firstMealEnd;
    if (cursor < 720 && sleepAt > 720) { add(cursor, 720, 'leisure', '上午的日常活动'); cursor = 720; }
    if (cursor < 780 && sleepAt > 720) { add(cursor, Math.min(780, sleepAt), 'meal', '午间用餐'); cursor = Math.min(780, sleepAt); }
    if (cursor < 1080 && sleepAt > 780) { add(cursor, Math.min(1080, sleepAt), 'leisure', '下午的日常活动'); cursor = Math.min(1080, sleepAt); }
    if (cursor < 1140 && sleepAt > 1080) { add(cursor, Math.min(1140, sleepAt), 'meal', '晚间用餐'); cursor = Math.min(1140, sleepAt); }
    add(cursor, sleepAt, 'leisure', '自由活动');
  }
  if (start > end) add(start, 1440, 'sleep', '准备休息');
  return out;
}
export function validatePlan(raw, day, options = {}) {
  const repair = typeof options === 'boolean' ? options : !!options?.repair;
  let input = Array.isArray(raw) ? raw : raw?.nodes;
  if (repair && Array.isArray(input)) {
    input = normalizeItems(input, day);
  }
  if (!Array.isArray(input) || input.length < 2 || input.length > 32) throw new Error('日程应包含 2–32 个节点');
  const nodes = input.map((n, i) => {
    const start = typeof n.start === 'number' ? n.start : parseTime(n.start);
    const end = typeof n.end === 'number' ? n.end : parseTime(n.end, true);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1440 || end <= start || !(n.kind in KINDS) || !String(n.summary || n.activity || '').trim()) throw new Error(`第 ${i + 1} 个节点的时间、类型或名称无效`);
    const sum = String(n.summary || n.activity).trim().slice(0, 100);
    return { id: `${day}-${start}`, start, end, kind: n.kind, summary: sum, activity: sum, location: String(n.location || '未设定').slice(0, 80), scene: String(n.scene || '').slice(0, 500), source: n.source === 'manual' ? 'manual' : n.source === 'template' ? 'template' : 'generated' };
  }).sort((a, b) => a.start - b.start);
  if (nodes[0].start !== 0 || nodes[nodes.length - 1].end !== 1440) throw new Error('日程应从 00:00 覆盖到 24:00');
  for (let i = 1; i < nodes.length; i++) if (nodes[i].start !== nodes[i - 1].end) throw new Error('节点之间不能重叠或留有空档');
  if (!nodes.some(n => n.kind === 'sleep')) throw new Error('日程需要至少一个睡眠节点');
  return nodes;
}
export function getNodes(profile, day) { return profile?.plans?.[day]?.nodes || templatePlan(day, profile); }
export function contextAt(profile, ts = Date.now()) {
  const p = parts(ts, profile.settings.timezone), nodes = getNodes(profile, p.day);
  const index = nodes.findIndex(n => n.start <= p.minute && p.minute < n.end);
  const current = nodes[index] || null;
  const next = nodes[index + 1] || getNodes(profile, nextDay(p.day))[0] || null;
  const nextDate = nodes[index + 1] ? p.day : nextDay(p.day);
  const currentStart = current ? epoch(p.day, current.start, profile.settings.timezone) : ts;
  const currentEnd = current ? epoch(p.day, current.end, profile.settings.timezone) : ts + 60000;
  return { ...p, nodes, current, next, currentStart, currentEnd, nextDate, nextStart: next ? epoch(nextDate, next.start, profile.settings.timezone) : 0, source: profile.plans[p.day]?.source || 'template' };
}
export function continuousSleepBlock(nodes, index) {
  if (!Array.isArray(nodes) || index < 0 || index >= nodes.length) return null;
  const target = nodes[index];
  if (target?.kind !== 'sleep') return null;
  let startIdx = index;
  while (startIdx > 0 && nodes[startIdx - 1]?.kind === 'sleep') {
    startIdx--;
  }
  let endIdx = index;
  while (endIdx < nodes.length - 1 && nodes[endIdx + 1]?.kind === 'sleep') {
    endIdx++;
  }
  return {
    start: nodes[startIdx].start,
    end: nodes[endIdx].end,
    startIndex: startIdx,
    endIndex: endIdx,
    containsMorningStart: nodes[startIdx].start === 0
  };
}
export function sleepPhase(profile, ts, context = contextAt(profile, ts)) {
  if (!['sleep', 'nap'].includes(context.current?.kind)) return 'awake';
  if (context.current?.kind === 'sleep') {
    const nodes = context.nodes || getNodes(profile, context.day);
    const index = nodes.indexOf(context.current);
    const block = continuousSleepBlock(nodes, index >= 0 ? index : nodes.findIndex(n => n.start <= context.minute && context.minute < n.end));
    if (block && block.containsMorningStart) {
      const wakeAt = profile.wakeRecords?.[context.day]?.at;
      const blockEndTs = epoch(context.day, block.end, profile.settings?.timezone);
      if (Number.isSafeInteger(wakeAt) && wakeAt <= blockEndTs && wakeAt <= ts) return 'awake';
    }
  }
  if (profile.state.awakeUntil > ts) return 'woken';
  if (context.current.kind === 'nap') return 'light_sleep';
  let start = context.currentStart;
  if (context.current.start === 0) {
    const yesterday = parts(start - 1, profile.settings.timezone).day;
    const previousNodes = getNodes(profile, yesterday), previous = previousNodes[previousNodes.length - 1];
    if (previous?.kind === 'sleep') start = epoch(yesterday, previous.start, profile.settings.timezone);
  }
  const minutes = Math.max(0, (ts - start) / 60000);
  return minutes < 15 ? 'falling_asleep' : minutes < 45 ? 'light_sleep' : 'deep_sleep';
}
export function sceneTarget(profile, now = Date.now()) {
  const c = contextAt(profile, now), n = c.current;
  if (!n) return null;
  const phase = sleepPhase(profile, now, c);
  const wakeCycle = ['sleep', 'nap'].includes(n.kind) && profile.state.awakeUntil >= c.currentStart ? profile.state.awakeUntil : 0;
  const nodeKey = `${encodeURIComponent(profile.characterId)}/${c.day}/${hash(JSON.stringify([profile.settings.timezone, profile.sceneIdentity, n.id, n.start, n.end, n.kind, n.summary, n.location, n.source === 'manual' ? n.scene : '']))}`;
  return { key: `${nodeKey}/${phase}/${wakeCycle}`, nodeKey, day: c.day, nodeId: n.id, phase, start: c.currentStart, end: c.currentEnd, node: n };
}
export function validateScene(raw) {
  if (typeof raw?.scene !== 'string') throw new Error('模型场景缺少 scene 文本');
  const scene = raw.scene.trim();
  if (scene.length < 40 || scene.length > 500) throw new Error('细化场景需为 40–500 字符的完整段落，请重新生成');
  return scene;
}
export function experiencedScenes(records, characterId, now, day = null) {
  // A scene begins when it was actually recorded, never at a retroactive plan start.
  const selected = records.filter(r => r.characterId === characterId && r.scene && r.generatedAt <= now && r.generatedAt < r.end && (!day || r.day === day)).reverse().sort((a, b) => a.generatedAt - b.generatedAt);
  // Store rows arrive newest first. Keep the last-written revision on timestamp ties.
  const distinct = selected.filter((r, i) => selected[i + 1]?.generatedAt !== r.generatedAt);
  return distinct.map((r, i) => ({ ...r, experiencedUntil: Math.min(now, r.end, distinct[i + 1]?.generatedAt ?? Infinity) }));
}
export function advanceProfile(input, now = Date.now(), messages = []) {
  const profile = clone(input), state = profile.state;
  if (now < state.updatedAt) return profile; // Clock rollback never reverses physiology.
  let cursor = Math.max(state.updatedAt, now - 72 * 3600000);
  const newMessages = messages.map(m => ({ ...m, timestamp: normalizeTimestamp(m.timestamp) })).filter(m => m.timestamp > 0 && m.timestamp <= now && !state.seenMessages.includes(String(m.id))).sort((a, b) => a.timestamp - b.timestamp);
  const wakes = newMessages.filter(m => m.role === 'assistant' && m.timestamp >= cursor && ['sleep', 'nap'].includes(contextAt(profile, m.timestamp).current?.kind));
  let wi = 0;
  while (cursor < now) {
    while (wi < wakes.length && wakes[wi].timestamp <= cursor) { state.awakeUntil = Math.max(state.awakeUntil, wakes[wi].timestamp + 30 * 60000); wi++; }
    const c = contextAt(profile, cursor);
    let isMorningSleep = false;
    const wakeAt = profile.wakeRecords?.[c.day]?.at;
    let blockEndTs = 0;
    if (c.current?.kind === 'sleep') {
      const nodes = c.nodes || getNodes(profile, c.day);
      const index = nodes.indexOf(c.current);
      const block = continuousSleepBlock(nodes, index >= 0 ? index : nodes.findIndex(n => n.start <= c.minute && c.minute < n.end));
      if (block && block.containsMorningStart) {
        blockEndTs = epoch(c.day, block.end, profile.settings?.timezone);
        if (Number.isSafeInteger(wakeAt) && wakeAt <= blockEndTs) {
          isMorningSleep = true;
        }
      }
    }
    const isAwakeByRecord = isMorningSleep && wakeAt <= cursor;
    const boundary = Math.min(
      c.currentEnd,
      cursor + 20 * 60000,
      now,
      wakes[wi]?.timestamp ?? Infinity,
      state.awakeUntil > cursor ? state.awakeUntil : Infinity,
      (isMorningSleep && wakeAt > cursor) ? wakeAt : Infinity
    );
    const end = Math.max(cursor + 1, boundary), h = (end - cursor) / 3600000;
    const resting = ['sleep', 'nap'].includes(c.current?.kind) && state.awakeUntil <= cursor && !isAwakeByRecord;
    const key = `${c.day}/${c.current?.id}`;
    if (c.current?.kind === 'meal' && !state.appliedNodes.includes(key)) { state.hunger = 12; state.appliedNodes.push(key); }
    state.energy = clamp(resting ? state.energy + (90 - state.energy) * (1 - Math.exp(-.35 * h)) : state.energy - (['work', 'study', 'travel'].includes(c.current?.kind) ? 4.2 : 2.6) * h, 0, 100);
    state.hunger = clamp(state.hunger + (resting ? 1 : 5) * h, 0, 100);
    state.arousal = clamp(state.arousal + (resting ? -.15 : .04) * h, 0, 1);
    const pressure = state.energy < 25 || state.hunger > 80 ? -.025 * h : 0;
    state.mood = clamp(state.mood + (.15 - state.mood) * (1 - Math.exp(-.0175 * h)) + pressure, -1, 1);
    const nextContext = contextAt(profile, end);
    if (resting && !['sleep', 'nap'].includes(nextContext.current?.kind)) { state.lastSleepEnd = end; state.recentSleepHours = c.current.kind === 'sleep' ? Math.min(12, (end - c.currentStart) / 3600000 + (c.current.start === 0 ? (1440 - (parseTime(profile.settings.sleepStart) ?? 1410)) / 60 : 0)) : h; }
    cursor = end;
  }
  while (wi < wakes.length) { state.awakeUntil = Math.max(state.awakeUntil, wakes[wi].timestamp + 30 * 60000); wi++; }
  state.updatedAt = now; state.appliedNodes = state.appliedNodes.slice(-200);
  state.seenMessages = [...new Set([...state.seenMessages, ...newMessages.map(m => String(m.id))])].slice(-600);
  profile.lastNativeAt = Math.max(profile.lastNativeAt || 0, ...newMessages.map(m => m.timestamp), 0);
  return profile;
}
export function healthNote(profile) { return profile.settings.healthNote || (profile.state.energy < 25 ? '精力偏低，适合休息' : profile.state.hunger > 80 ? '有些饿，需要用餐' : '没有额外健康备注'); }
export function festivals(profile, now = Date.now()) {
  const today = parts(now, profile.settings.timezone).day;
  const custom = String(profile.settings.holidayNotes || '').split('\n').map(line => { const m = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(line.trim()); return m ? { day: m[1], name: m[2], source: '手动记录' } : null; }).filter(Boolean);
  const fixed = [[1, 1, '元旦'], [5, 1, '劳动节'], [10, 1, '国庆节'], [12, 25, '圣诞节']];
  const year = Number(today.slice(0, 4)), all = [...custom, ...(profile.calendar || [])];
  for (const y of [year, year + 1]) for (const [m, d, name] of fixed) all.push({ day: `${y}-${pad(m)}-${pad(d)}`, name, source: '公历日期' });
  return [...new Map(all.filter(f => f.day >= today).map(f => [`${f.day}/${f.name}`, f])).values()].sort((a, b) => a.day.localeCompare(b.day)).slice(0, 3).map(f => ({ ...f, days: Math.round((epoch(f.day, 0, profile.settings.timezone) - epoch(today, 0, profile.settings.timezone)) / 86400000) }));
}
export function lunarCalendar(now = Date.now(), timezone = 'Asia/Shanghai') {
  if (typeof Intl === 'undefined') return [];
  const result = [], mapping = { '正月/1': '春节', '五月/5': '端午节', '七月/7': '七夕', '八月/15': '中秋节' };
  try { const fmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric', timeZone: timezone === 'UTC' ? 'UTC' : timezone });
    for (let i = 0; i < 370; i++) { const t = now + i * 86400000, pieces = fmt.formatToParts(new Date(t)); const m = pieces.find(p => p.type === 'month')?.value, d = pieces.find(p => p.type === 'day')?.value; const name = mapping[`${m}/${d}`]; if (name) result.push({ day: parts(t, timezone).day, name, source: '设备农历' }); }
  } catch { /* Unsupported calendar keeps fixed solar dates available. */ }
  return result;
}
export function makeSnapshot(profile, now = Date.now()) {
  const c = contextAt(profile, now), phase = sleepPhase(profile, now, c), s = profile.state;
  const target = sceneTarget(profile, now);
  const record = profile.currentScene && target && profile.currentScene.key === target.key && profile.currentScene.generatedAt <= now ? profile.currentScene : null;
  const scene = record?.scene || (c.current?.source === 'manual' ? c.current.scene : '') || '';
  const attempt = profile.sceneAttempt?.key === target?.key ? profile.sceneAttempt : null;
  return { asOf: now, characterId: profile.characterId, name: profile.name, sleepPhase: phase, sleepPhaseLabel: PHASES[phase], activity: scene || c.current?.summary || '未安排', scene, sceneRecord: record, sceneKey: target?.key || '', sceneAttempt: attempt, location: c.current?.location || profile.settings.home || '未设定', mood: moodLabel(s.mood), healthNote: healthNote(profile), weather: profile.settings.weatherNote || '尚未记录天气', weatherCity: profile.settings.weatherCity, weatherAt: profile.settings.weatherAt, weatherStale: !!profile.settings.weatherAt && now - profile.settings.weatherAt > 6 * 3600000, dayType: profile.settings.dayType || (c.weekday === 0 || c.weekday === 6 ? '周末' : '工作日'), festivals: festivals(profile, now), progress: clamp((now - c.currentStart) / Math.max(1, c.currentEnd - c.currentStart), 0, 1), ...c, current: c.current ? { ...c.current, scene } : null };
}
export function parseJSON(text) {
  const clean = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(clean); } catch { const a = clean.search(/[\[{]/), end = Math.max(clean.lastIndexOf('}'), clean.lastIndexOf(']')); if (a >= 0 && end > a) return JSON.parse(clean.slice(a, end + 1)); throw new Error('模型未返回可解析的 JSON，请重试'); }
}
export function validateDocument(raw) {
  for (const key of ['title', 'body', 'summary']) if (typeof raw?.[key] !== 'string' || !raw[key].trim()) throw new Error(`生成内容缺少 ${key === 'title' ? '标题' : key === 'body' ? '正文' : '摘要'}`);
  if (raw.title.length > 160 || raw.body.length > 16000 || raw.summary.length > 1200) throw new Error('生成内容过长，请重新生成');
  return { title: raw.title.trim(), body: raw.body.trim(), summary: raw.summary.trim() };
}
export function documentId(characterId, kind, day) { return `life-${encodeURIComponent(characterId)}-${kind}-${day}`; }
export function archiveSessionId(characterId) { return `life-archive-${characterId}`; }
export function marker(id) { return `【Layla生活记录:${id}】`; }
const SYNC_BLOCK_RE = /(?:\r?\n)*【生活手记·实时状态】[\s\S]*?【\/生活手记·实时状态】(?:\r?\n)*/g;
export function stripCardSyncBlock(text = '') {
  const src = String(text ?? '');
  if (!src.includes(CARD_SYNC_START)) return src;
  return src.replace(SYNC_BLOCK_RE, '\n\n').replace(/^\n+|\n+$/g, '');
}
export function applyCardSyncBlock(existingText = '', block = '') {
  const base = stripCardSyncBlock(existingText);
  const cleanBlock = String(block || '').trim();
  if (!cleanBlock) return base;
  return base ? `${base}\n\n${cleanBlock}` : cleanBlock;
}
const wakeMentionPattern = /(?:(?:凌晨|早上|清晨|上午|早晨)\s*)?(?<![早晚迟慢快差好多少再有][了的]?\s*)(\d{1,2}\s*[:：]\s*\d{2}|(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*点(?:\s*(?:半|[零〇0]?\d{1,2}\s*分?|[零〇一二两三四五六七八九十]{1,3}\s*分?))?)\s*(?:(?:多|才|左右|前后|刚)\s*)*(?:起床|醒来|起身|睡醒|睁开?眼|(?:从(?:被窝|被子|床)(?:里|上)?\s*)?爬(?:起来|出来|下床))/g;

function chineseClockNumber(value) {
  if (value == null || value === '') return NaN;
  const v = String(value).trim().replace(/两/g, '二').replace(/〇/g, '零');
  if (/^\d+$/.test(v)) return Number(v);
  const digits = '零一二三四五六七八九';
  const stripped = v.replace(/^[零]+/, '');
  if (stripped === '') return 0;
  if (/^\d+$/.test(stripped)) return Number(stripped);
  if (stripped.length === 1 && digits.indexOf(stripped) >= 0) return digits.indexOf(stripped);
  const [first, last] = stripped.split('十');
  if (last === undefined) return NaN;
  const tens = first ? digits.indexOf(first) : 1;
  const ones = last ? digits.indexOf(last) : 0;
  return tens < 0 || ones < 0 ? NaN : tens * 10 + ones;
}

export function extractWakeMentions(text = '') {
  const mentions = [];
  const src = String(text || '');
  for (const match of src.matchAll(wakeMentionPattern)) {
    const matchIndex = match.index;
    const preText = src.slice(0, matchIndex);

    // 1. Exclude degree adverbs: e.g. 早一点/晚一点/慢一点/快一点/差一点/好一点/多一点/少一点
    if (/[早晚迟慢快差好多少再有][了的]?\s*$/.test(preText) && /^[一1]\s*点/.test(match[1])) {
      continue;
    }

    // 2. Exclude nap/midday/non-morning contexts: e.g. "午睡到两点半醒来", "小憩到14:30睡醒", "下午/傍晚/中午"
    const clause = preText.split(/[，。！？；\n]/).pop() || '';
    if (/(?:午睡|午休|小憩|打盹|中午|下午|傍晚|黄昏)(?:到|至|才|后|在|从)?\s*$/.test(clause) || /(?:午睡|午休|小憩|打盹|中午|下午|傍晚|黄昏)/.test(clause)) {
      continue;
    }
    const sentence = preText.split(/[。！？\n]/).pop() || '';
    if (/(?:午睡|午休|小憩|打盹)/.test(sentence) && !/(?:凌晨|清晨|早上|早晨)/.test(match[0])) {
      continue;
    }

    // 3. Exclude plan comparisons and chat quotes: e.g. "平时计划8:00起床，今天8:44醒来", "你说早上8点起床"
    if (/(?:计划|打算|原本|原定|平时|平常|习惯|一般)(?:[在为是约于]|大约)?\s*$/.test(clause.trim())) {
      continue;
    }
    if (/(?:你说|听你说|你提到|聊天中?提到|你说过)\s*$/.test(clause.trim())) {
      continue;
    }

    const raw = match[1].replace(/\s+|分/g, '');
    const [hours, minutes = '0'] = raw.split(/[:：点]/);
    const h = chineseClockNumber(hours);
    const m = minutes === '半' ? 30 : chineseClockNumber(minutes || '0');
    if (h >= 0 && h < 24 && m >= 0 && m < 60) {
      const isVague = /(?:点多|左右|前后|大概|大约|约\s*\d)/.test(match[0]);
      const mention = {
        phrase: match[0].trim(),
        time: `${pad(h)}:${pad(m)}`
      };
      if (isVague) mention.exact = false;
      mentions.push(mention);
    }
  }
  return mentions;
}

export function extractWakeMention(text = '') { return extractWakeMentions(text)[0] || null; }

export function confirmedWakeTime(profile, day, now = Date.now()) {
  const record = profile?.wakeRecords?.[day];
  const at = record?.at;
  if (!Number.isSafeInteger(at) || at <= 0 || at > now) return '';
  const tz = record?.timezone || profile?.settings?.timezone || 'Asia/Shanghai';
  const local = parts(at, tz);
  return local.day === day ? hhmm(local.minute) : '';
}

export function hasUnconfirmedWakeTime(text, confirmedTime) {
  return extractWakeMentions(text)
    .filter(mention => mention.exact !== false)
    .some(mention => mention.time !== confirmedTime);
}
export function dailyTimelineFacts(profile, scenes = [], day = null, now = Date.now(), docs = []) {
  const tz = profile.settings.timezone;
  const nowParts = parts(now, tz);
  const targetDay = day || nowParts.day;
  const nodes = getNodes(profile, targetDay);
  const morningBlock = nodes[0]?.kind === 'sleep' ? continuousSleepBlock(nodes, 0) : null;
  const nightBlock = nodes[nodes.length - 1]?.kind === 'sleep' ? continuousSleepBlock(nodes, nodes.length - 1) : null;
  const plannedWakeMinute = morningBlock ? morningBlock.end : (parseTime(profile.settings.sleepEnd) ?? 480);
  const plannedWakeTime = hhmm(plannedWakeMinute);
  const plannedSleepStart = nightBlock ? hhmm(nightBlock.start) : (profile.settings.sleepStart || '23:30');
  const dayScenes = experiencedScenes(scenes, profile.characterId, now, targetDay);
  const firstAwakeScene = dayScenes.find(r => r.phase === 'awake') || null;
  const firstAwakeMinute = firstAwakeScene ? parts(firstAwakeScene.generatedAt, tz).minute : null;
  const firstAwakeTime = firstAwakeMinute === null ? '' : hhmm(firstAwakeMinute);
  const todayDiary = docs.find(d => d.characterId === profile.characterId && d.day === targetDay && d.kind === 'diary') || null;
  const todayDream = docs.find(d => d.characterId === profile.characterId && d.day === targetDay && d.kind === 'dream') || null;
  const wakeTime = confirmedWakeTime(profile, targetDay, now);
  const wakePhrase = wakeTime ? `${wakeTime}起床` : '';
  const currentPhase = sleepPhase(profile, now);
  const isMorningSleeping = !wakeTime && nowParts.day === targetDay && currentPhase !== 'awake' && nowParts.minute < plannedWakeMinute + 60;
  const wakeSource = wakeTime ? 'manual' : isMorningSleeping ? 'sleeping' : firstAwakeTime ? 'scene' : 'schedule';
  const wakeSummary = isMorningSleeping
    ? `计划 ${plannedWakeTime} 结束休息；尚未起床，当前处于睡眠阶段`
    : [
        `计划 ${plannedWakeTime} 结束休息`,
        firstAwakeTime && `首个清醒片段 ${firstAwakeTime}`,
        wakeTime ? `已确认 ${wakeTime} 起床` : '实际起床时间未确认'
      ].filter(Boolean).join('；');
  const timelineItems = dayScenes.slice(-6).map(r => ({ time: hhmm(parts(r.generatedAt, tz).minute), until: hhmm(parts(r.experiencedUntil, tz).minute), summary: r.summary, location: r.location, phase: r.phase }));
  return { day: targetDay, plannedSleepStart, plannedWakeTime, wakeTime, wakePhrase, wakeSource, wakeSummary, firstAwakeTime, timelineItems, todayDiaryTitle: todayDiary?.title || '', todayDiarySummary: todayDiary?.summary || '', todayDreamTitle: todayDream?.title || '', todayDreamSummary: todayDream?.summary || '' };
}
export function buildCardSyncBlock(profile, scenes = [], docs = [], now = Date.now(), opts = {}) {
  if (!profile || profile.settings?.syncCard === false) return '';
  const snap = makeSnapshot(profile, now), facts = dailyTimelineFacts(profile, scenes, snap.day, now, docs);
  const precision = opts.syncPrecision || profile.settings?.syncPrecision || 'halfhour';
  let timeStr = '';
  if (precision === 'node') {
    timeStr = snap.day;
  } else if (precision === 'halfhour') {
    timeStr = formatSyncTime(now, profile.settings?.timezone, 'halfhour');
  } else {
    timeStr = formatTime(now, profile.settings?.timezone);
  }

  const lines = [
    CARD_SYNC_START,
    `以下为${profile.name}在 ${snap.day} 的生活状态快照（自然融入语气；双方互动以真实聊天记录为准。精确起床时间以已确认的时间为准，未确认时保留不确定性）：`,
    `- 状态时刻：${timeStr} · ${snap.sleepPhaseLabel} · 心情${snap.mood} · 位于${snap.location}`,
    `- 今日作息与起床：${facts.wakeSummary}`,
    `- 当前日程节点：${snap.current ? `${hhmm(snap.current.start)}–${hhmm(snap.current.end)} ${snap.current.summary}` : snap.activity}${snap.scene ? `（${snap.scene.slice(0, 110)}${snap.scene.length > 110 ? '…' : ''}）` : ''}`
  ];
  if (facts.timelineItems.length) lines.push(`- 今日已记录经历：${facts.timelineItems.map(x => `${x.time} ${x.summary}`).join('；')}`);
  if (facts.todayDiarySummary && !hasUnconfirmedWakeTime(`${facts.todayDiaryTitle}\n${facts.todayDiarySummary}`, facts.wakeTime)) {
    lines.push(`- 今日日记摘要：《${facts.todayDiaryTitle}》${facts.todayDiarySummary.slice(0, 180)}`);
  }
  if (facts.todayDreamSummary) lines.push(`- 今日梦境备忘（仅作梦境，非现实经历）：《${facts.todayDreamTitle}》${facts.todayDreamSummary.slice(0, 120)}`);

  if (snap.sleepPhase !== 'awake' && profile.settings?.wokenBriefRule !== false) {
    lines.push(`- 状态反应指引：${profile.name}这会儿睡着了，被叫醒的话会迷迷糊糊、想接着睡，回复短、带着困意。`);
  }

  const local = parts(now, profile.settings?.timezone);
  const tomorrowHour = (profile.settings?.tomorrowAfterHour ?? 18) * 60;
  if (local.minute >= tomorrowHour) {
    const tomorrowDate = nextDay(snap.day);
    const tomorrowPlan = opts.tomorrowPlan || profile.plans?.[tomorrowDate];
    if (tomorrowPlan && Array.isArray(tomorrowPlan.nodes) && tomorrowPlan.nodes.length) {
      const nonSleep = tomorrowPlan.nodes.filter(n => !isSleep(n)).slice(0, 5).map(n => n.summary || n.activity).filter(Boolean);
      const dtName = tomorrowPlan.dayType?.name || (typeof tomorrowPlan.dayType === 'string' ? tomorrowPlan.dayType : '');
      const title = tomorrowPlan.title ? `《${tomorrowPlan.title}》` : '';
      const main = nonSleep.length ? `想做的事：${nonSleep.join('、')}` : '';
      const summary = [title, main].filter(Boolean).join('；') || '按既定日常安排';
      lines.push(`- 明日安排（${tomorrowDate}${dtName ? ` ${dtName}` : ''}）：${summary}`);
    }
  }

  if (profile.settings?.voiceRules !== false) {
    const voice = voiceText({ ...profile.settings, characterName: profile.name });
    if (voice) lines.push(voice);
  }

  if (profile.settings?.businessPriority !== false) {
    lines.push(priorityLine({ ...profile.settings, characterName: profile.name }));
  }

  lines.push(CARD_SYNC_END);
  return lines.join('\n');
}
export function memoryPayload(document, opts = {}) {
  const mode = opts.memorySessionMode || document.memorySessionMode;
  const sessionId = opts.sessionId || (mode === 'isolated' ? archiveSessionId(document.characterId) : mode === 'active' ? (document.sessionId || archiveSessionId(document.characterId)) : (document.sessionId || archiveSessionId(document.characterId)));
  const provenance = document.kind === 'dream' ? '这是梦境，不是双方真实经历。' : document.kind === 'work' ? '这是创作作品，不是现实事件。' : '角色当日第一人称生活与作息记录；涉及与用户的互动以实际聊天为准。';
  const wakeTime = ['diary', 'reflection'].includes(document.kind) && document.timelineFacts?.wakeSource === 'manual' ? document.timelineFacts.wakeTime : '';
  if (opts.strict && ['diary', 'reflection'].includes(document.kind)) {
    const scanText = [document.title, document.body, document.summary].filter(Boolean).join('\n');
    if (hasUnconfirmedWakeTime(scanText, wakeTime)) {
      throw new Error('文稿包含未确认或冲突的起床时间，已严格拦截原生记忆生成；请重新生成文稿');
    }
  }
  const summaryText = String(document.summary || '');
  const hasWakeInSummary = extractWakeMentions(summaryText).some(mention => mention.time === wakeTime);
  const wakeTag = wakeTime && !hasWakeInSummary ? `（已确认 ${wakeTime} 起床）` : '';
  return { id: opts.id ?? 0, character_id: document.characterId, session_id: sessionId, rawText: `${marker(document.id)}\n类型：${DOC_KINDS[document.kind]}；日期：${document.day}。${provenance}\n标题：${document.title}\n${document.body}`, timestamp: opts.timestamp ?? document.createdAt, summary: `${DOC_KINDS[document.kind]}（${document.day}）《${document.title}》${wakeTag}：${document.summary}`, knowledgeGraphJSON: opts.knowledgeGraphJSON ?? null };
}
