// Purpose hypotheses and opportunity checks. No SDK, storage, timers or I/O.
// Inspired by SurfCore's separation of purposes from delivery; implemented for
// Layla's bounded task runs rather than copying its QQ/DSH runtime or lexicons.
import { hash, parts, parseTime, TIMEZONES } from './core.js';

export const MINUTE = 60000;
export const HOUR = 60 * MINUTE;
export const ACTIVE_DELIVERIES = ['reserving', 'queued', 'uncertain', 'cancel_pending'];
export const PURPOSE_DEFAULTS = Object.freeze({
  mode: 'observe', background: false, sessionId: '', dreamOutreachDisabled: false,
  quietStart: '23:30', quietEnd: '08:30', idleMinutes: 30, gapMinutes: 180,
  dailyMax: 2, ttlHours: 24
});
export const PURPOSE_STATUS = {
  pending: '等待机会', observed: '已观察', contacted: '已联系', completed: '已完成',
  dismissed: '不再提及', expired: '已过期', cancelled: '已撤销',
  reserving: '准备排程', queued: '已排程', uncertain: '待核对',
  cancel_pending: '撤销待核对', delivered: '已确认投递'
};
export const DECISIONS = {
  off: '主动交互已关闭', missing_session: '请先选择一个原生会话',
  quiet: '当前或预约时刻属于安静时段', sleeping: '角色生活时间线正在休息',
  recent_chat: '近期有聊天，本轮暂缓', daily_limit: '本地日期的额度已用完',
  cooldown: '距离上一次观察或预约还太近', initial_delay: '启用自动发送后先观察 30 分钟',
  model_cooldown: '表达生成重试间隔至少十分钟',
  no_goal: '暂无有来源且仍有效的目的', pending_delivery: '已有排程或待核对记录',
  dream_enabled: '请先在 Dream 中关闭主动发送，并在此记录完成',
  external_schedule: '这个角色已有其他定时消息，本轮暂缓',
  stale_source: '目的来源已修改或不在可读历史中', clock_invalid: '聊天时间戳异常，本轮暂停',
  unsupported: '当前宿主缺少定时消息接口', observed: '已保存观察结果，没有发送',
  queued: '已交给宿主排程，投递仍待核对', uncertain: '宿主回执不确定，停止重发',
  error: '本轮未完成，详见运行记录', ready: '有合适的主动交互机会'
};
const int = (x, fallback, min, max) => Number.isFinite(Number(x)) ? Math.min(max, Math.max(min, Math.round(Number(x)))) : fallback;
export const clipPurpose = (s, max = 240) => Array.from(String(s ?? '').trim()).slice(0, max).join('');
export const sourceKey = m => `${m.session_id}/${m.id}/${hash(String(m.content || ''))}`;
export const textKey = s => String(s).toLowerCase().replace(/[\s，。！？、,.!?"'“”‘’]/g, '');

export function normalizePurposeConfig(input = {}) {
  return { mode: ['off', 'observe', 'auto'].includes(input.mode) ? input.mode : 'observe',
    background: input.background === true, sessionId: clipPurpose(input.sessionId, 200),
    dreamOutreachDisabled: input.dreamOutreachDisabled === true,
    quietStart: parseTime(input.quietStart) !== null ? input.quietStart : PURPOSE_DEFAULTS.quietStart,
    quietEnd: parseTime(input.quietEnd) !== null ? input.quietEnd : PURPOSE_DEFAULTS.quietEnd,
    idleMinutes: int(input.idleMinutes, 30, 5, 720), gapMinutes: int(input.gapMinutes, 180, 30, 1440),
    dailyMax: int(input.dailyMax, 2, 1, 6), ttlHours: int(input.ttlHours, 24, 1, 72) };
}
export function createPurposeRecord(characterId, now = Date.now()) {
  return { version: 1, characterId, config: { ...PURPOSE_DEFAULTS }, createdAt: now,
    activatedAt: 0, lastRunAt: 0, lastExtractAt: 0, extractionAttempted: false,
    lastDecision: null, seenSources: [], goals: [], deliveries: [] };
}
export function inPurposeQuiet(at, timezone, config) {
  const m = parts(at, timezone).minute, start = parseTime(config.quietStart), end = parseTime(config.quietEnd);
  return start !== end && (start < end ? m >= start && m < end : m >= start || m < end);
}
export function goalConfidence(goal, now) {
  const span = Math.max(HOUR, goal.expiresAt - goal.createdAt);
  return goal.confidence * Math.max(0, 1 - Math.max(0, now - goal.createdAt) / (2 * span));
}
export function expirePurposeGoals(record, now) {
  for (const g of record.goals) if (g.state === 'pending' && now >= g.expiresAt) g.state = 'expired';
  // Never evict unresolved host mutations or recent quota entries.
  const active = record.deliveries.filter(d => ACTIVE_DELIVERIES.includes(d.status));
  const history = record.deliveries.filter(d => !ACTIVE_DELIVERIES.includes(d.status)).slice(-100);
  record.deliveries = [...history, ...active];
  const referenced = new Set(record.deliveries.map(d => d.goalId));
  record.goals = record.goals.filter(g => g.state === 'pending' || referenced.has(g.id) || g.updatedAt > now - 7 * 24 * HOUR).slice(-200);
  record.seenSources = record.seenSources.slice(-256);
}
export function purposeOpportunity(record, native, life, now) {
  const c = record.config, tz = life.timezone;
  const result = (reason, goal = null) => ({ reason, goal, message: DECISIONS[reason] });
  if (c.mode === 'off') return result('off');
  if (!Object.prototype.hasOwnProperty.call(TIMEZONES, tz) || native.clockInvalid) return result('clock_invalid');
  if (!c.sessionId || !native.sessions.some(s => s.session_id === c.sessionId)) return result('missing_session');
  if (record.deliveries.some(d => ACTIVE_DELIVERIES.includes(d.status))) return result('pending_delivery');
  if (c.mode === 'auto' && !c.dreamOutreachDisabled) return result('dream_enabled');
  if (c.mode === 'auto' && now - record.activatedAt < 30 * MINUTE) return result('initial_delay');
  if (inPurposeQuiet(now, tz, c) || inPurposeQuiet(now + MINUTE, tz, c)) return result('quiet');
  if (life.sleeping) return result('sleeping');
  if (native.lastInteractionAt > 0 && now - native.lastInteractionAt < c.idleMinutes * MINUTE) return result('recent_chat');
  const counted = record.deliveries.filter(d => d.reservedAt || d.observedAt);
  const budgetDay = parts(now + (c.mode === 'auto' ? MINUTE : 0), tz).day;
  if (counted.filter(d => parts(d.request?.timestamp || d.observedAt || d.reservedAt, tz).day === budgetDay).length >= c.dailyMax) return result('daily_limit');
  if (counted.some(d => now - (d.reservedAt || d.observedAt) < c.gapMinutes * MINUTE)) return result('cooldown');
  const goals = record.goals.filter(g => g.state === 'pending' && g.sessionId === c.sessionId && now >= g.notBefore && now + MINUTE < g.expiresAt && goalConfidence(g, now) >= .55)
    .sort((a, b) => (goalConfidence(b, now) + b.value * .2) - (goalConfidence(a, now) + a.value * .2) || a.createdAt - b.createdAt);
  if (!goals.length) return result('no_goal');
  const sources = new Set(native.messages.map(sourceKey));
  const goal = goals.find(g => g.source === 'manual' || g.sourceIds.every(id => sources.has(id)));
  return goal ? result('ready', goal) : result('stale_source');
}

export function acceptPurposeGoals(output, native, record, now) {
  if (!output || !Array.isArray(output.goals)) throw new Error('目的分析必须返回 goals 数组');
  const c = record.config;
  const sources = new Map(native.messages.filter(m => m.session_id === c.sessionId && m.timestamp > now - 72 * HOUR && m.timestamp <= now).map(m => [sourceKey(m), m]));
  const added = [];
  for (const raw of output.goals.slice(0, 3)) {
    if (!raw || !['user', 'character'].includes(raw.owner) || !['follow_up', 'share'].includes(raw.kind)) continue;
    if ((raw.owner === 'user') !== (raw.kind === 'follow_up')) continue;
    const ids = Array.isArray(raw.sourceIds) ? [...new Set(raw.sourceIds)] : [];
    if (!ids.length || ids.length > 3 || ids.some(id => !sources.has(id))) continue;
    const role = raw.owner === 'user' ? 'user' : 'assistant';
    if (ids.some(id => sources.get(id).role !== role)) continue;
    const evidence = clipPurpose(raw.evidence, 240), summary = clipPurpose(raw.summary, 160);
    if (evidence.length < 4 || summary.length < 4 || !ids.some(id => String(sources.get(id).content).includes(evidence))) continue;
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < .7 || confidence > 1) continue;
    // A source cannot be rephrased into many new goals on later passes.
    if ([...record.goals, ...added].some(g => g.owner === raw.owner && g.sourceIds.some(id => ids.includes(id)))) continue;
    const id = `purpose-${hash(`${record.characterId}|${raw.owner}|${ids.join('|')}`)}`;
    const expiresAt = Math.min(now + c.ttlHours * HOUR, Math.max(...ids.map(id => sources.get(id).timestamp)) + 72 * HOUR);
    const notBefore = now + int(raw.waitMinutes, 0, 0, 360) * MINUTE;
    if (notBefore + MINUTE >= expiresAt) continue;
    added.push({ id, owner: raw.owner, kind: raw.kind, summary, evidence, sourceIds: ids,
      source: 'chat', sessionId: c.sessionId, confidence, value: .5,
      createdAt: now, updatedAt: now, notBefore, expiresAt, state: 'pending' });
  }
  return added;
}
const TEMPORAL = /早安|午安|晚安|早上好|上午好|中午好|下午好|晚上好|凌晨|清晨|今[天早晚夜晨]|昨[天晚夜]|明[天早晚夜]|后天|刚刚|刚才|此刻|现在|这会儿|[上下]午|[早晚]上|今晚|明晚|\d{1,2}\s*[:：]\s*\d{2}|\d+\s*[点时]|\b(good\s+(morning|afternoon|evening|night)|today|tonight|tomorrow|yesterday|now|just\s+now)\b|おはよう|こんにちは|こんばんは|おやすみ|今日|明日|昨日|今朝/i;
export function validatePurposeDraft(output, goal, record) {
  if (!output || output.goalId !== goal.id || output.timeless !== true || typeof output.text !== 'string') throw new Error('表达缺少有效的目的标识或时间独立声明');
  const text = output.text.trim();
  if (Array.from(text).length < 4 || Array.from(text).length > 240 || TEMPORAL.test(text)) throw new Error('表达含具体时段或相对时间，或长度不合格；本轮不排程');
  if (!Array.isArray(output.sourceIds) || output.sourceIds.length !== goal.sourceIds.length || goal.sourceIds.some(id => !output.sourceIds.includes(id))) throw new Error('表达来源与目的不一致');
  if (record.deliveries.some(d => textKey(d.text) === textKey(text))) throw new Error('表达与已有记录重复');
  return text;
}
export function ownedSchedule(entry, delivery) {
  const req = delivery.request;
  return !!req && Number(entry?.id) > 0 && entry.character_id === req.character_id &&
    entry.session_id === req.session_id && Number(entry.timestamp) === req.timestamp && entry.message === req.message &&
    (!delivery.hostId || Number(entry.id) === delivery.hostId);
}
