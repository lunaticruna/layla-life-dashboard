import LaylaSDK from '@layla-network/sdk';
import { VERSION, KINDS, PHASES, DOC_KINDS, TIMEZONES, buildCardSyncBlock, experiencedScenes, createProfile, advanceProfile, makeSnapshot, parts, hhmm, formatTime, lunarCalendar, validatePlan, parseTime } from './core.js';
import { createStore } from './store.js';
import { listCharacters, refreshLife, generateCurrentScene, generatePlan, generateDocument, syncCharacterCard, writeMemory, enrichMemory, recordRetrievalCheck, runBackground } from './workflow.js';
import { GRAPH_LABELS, RETRIEVAL_LABELS, readTriples } from './memory-graph.js';
import { exportCharacterBackup } from './export.js';
import { stringToBase64 } from './zip.js';
import { installDemo } from './demo.js';
import { icon, room } from './icons.js';

const isNative = typeof window.ReactNativeWebView?.postMessage === 'function';
const demo = !isNative;
if (demo) installDemo();
const client = new LaylaSDK(), store = createStore(client);
const state = { roles: [], character: null, profile: null, docs: [], runs: [], scenes: [], sceneGenerating: false, native: null, context: null, portrait: null, tab: 'overview', kind: 'all', loading: true, error: '', busy: false };
let controller = null, toastTimer;
const root = document.getElementById('app');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round = value => Math.round(value);
const statusName = d => d.syncStatus === 'written' ? (demo ? '已模拟写入' : '已写入') : d.syncStatus === 'stale' ? '待更新记忆' : ['sending', 'uncertain'].includes(d.syncStatus) ? '待核对' : '待交还';
const cardSyncText = p => p?.settings?.syncCard === false ? '角色卡实时同步已关闭' : p?.cardSync?.status === 'synced' ? `${demo ? '模拟同步角色卡' : '角色卡已同步'} · ${formatTime(p.cardSync.syncedAt, p.settings.timezone)}` : p?.cardSync?.status === 'error' ? `角色卡同步异常：${p.cardSync.error}` : '将在更新生活时同步角色卡';
const btn = (label, action, glyph = '', cls = 'button') => `<button type="button" class="${cls}" data-action="${action}">${glyph ? icon(glyph) : ''}<span>${label}</span></button>`;
const tag = (text, cls = '') => `<span class="tag ${cls}">${esc(text)}</span>`;
const sourceName = x => ({ generated: '模型日程', template: '作息模板', manual: '手动日程' }[x] || '未设定');
function toast(text, error = false) { const el = document.getElementById('toast'); el.textContent = text; el.className = `toast show ${error ? 'error' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.classList.remove('show'); }, error ? 7500 : 4300); }
function closeModal() { const el = document.getElementById('modal'); if (el.open) el.close(); el.innerHTML = ''; }
function modal(title, content, footer = '') {
  const el = document.getElementById('modal');
  el.innerHTML = `<header class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close')}</button></header><div class="modal-body">${content}</div>${footer ? `<footer class="modal-foot">${footer}</footer>` : ''}`;
  if (!el.open) el.showModal();
}
function clockText() { const p = parts(Date.now(), state.profile?.settings.timezone); return `${hhmm(p.minute)}<small>${String(p.second).padStart(2, '0')}</small>`; }
function relative(ts) { if (!ts) return '尚未更新'; const mins = Math.floor((Date.now() - ts) / 60000); return mins <= 0 ? '刚刚更新' : mins < 60 ? `${mins} 分钟前更新` : `${Math.floor(mins / 60)} 小时前更新`; }
function header() {
  const title = { overview: '生活概览', schedule: '日程流转', journal: '日记与梦境', memory: '记忆交还', settings: '生活设置' }[state.tab];
  const day = state.profile ? parts(Date.now(), state.profile.settings.timezone) : parts(Date.now());
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][day.weekday];
  return `<header class="topbar"><div class="top-heading"><div class="breadcrumb">生活手记 <span>/</span> ${esc(title)}</div><h1>${esc(title)}</h1></div><div class="top-actions"><div class="top-date">${day.day.replaceAll('-', '.')}<span>${week}</span></div><span class="connection ${demo ? 'demo' : ''}"><i></i>${demo ? '演示模式' : 'Layla 已连接'}</span>${btn('更新生活', 'refresh', 'refresh', 'button primary compact')}</div></header>`;
}
function sidebar() {
  const tabs = [['overview', 'grid', '生活概览'], ['schedule', 'flow', '日程流转'], ['journal', 'book', '日记与梦境'], ['memory', 'brain', '记忆交还'], ['settings', 'settings', '生活设置']];
  const pending = state.docs.filter(d => d.syncStatus !== 'written').length;
  return `<aside class="sidebar"><div class="brand"><div class="brand-symbol">${icon('leaf')}</div><div><strong>生活手记</strong><span>让日常慢慢留下痕迹</span></div></div><div class="role-switch"><span class="eyebrow">正在陪伴的角色</span><div class="role-select"><div class="avatar small">${state.portrait ? `<img src="${esc(state.portrait)}" alt="角色头像">` : esc(state.character?.data.data.name?.slice(0, 1) || '·')}</div><select id="character-select" aria-label="选择角色">${state.roles.length ? state.roles.map(c => `<option value="${esc(c.id)}" ${c.id === state.character?.id ? 'selected' : ''}>${esc(c.data.data.name || '未命名角色')}</option>`).join('') : '<option>暂无角色</option>'}</select></div></div><nav aria-label="主导航">${tabs.map(([id, glyph, label]) => `<button class="nav-item ${id === state.tab ? 'active' : ''}" type="button" data-tab="${id}">${icon(glyph)}<span>${label}</span>${id === 'memory' && pending ? `<b>${pending}</b>` : ''}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="side-note">${icon('leaf')}<p>生活会继续，<br>值得记住的事慢慢交还。</p></div><div class="sidebar-version">生活手记 ${VERSION}<span>${demo ? '浏览器演示' : `Layla ${esc(state.context?.app_version || '版本未知')}`}</span></div></div></aside>`;
}
function statCard(glyph, title, value, foot, cls = '') { return `<div class="status-card ${cls}"><div class="status-icon">${icon(glyph)}</div><div class="status-content"><span class="field-label">${title}</span><strong${title === '当前活动' ? ' data-current-activity' : ''}>${esc(value)}</strong><small>${esc(foot)}</small></div></div>`; }
function metric(glyph, title, value, sub, cls = '') { return `<div class="metric ${cls}"><div class="metric-label">${icon(glyph)}${title}</div><div class="metric-value">${round(value)}<small>/ 100</small></div><div class="meter"><i style="width:${Math.max(0, Math.min(100, value))}%"></i></div><span>${sub}</span></div>`; }
function sectionHead(title, sub, action = '') { return `<div class="section-heading"><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${action}</div>`; }
function sceneFoot(snap) {
  if (snap.sceneAttempt) return `上次细化未完成：${snap.sceneAttempt.error}。可手动重试；自动重试间隔十分钟。`;
  if (snap.sceneRecord) return `${snap.sceneRecord.source === 'manual' ? '手动场景' : '模型场景'} · ${formatTime(snap.sceneRecord.generatedAt, state.profile.settings.timezone)} · ${PHASES[snap.sceneRecord.phase]}`;
  if (snap.current?.source === 'manual' && snap.scene) return '手动场景 · 将在更新生活时记入片段';
  return state.profile.settings.autoScene ? '进入当前节点后细化，普通刷新复用同一片段' : '自动细化已关闭，可手动生成当前场景';
}
function sceneHistory() {
  const now = Date.now(), rows = experiencedScenes(state.scenes, state.character.id, now, parts(now, state.profile.settings.timezone).day).slice(-8).reverse();
  return `<section class="panel scene-history">${sectionHead('已记录的生活片段', '日记会参考这些已发生片段，未记录时段保持空白')}${rows.length ? rows.map(r => `<article class="scene-history-item"><div><time>${esc(formatTime(r.generatedAt, state.profile.settings.timezone))}</time>${tag(PHASES[r.phase], 'muted')}</div><h3>${esc(r.summary)}</h3><p>${esc(r.scene)}</p></article>`).join('') : '<div class="empty-inline">今天还没有已记录的生活片段。细化当前场景后会保存在这里。</div>'}</section>`;
}
function scheduleFlow(snap) {
  const nextTime = snap.next ? `${snap.nextDate === snap.day ? '' : '明日 '}${hhmm(snap.next.start)}` : '—';
  const mins = snap.nextStart ? Math.max(0, Math.ceil((snap.nextStart - Date.now()) / 60000)) : 0;
  return `<div class="flow-current"><div class="flow-marker"><i></i><span>当前节点</span>${tag(sourceName(snap.source), 'muted')}</div><h3>${esc(snap.current?.summary || '未安排')}</h3><div class="node-meta">${icon('clock')}<span>时间窗</span><b>${snap.current ? `${hhmm(snap.current.start)} – ${hhmm(snap.current.end)}` : '—'}</b><span class="meta-divider"></span><span>节点类型</span><b>${esc(KINDS[snap.current?.kind] || '未知')}</b></div><div class="progress-line"><i style="width:${snap.progress * 100}%"></i></div><div class="scene"><span>细化场景</span><p data-scene-text>${esc(snap.scene || '场景尚待细化')}</p><div class="scene-tools"><small>${esc(sceneFoot(snap))}</small>${btn(snap.current?.source === 'manual' && snap.current.scene ? '编辑手动场景' : snap.scene ? '重新生成场景' : '生成当前场景', snap.current?.source === 'manual' && snap.current.scene ? 'edit-plan' : 'regenerate-scene', 'spark', 'text-button')}</div></div></div><div class="flow-next"><div class="next-clock">${icon('arrow')}</div><div><span class="field-label">下一节点</span><strong>${esc(snap.next?.summary || '暂无下一节点')}</strong><small><span>下一节点开始</span> <b>${nextTime}</b>${mins ? ` · 约 ${mins >= 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟` : `${mins} 分钟`}后` : ''}</small></div></div>`;
}
function noteCard(d) {
  const glyph = d.kind === 'dream' ? 'moon' : d.kind === 'work' ? 'spark' : 'book';
  return `<button class="note-card ${d.kind}" type="button" data-doc="${esc(d.id)}"><div class="note-top"><span class="note-kind">${icon(glyph)}${DOC_KINDS[d.kind]}</span>${tag(statusName(d), d.syncStatus === 'written' ? 'green' : 'muted')}</div><h3>${esc(d.title)}</h3><p>${esc(d.summary)}</p><footer><span>${esc(d.day)}</span><span>阅读全文 ${icon('arrow')}</span></footer></button>`;
}
function overview() {
  const p = advanceProfile(state.profile, Date.now()), snap = makeSnapshot(p), metrics = p.state;
  const weatherFoot = p.settings.weatherAt ? `${p.settings.weatherCity || '未设城市'} · ${snap.weatherStale ? '记录已超过 6 小时' : '手动记录'}` : '在生活设置中记录天气';
  const latest = state.docs.slice(0, 2);
  return `<div class="intro-line"><p>看看${esc(p.name)}的这一天，正在怎样慢慢展开。</p><span class="updated">${icon('clock')}<span data-updated>${relative(state.profile.state.updatedAt)}</span></span></div><section class="hero"><div class="hero-copy"><div class="hero-topline"><span class="eyebrow">正在做的事</span>${tag('角色生活模拟', 'outline')}</div><h2>${esc(snap.current?.summary || snap.activity)}</h2><p>${esc(snap.scene ? snap.scene.slice(0, 76) + (snap.scene.length > 76 ? '…' : '') : '沿着自己的作息，让日常慢慢留下片段。')}</p><div class="hero-pills"><span>${icon('pin')}${esc(snap.location)}</span><span>${icon('heart')}${esc(snap.mood)}</span></div></div><div class="hero-art">${room}</div><div class="hero-clock"><div data-clock>${clockText()}</div><span>${TIMEZONES[p.settings.timezone]?.name || '北京时间'}</span></div></section><section class="status-grid" aria-label="正在做的事">${statCard('moon', '睡眠阶段', snap.sleepPhaseLabel, ['deep_sleep', 'light_sleep', 'falling_asleep'].includes(snap.sleepPhase) ? '生活时间线中的休息阶段' : '依据作息与原生回复补算', 'lavender')}${statCard('leaf', '当前活动', snap.scene || '场景尚待细化', sceneFoot(snap), 'activity-card')}${statCard('pin', '所在位置', snap.location, '角色场景中的位置')}${statCard('heart', '心情', snap.mood, `愉悦度 ${metrics.mood.toFixed(2)} · 活跃度 ${metrics.arousal.toFixed(2)}`, 'rose')}${statCard('cloud', '天气', snap.weather, weatherFoot, 'sand')}${statCard('health', '健康备注', snap.healthNote, p.settings.healthNote ? '手动备注 · 角色状态' : '依据生活数值整理')}</section><div class="dashboard-columns"><section class="panel flow-panel">${sectionHead('日程流转', '当前时刻与下一段生活', btn('查看全天', 'go-schedule', 'arrow', 'text-button'))}${scheduleFlow(snap)}<div class="day-context"><div><span class="field-label">日期类型</span><strong>${esc(snap.dayType)}</strong></div><div><span class="field-label">近期节日</span><strong>${esc(snap.festivals[0] ? `${snap.festivals[0].name} · ${snap.festivals[0].days === 0 ? '今天' : `${snap.festivals[0].days} 天后`}` : '暂无记录')}</strong></div></div></section><section class="panel state-panel">${sectionHead('生活状态', '数值随日程与时间推进')}<div class="metrics">${metric('bolt', '精力', metrics.energy, metrics.energy > 65 ? '还有余裕，适合慢慢做事' : '留一些空间给休息')}${metric('cup', '饥饿', metrics.hunger, metrics.hunger > 70 ? '接下来可以安排用餐' : '越低表示越接近饱腹', 'sand')}${metric('heart', '心情', (metrics.mood + 1) * 50, `${snap.mood} · 以中性偏正为基线`, 'rose')}</div><div class="small-note">${icon('info')}<span>这里记录角色的生活模拟。天气来自你的记录，尚未接入实时天气。</span></div></section></div><section class="notes-section">${sectionHead('今天留下的片段', '生活、梦境和想法，在这里慢慢归档', `<div class="inline-actions">${btn('生成日记', 'generate-diary', 'plus', 'button subtle')}${btn('记录梦境', 'generate-dream', 'moon', 'button subtle')}</div>`)}<div class="notes-grid">${latest.length ? latest.map(noteCard).join('') : '<div class="empty-card">还没有记录。生成一篇日记，留下今天的第一个片段。</div>'}</div></section><div class="bottom-caption">${icon('leaf')}${p.settings.syncCard !== false ? '今日实时作息已同步到角色卡指令；跨日经历通过长期记忆召回。' : '原生聊天通过记忆自行召回这些片段。'}<span>${esc(cardSyncText(state.profile))}</span></div>`;
}
function scheduleView() {
  const p = advanceProfile(state.profile, Date.now()), s = makeSnapshot(p);
  return `<div class="intro-line"><p>沿着时间往前走，每个节点都有自己的位置。</p>${tag(sourceName(s.source), 'muted')}</div><section class="panel schedule-summary">${sectionHead(`${s.day} 的生活安排`, '完整覆盖 00:00–24:00；可生成或手动调整', `<div class="inline-actions">${btn('编辑日程', 'edit-plan', 'edit', 'button subtle')}${btn('生成今日日程', 'generate-plan', 'spark', 'button primary')}</div>`)}${scheduleFlow(s)}</section><div class="calendar-strip"><span>${icon('sun')}日期类型 <b>${esc(s.dayType)}</b></span><span>近期节日 ${s.festivals.map(f => `<b>${esc(f.name)} · ${f.days === 0 ? '今天' : `${f.days} 天后`}</b>`).join(' / ') || '暂无记录'}</span></div><section class="panel timeline-panel"><div class="timeline-title"><h2>全天时间线</h2><span>日历提示不包含法定调休判定</span></div><ol class="timeline">${s.nodes.map(n => {
    const current = n.id === s.current?.id;
    return `<li class="timeline-row ${current ? 'current' : n.end <= s.minute ? 'past' : ''}"><div class="time"><b>${hhmm(n.start)}</b><span>${hhmm(n.end)}</span></div><div class="timeline-dot"></div><div class="timeline-content"><div class="timeline-heading"><h3>${esc(n.summary)}</h3>${current ? tag('正在进行', 'green') : tag(KINDS[n.kind], 'muted')}</div><div class="timeline-location">${icon('pin')}${esc(n.location)}</div>${current && s.scene ? `<p>${esc(s.scene)}</p>` : n.source === 'manual' && n.scene ? `<p><span class="field-label">手动计划场景</span>${esc(n.scene)}</p>` : ''}</div></li>`;
  }).join('')}</ol></section>${sceneHistory()}`;
}
function journalView() {
  const docs = state.docs.filter(d => state.kind === 'all' || d.kind === state.kind);
  return `<div class="intro-line"><p>保留完整的正文，也保留每个片段从哪里来。</p><span class="updated">共 ${state.docs.length} 篇</span></div><div class="journal-tools"><div class="filters">${[['all', '全部'], ...Object.entries(DOC_KINDS)].map(([key, label]) => `<button type="button" data-filter="${key}" class="filter ${state.kind === key ? 'active' : ''}">${label}</button>`).join('')}</div><div class="inline-actions">${btn('写日记', 'generate-diary', 'plus', 'button subtle')}${btn('记梦境', 'generate-dream', 'moon', 'button subtle')}${btn('做反思', 'generate-reflection', 'leaf', 'button subtle')}${btn('写作品', 'generate-work', 'spark', 'button primary')}</div></div><div class="notes-grid journal-grid">${docs.length ? docs.map(noteCard).join('') : '<div class="empty-card">这里还没有这类记录。用右上角的入口生成第一篇。</div>'}</div><div class="small-note journal-note">${icon('info')}<span>每个角色每天每类记录归档一篇；已有内容会直接打开，当天的记录可在阅读窗口点“重新整理”原位更新。</span></div>`;
}
const graphName = d => demo && d.graphStatus === 'ready' ? '模拟图谱已核对' : GRAPH_LABELS[d.graphStatus] || '待核对';
function memoryControls(d, compact = false) {
  const cls = `button ${compact ? 'subtle compact' : 'primary'}`;
  if (d.syncStatus !== 'written') return `<button class="${cls}" type="button" data-write="${esc(d.id)}">${['sending', 'uncertain'].includes(d.syncStatus) ? '核对写入' : d.syncStatus === 'stale' ? (demo ? '模拟更新原记忆' : '更新原记忆') : demo ? '模拟交还记忆' : '交还 Layla'}</button>`;
  return `<button class="${cls}" type="button" data-enrich="${esc(d.id)}">${['ready', 'writing', 'uncertain'].includes(d.graphStatus) ? '核对图谱' : '补全图谱'}</button><button class="button subtle compact" type="button" data-review="${esc(d.id)}">记录召回验收</button>`;
}
function memoryView() {
  const saved = state.docs.filter(d => d.syncStatus === 'written').length, ready = state.docs.filter(d => d.graphStatus === 'ready').length, passed = state.docs.filter(d => d.retrievalStatus === 'passed').length;
  return `<div class="intro-line"><p>文本保存、图谱补全和自然召回，分别核对。</p>${tag(demo ? '仅模拟写入' : '原生记忆回写', 'outline')}</div><div class="memory-counters"><div><span>文本已保存</span><strong>${saved}<small>篇</small></strong></div><div><span>图谱已核对</span><strong>${ready}<small>篇</small></strong></div><div><span>实际召回</span><strong class="counter-text">${passed ? `${passed} 篇用户验收通过` : '待真机验收'}</strong></div></div><div class="memory-explanation">${icon('brain')}<div><h3>当日实时同步 + 长期记忆图谱，分工互不冲突</h3><p>当天起床时间与实时活动由“角色卡实时状态同步”确定性提供；跨日与历史记录通过独立归档会话原子写入文本、时间锚点与角色一跳图谱（梦境与创作仍保持二跳隔离）。旧记录可逐篇点“补全图谱”；图谱已核对不代表自然召回已自动验证。</p></div></div><section class="panel memory-list">${sectionHead('交还记录', '点击记录查看原文、图谱与验收结果')}${state.docs.length ? state.docs.map(d => `<div class="memory-row"><button class="memory-title" data-doc="${esc(d.id)}"><span>${DOC_KINDS[d.kind]} · ${d.day}</span><strong>${esc(d.title)}</strong></button><div class="memory-state">${tag(statusName(d), d.syncStatus === 'written' ? 'green' : 'muted')}${tag(graphName(d), d.graphStatus === 'ready' ? 'green' : 'muted')}<small>${d.memoryId ? `记忆 #${d.memoryId} · ` : ''}${RETRIEVAL_LABELS[d.retrievalStatus]}</small>${d.graphError ? `<small class="memory-error">${esc(d.graphError)}</small>` : ''}</div><div class="memory-actions">${memoryControls(d, true)}</div></div>`).join('') : '<div class="empty-card">生成日记或梦境后，会在这里等待交还。</div>'}</section>`;
}
function settingsView() {
  const p = state.profile, s = p.settings;
  const syncPreview = p.cardSync?.preview || buildCardSyncBlock(advanceProfile(p, Date.now()), state.scenes, state.docs, Date.now());
  const input = (name, label, value, type = 'text', note = '') => `<label class="form-field"><span>${label}</span><input type="${type}" name="${name}" value="${esc(value)}" ${type === 'number' ? 'min="0" max="23"' : ''}>${note ? `<small>${note}</small>` : ''}</label>`;
  return `<div class="intro-line"><p>调整这个角色的作息、环境，以及记录整理方式。</p>${tag('按角色独立保存', 'muted')}</div><form id="settings-form"><section class="panel settings-panel">${sectionHead('作息与环境', '时间以你在此选择的时区为准')}<div class="form-grid"><label class="form-field"><span>生活时区</span><select name="timezone">${Object.entries(TIMEZONES).map(([k, v]) => `<option value="${k}" ${s.timezone === k ? 'selected' : ''}>${v.name} · ${k}</option>`).join('')}</select></label>${input('home', '默认位置', s.home, 'text', '用于尚未生成具体场景的日程')}${input('sleepStart', '开始休息', s.sleepStart, 'time')}${input('sleepEnd', '结束休息', s.sleepEnd, 'time')}${input('weatherCity', '天气对应城市', s.weatherCity)}${input('weatherNote', '天气记录', s.weatherNote, 'text', '手动填写；保存更改时记录更新时间，不会冒充实时天气')}<label class="form-field full"><span>健康备注</span><input name="healthNote" value="${esc(s.healthNote)}" placeholder="例如：今天有点累，想早点休息"><small>这是角色的生活备注。</small></label><label class="form-field"><span>日期类型</span><select name="dayType"><option value="">按星期判断</option>${['工作日', '周末', '节假日', '调休工作日'].map(x => `<option ${s.dayType === x ? 'selected' : ''}>${x}</option>`).join('')}</select><small>手动设置会持续生效，之后可改回按星期判断。</small></label><label class="form-field"><span>参考原生会话</span><select name="selectedSessionId">${state.native?.sessions?.length ? state.native.sessions.map(x => `<option value="${esc(x.session_id)}" ${p.selectedSessionId === x.session_id ? 'selected' : ''}>${esc(formatTime(x.last_message_timestamp > 1e11 ? x.last_message_timestamp : x.last_message_timestamp * 1000, s.timezone))} · ${esc(String(x.last_message_content || '会话').slice(0, 25))}</option>`).join('') : '<option value="">尚无原生会话</option>'}</select></label><label class="form-field full"><span>补充节日或纪念日期</span><textarea name="holidayNotes" rows="3" placeholder="2026-12-01 纪念日">${esc(s.holidayNotes)}</textarea><small>每行“YYYY-MM-DD 名称”。公历节日及设备支持的农历节日会自动补充。</small></label></div></section><section class="panel settings-panel">${sectionHead('对话实时同步与长期召回', '方案一负责当天确定性作息同步，方案二负责跨会话长期记忆召回')}<div class="toggle-row"><div><strong>同步今日作息与摘要到角色卡指令</strong><p>在角色卡 post_history_instructions 末尾维护带标记的今日起床时间、当前活动与日记摘要，确保当天对话不漏召回、不猜错起床时间。关闭后自动移除该标记块，不改动原有角色设定。</p></div><label class="switch"><input type="checkbox" name="syncCard" ${s.syncCard !== false ? 'checked' : ''} aria-label="同步今日作息与摘要到角色卡指令"><span></span></label></div><div class="sync-box"><div class="sync-meta"><span>${esc(cardSyncText(p))}</span><div class="inline-actions">${btn('立即同步状态块', 'sync-card', 'refresh', 'button subtle compact')}${btn('清除角色卡同步块', 'clear-card-sync', 'close', 'button subtle compact')}</div></div>${syncPreview ? `<details class="sync-details"><summary>查看当前实时状态同步块内容</summary><pre class="sync-preview">${esc(syncPreview)}</pre></details>` : ''}</div><div class="form-grid"><label class="form-field full"><span>长期记忆会话归属策略</span><select name="memorySessionMode"><option value="isolated" ${s.memorySessionMode !== 'active' ? 'selected' : ''}>独立归档会话（推荐：避免当前聊天会话屏蔽刚交还的记忆）</option><option value="active" ${s.memorySessionMode === 'active' ? 'selected' : ''}>绑定上方选定的原生聊天会话</option></select><small>Layla 在同一聊天会话中可能跳过近期同会话记忆；使用独立归档会话可让刚交还的日记与跨日记录在当前会话和新会话中均参与检索。</small></label></div></section><section class="panel settings-panel">${sectionHead('场景细化', '结合现有角色设定、当前节点、睡眠阶段与已有生活片段')}<div class="toggle-row"><div><strong>自动细化当前场景</strong><p>打开看板、进入新节点或睡眠阶段变化时生成。普通刷新复用缓存；生成失败后间隔十分钟重试。</p></div><label class="switch"><input type="checkbox" name="autoScene" ${s.autoScene ? 'checked' : ''} aria-label="自动细化当前场景"><span></span></label></div><p class="form-help">可随时在日程流转中手动生成。修改天气或健康备注后，可点“重新生成场景”采用新信息。手动填写的场景会保留。</p></section><section class="panel settings-panel">${sectionHead('后台整理与记忆', '后台每轮最多细化一个场景、整理一篇内容')}<div class="toggle-row"><div><strong>开启后台生活整理</strong><p>同时需要在 Layla 任务管理器中启用“生活手记”。执行时间由宿主与系统安排。</p></div><label class="switch"><input type="checkbox" name="background" ${s.background ? 'checked' : ''} aria-label="开启后台生活整理"><span></span></label></div><div class="toggle-row"><div><strong>自动交还新记录</strong><p>开启后，新生成内容会原子保存原生文本与图谱。关闭时由你逐篇交还；旧记录由你手动补全。</p></div><label class="switch"><input type="checkbox" name="autoWrite" ${s.autoWrite ? 'checked' : ''} aria-label="自动交还新记录"><span></span></label></div><div class="form-grid">${input('diaryHour', '每日开始整理日记的小时', s.diaryHour, 'number', '例如 21 表示 21:00 之后获得执行机会时整理')}</div></section><div class="settings-actions">${btn('导出生活记录', 'export', 'download', 'button subtle')}<button type="submit" class="button primary">${icon('check')}<span>保存设置</span></button></div></form><section class="panel settings-panel logs-panel">${sectionHead('最近的整理记录', '保留最近 20 次运行的展示结果')}${state.runs.slice(0, 8).map(r => `<div class="log-row"><span>${esc(formatTime(r.at, s.timezone))}</span><p>${esc(r.message)}</p>${tag(r.status === 'ok' ? '完成' : '异常', r.status === 'ok' ? 'green' : 'muted')}</div>`).join('') || '<div class="empty-inline">还没有运行记录。</div>'}</section><p class="settings-footnote">生活手记 ${VERSION} · Layla SDK 7.6.2。内容生成参考最近 3 个会话、每会话最多 60 条消息和宿主选出的重要记忆。</p>`;
}
function render() {
  if (state.loading) { root.innerHTML = '<div class="loading-screen"><div class="brand-symbol">' + icon('leaf') + '</div><h1>生活手记</h1><p>正在读取角色与生活记录…</p><div class="spinner"></div></div>'; return; }
  if (state.error || !state.character || !state.profile) { root.innerHTML = `<div class="loading-screen"><div class="brand-symbol">${icon('leaf')}</div><h1>${state.error ? '暂时无法打开看板' : '还没有可用角色'}</h1><p>${esc(state.error || '先在 Layla 中创建或导入一个角色，再打开生活手记。')}</p>${btn('重新连接', 'retry', 'refresh', 'button primary')}</div>`; return; }
  const view = { overview, schedule: scheduleView, journal: journalView, memory: memoryView, settings: settingsView }[state.tab];
  root.innerHTML = `${sidebar()}<main class="main">${header()}${demo ? '<div class="demo-banner"><b>演示数据</b><span>尚未连接你的 Layla；这里的角色、天气、内容生成与记忆写入均为本地示例。</span></div>' : ''}<div class="content">${state.sceneGenerating ? `<div class="scene-generating" role="status"><div class="spinner"></div><span id="scene-progress">正在细化当前场景…</span>${btn('停止生成', 'stop-job', 'close', 'text-button')}</div>` : ''}${view()}</div></main>`;
  if (state.busy) root.querySelectorAll('button,select,input,textarea').forEach(el => { if (el.dataset.action !== 'stop-job') el.disabled = true; });
  state.renderedMinute = Math.floor(Date.now() / 60000);
}
async function reload() {
  state.profile = await store.getProfile(state.character.id);
  [state.docs, state.runs, state.scenes] = await Promise.all([store.docs(state.character.id), store.runs(state.character.id), store.scenes(state.character.id)]);
  render();
}
async function choose(id) {
  const character = state.roles.find(c => c.id === id); if (!character) return;
  state.character = character; state.portrait = null;
  let p = await store.getProfile(character.id);
  if (!p) { p = createProfile(character); p.calendar = lunarCalendar(Date.now(), p.settings.timezone); await store.putProfile(p); }
  state.profile = p;
  const result = await refreshLife(client, store, character, { generateScene: false }); state.native = result.native;
  await reload();
  if (!demo) client.characters.getImage(id).then(image => { if (state.character?.id === id && image && /^(data:image\/|https:\/\/)/.test(image)) { state.portrait = image; render(); } }).catch(() => {});
}
async function maybeGenerateScene() {
  if (state.loading || state.busy || state.resuming || !state.profile || !state.character || document.hidden || !['overview', 'schedule'].includes(state.tab) || document.getElementById('modal').open || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  const snap = makeSnapshot(advanceProfile(state.profile, Date.now()));
  if (snap.sceneRecord || !state.profile.settings.autoScene || snap.sceneAttempt?.retryAt > Date.now()) return;
  state.busy = true; state.sceneGenerating = true; controller = new AbortController(); render();
  try {
    await generateCurrentScene(client, store, state.character, { signal: controller.signal, onText: text => { const el = document.getElementById('scene-progress'); if (el) el.textContent = `正在细化当前场景 · 已生成 ${text.length} 字符`; } });
  } catch (e) { toast(controller.signal.aborted ? '已停止场景生成，可稍后手动重试' : e.message || String(e), !controller.signal.aborted); }
  finally { state.busy = false; state.sceneGenerating = false; controller = null; await reload(); }
}
async function init() {
  state.loading = true; state.error = ''; render();
  try {
    state.context = await client.contextual.getExecutionContext();
    await store.init(); state.roles = await listCharacters(client);
    if (state.roles.length) await choose(state.context.character?.id || state.roles[0].id);
  } catch (e) { state.error = e.message || String(e); }
  finally { state.loading = false; render(); void maybeGenerateScene(); }
}
async function job(title, action) {
  if (state.busy) return;
  state.busy = true; controller = new AbortController();
  modal(title, '<div class="generation-status"><div class="spinner"></div><h3>正在整理这个片段</h3><p>模型在设备上生成内容时可能需要一点时间。</p><span id="generation-count">准备生成…</span></div>', btn('停止生成', 'stop-job', 'close', 'button subtle'));
  try {
    const result = await action({ signal: controller.signal, onText: text => { const el = document.getElementById('generation-count'); if (el) el.textContent = `已生成 ${text.length} 字符，正在整理…`; } });
    closeModal(); await reload(); return result;
  } catch (e) { closeModal(); toast(controller.signal.aborted ? '已停止；已完成的归档或记忆写入会保留' : e.message || String(e), !controller.signal.aborted); }
  finally { state.busy = false; controller = null; await reload(); }
}
function graphDetails(d) {
  let rows = []; try { rows = readTriples(d.graphStatus === 'ready' ? d.graphVerifiedJSON : d.graphDraftJSON); } catch { /* Missing graphs have no preview. */ }
  return `<section class="reader-memory"><h3>记忆处理状态</h3><dl><dt>文本保存</dt><dd>${esc(statusName(d))}${d.memoryId ? ` · #${d.memoryId}` : ''}</dd><dt>图谱</dt><dd>${esc(graphName(d))}</dd><dt>自然召回</dt><dd>${esc(RETRIEVAL_LABELS[d.retrievalStatus])}${d.retrievalCheckedAt ? ` · 用户记录于 ${esc(formatTime(d.retrievalCheckedAt, state.profile.settings.timezone))}` : ''}</dd></dl>${d.graphError ? `<p class="memory-error">${esc(d.graphError)}</p>` : ''}${rows.length ? `<details><summary>${d.graphStatus === 'ready' ? '查看已核对图谱' : '查看图谱草稿（尚未确认写入）'} · ${rows.length} 条关系</summary><div class="graph-table-wrap"><table class="graph-table"><thead><tr><th>主体</th><th>关系</th><th>对象</th></tr></thead><tbody>${rows.map(t => `<tr><td>${esc(t.subject)}</td><td>${esc(t.relationship)}</td><td>${esc(t.object)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}<p class="form-help">图谱字段回读成功不代表原生索引已刷新。自然召回只记录你的真机测试结果，不由模型回答或排名自动判定。</p>${d.retrievalCheck?.note ? `<p>验收备注：${esc(d.retrievalCheck.note)}</p>` : ''}</section>`;
}
function openDocument(id) {
  const d = state.docs.find(x => x.id === id); if (!d) return;
  const isToday = d.day === parts(Date.now(), state.profile.settings.timezone).day;
  const footer = `${btn('导出正文', `export-doc:${d.id}`, 'download', 'button subtle')}${isToday ? btn(`重新整理`, `regenerate-doc:${d.kind}`, 'refresh', 'button subtle') : ''}${memoryControls(d)}`;
  modal(d.title, `<div class="reader-meta">${tag(DOC_KINDS[d.kind], 'muted')}<span>${d.day}</span>${tag(statusName(d), d.syncStatus === 'written' ? 'green' : 'muted')}</div><div class="prose">${esc(d.body)}</div><div class="reader-summary"><h3>准备交还的摘要</h3><p>${esc(d.summary)}</p></div><div class="reader-source">${d.kind === 'dream' ? '梦境记录，与现实经历分别保存。' : d.kind === 'work' ? '创作内容，与现实事件分别保存。' : '生活场景为角色第一人称日常记录，聊天回顾依据读取到的原生消息。'}${d.timelineFacts?.wakeSummary ? `<br>当日作息锚点：${esc(d.timelineFacts.wakeSummary)}。` : ''}${d.sourceSceneIds ? `<br>参考 ${d.sourceSceneIds.length} 个已记录生活片段，整理截至 ${esc(formatTime(d.recordedThrough || d.createdAt, state.profile.settings.timezone))}。` : ''}</div>${graphDetails(d)}`, footer);
}
function memoryToast(d) {
  if (d.graphStatus === 'ready') toast(demo ? '模拟图谱已核对；没有改动真实角色' : '原生文本与图谱已核对，自然召回仍需真机验收');
  else toast(d.graphError ? `文本已保存，图谱未完成：${d.graphError}` : '文本已保存，可继续补全图谱', !!d.graphError);
}
async function handleWrite(id) {
  const d = state.docs.find(x => x.id === id);
  const result = await job('交还记忆并补全图谱', opts => writeMemory(client, store, id, { ...opts, reconcileOnly: ['sending', 'uncertain'].includes(d?.syncStatus) }));
  if (result) { openDocument(id); memoryToast(result); }
}
async function handleEnrich(id) {
  const result = await job('补全或核对原生图谱', opts => enrichMemory(client, store, id, opts));
  if (result) { openDocument(id); memoryToast(result); }
}
function openRetrievalCheck(id) {
  if (state.busy) return;
  const d = state.docs.find(x => x.id === id); if (!d) return;
  modal('记录召回验收', `<p class="form-help">此处只记录你的真机测试结论。请用没有贴过原文的新会话，询问一条未在聊天透露过的新记录；提供原文后的正确回答不计为自然召回通过。</p><form id="retrieval-form" data-id="${esc(id)}"><label class="form-field"><span>验收结果</span><select name="result">${Object.entries(RETRIEVAL_LABELS).map(([key, name]) => `<option value="${key}" ${d.retrievalStatus === key ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label class="retrieval-confirm"><input type="checkbox" name="cleanSession" ${d.retrievalCheck?.cleanSession ? 'checked' : ''}>我已在未贴原文的新会话中测试</label><label class="form-field"><span>验收备注</span><textarea name="note" rows="3" maxlength="1000" placeholder="记录问法、回答中的独特细节，或未通过的表现">${esc(d.retrievalCheck?.note || '')}</textarea></label><p class="form-help">这是用户报告，不代表程序捕获到了原生聊天的召回日志。后续修改图谱会将验收状态重置为尚未验收。</p></form>`, '<button type="submit" form="retrieval-form" class="button primary">保存验收结果</button>');
}
function editorRow(n, i) { return `<div class="plan-editor-row"><span class="row-index">${i + 1}</span><input name="start" type="time" value="${hhmm(n.start)}" aria-label="节点${i + 1}开始时间"><input name="end" type="text" inputmode="numeric" value="${hhmm(n.end)}" placeholder="24:00" aria-label="节点${i + 1}结束时间"><select name="kind" aria-label="节点${i + 1}类型">${Object.entries(KINDS).map(([key, label]) => `<option value="${key}" ${key === n.kind ? 'selected' : ''}>${label}</option>`).join('')}</select><input name="summary" value="${esc(n.summary)}" aria-label="节点${i + 1}名称"><input name="location" value="${esc(n.location)}" aria-label="节点${i + 1}位置"><textarea name="scene" rows="2" aria-label="节点${i + 1}细化场景">${esc(n.scene)}</textarea></div>`; }
function editPlan() { const s = makeSnapshot(state.profile); modal('编辑今日日程', `<p class="form-help">保持节点首尾相接，从 00:00 覆盖到 24:00。每行依次为开始、结束、类型、名称、位置与细化场景。</p><form id="plan-form"><div class="plan-editor">${s.nodes.map(editorRow).join('')}</div></form>`, '<button type="submit" form="plan-form" class="button primary">保存日程</button>'); }
async function saveSettings(form) {
  if (state.busy) return;
  const fd = new FormData(form), old = state.profile.settings, start = parseTime(fd.get('sleepStart')), end = parseTime(fd.get('sleepEnd')), hour = Number(fd.get('diaryHour'));
  if (start === null || end === null || start === end || !Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('请检查休息时间与日记整理小时');
  const notes = String(fd.get('holidayNotes') || '').trim();
  if (notes.split('\n').some(x => x.trim() && !/^\d{4}-\d{2}-\d{2}\s+.+$/.test(x.trim()))) throw new Error('补充日期请使用“YYYY-MM-DD 名称”，每行一项');
  let syncCard = true;
  await store.lock(state.character.id, async () => {
    const p = await store.getProfile(state.character.id), s = p.settings;
    for (const key of ['timezone', 'home', 'sleepStart', 'sleepEnd', 'healthNote', 'weatherCity', 'weatherNote', 'dayType']) s[key] = String(fd.get(key) || '').trim().slice(0, 500);
    s.holidayNotes = notes.slice(0, 5000); s.autoScene = fd.has('autoScene'); s.background = fd.has('background'); s.autoWrite = fd.has('autoWrite');
    s.syncCard = fd.has('syncCard'); syncCard = s.syncCard; s.memorySessionMode = fd.get('memorySessionMode') === 'active' ? 'active' : 'isolated'; s.diaryHour = hour;
    if (s.weatherNote !== old.weatherNote || s.weatherCity !== old.weatherCity) s.weatherAt = s.weatherNote ? Date.now() : 0;
    p.selectedSessionId = String(fd.get('selectedSessionId') || ''); p.calendar = lunarCalendar(Date.now(), s.timezone);
    await store.putProfile(p);
  });
  await syncCharacterCard(client, store, state.character, { clear: !syncCard, forceSync: true });
  await reload(); toast('这个角色的生活设置已保存');
}
function toBase64(text) { return stringToBase64(text); }
async function exportFile(filename, text) { const result = await client.utils.saveFile(filename, toBase64(text), true); if (!result?.success) throw new Error(result?.message || '导出失败'); toast('已准备导出文件'); }
async function handleAction(action) {
  if (action === 'close-modal') { if (state.busy) { toast('正在生成，可以使用“停止生成”结束'); return; } closeModal(); return; }
  if (action === 'stop-job') { controller?.abort(); return; }
  if (state.busy) return;
  if (action === 'retry') return init();
  if (action === 'go-schedule') { state.tab = 'schedule'; render(); return; }
  if (action === 'edit-plan') return editPlan();
  if (action === 'sync-card') {
    await store.lock(state.character.id, async () => { const p = await store.getProfile(state.character.id); p.settings.syncCard = true; await store.putProfile(p); });
    const r = await syncCharacterCard(client, store, state.character, { forceSync: true, logRun: true });
    await reload(); toast(r.status === 'error' ? `角色卡同步失败：${r.error}` : '今日作息与摘要已同步到角色卡指令', r.status === 'error'); return;
  }
  if (action === 'clear-card-sync') {
    await store.lock(state.character.id, async () => { const p = await store.getProfile(state.character.id); p.settings.syncCard = false; await store.putProfile(p); });
    const r = await syncCharacterCard(client, store, state.character, { clear: true, forceSync: true, logRun: true });
    await reload(); toast(r.status === 'error' ? `清除同步块失败：${r.error}` : '已清除角色卡实时状态块并关闭自动同步', r.status === 'error'); return;
  }
  if (action === 'refresh') {
    const result = await job('更新生活', async opts => { const r = await refreshLife(client, store, state.character, opts); state.native = r.native; return r; });
    if (result) toast(result.scene?.message || result.native.warnings[0] || '生活状态与当前场景已更新', result.scene?.status === 'error'); return;
  }
  if (action === 'regenerate-scene') { if (await job('细化当前场景', opts => generateCurrentScene(client, store, state.character, { ...opts, force: true }))) toast('当前场景已更新，两处面板共享同一片段'); return; }
  if (action === 'generate-plan') { if (await job('生成今日日程', opts => generatePlan(client, store, state.character, opts))) toast('今日日程已更新'); return; }
  if (action.startsWith('regenerate-doc:')) {
    const kind = action.slice(15), result = await job(`重新整理今日${DOC_KINDS[kind]}`, opts => generateDocument(client, store, state.character, kind, { ...opts, force: true }));
    if (result) { if (state.profile.settings.autoWrite && ['pending', 'stale'].includes(result.syncStatus)) await handleWrite(result.id); else { openDocument(result.id); toast(result.syncStatus === 'stale' ? '今日记录已重新整理，可点“更新原记忆”同步原记忆编号' : '今日记录已重新整理'); } } return;
  }
  if (action.startsWith('generate-')) {
    const kind = action.slice(9), result = await job(`生成${DOC_KINDS[kind]}`, opts => generateDocument(client, store, state.character, kind, opts));
    if (result) { if (state.profile.settings.autoWrite && ['pending', 'stale'].includes(result.syncStatus)) await handleWrite(result.id); openDocument(result.id); } return;
  }
  if (action === 'export') {
    const { filename, base64, isZip, stats } = await exportCharacterBackup(state, store, client);
    const result = await client.utils.saveFile(filename, base64, true);
    if (!result?.success) throw new Error(result?.message || '导出失败');
    toast(`已准备${isZip ? '全量归档 ZIP' : '全量备份 JSON'}（包含 ${stats.documents} 篇记录、${stats.scenes} 个场景、${stats.runs} 条运行历史、${stats.triples} 条图谱三元组）`);
    return;
  }
  if (action.startsWith('export-doc:')) { const d = state.docs.find(x => x.id === action.slice(11)); if (d) return exportFile(`${d.id}.md`, `# ${d.title}\n\n${d.day} · ${DOC_KINDS[d.kind]}\n\n${d.body}\n\n## 摘要\n\n${d.summary}\n`); }
}
document.addEventListener('click', event => {
  const target = event.target.closest('button'); if (!target) return;
  if (target.dataset.tab && !state.busy) { state.tab = target.dataset.tab; render(); window.scrollTo(0, 0); }
  if (target.dataset.filter) { state.kind = target.dataset.filter; render(); }
  if (target.dataset.doc) openDocument(target.dataset.doc);
  if (target.dataset.write) void handleWrite(target.dataset.write);
  if (target.dataset.enrich) void handleEnrich(target.dataset.enrich);
  if (target.dataset.review) openRetrievalCheck(target.dataset.review);
  if (target.dataset.action) handleAction(target.dataset.action).catch(e => toast(e.message || String(e), true));
});
document.addEventListener('change', event => { if (event.target.id === 'character-select' && !state.busy) { state.loading = true; render(); choose(event.target.value).catch(e => { state.error = e.message; }).finally(() => { state.loading = false; render(); }); } });
document.addEventListener('submit', event => {
  if (event.target.id === 'retrieval-form') { event.preventDefault(); if (state.busy) return; const form = event.target, data = new FormData(form); state.busy = true;
    recordRetrievalCheck(store, form.dataset.id, { result: data.get('result'), cleanSession: data.has('cleanSession'), note: data.get('note') }).then(async () => { closeModal(); await reload(); openDocument(form.dataset.id); toast('已保存用户验收结果'); }).catch(e => toast(e.message || String(e), true)).finally(() => { state.busy = false; render(); });
  }

  if (event.target.id === 'settings-form') { event.preventDefault(); saveSettings(event.target).catch(e => toast(e.message, true)); }
  if (event.target.id === 'plan-form') { event.preventDefault(); (async () => {
    const nodes = [...event.target.querySelectorAll('.plan-editor-row')].map(row => Object.fromEntries([...row.querySelectorAll('input,select,textarea')].map(x => [x.name, x.value])));
    const day = parts(Date.now(), state.profile.settings.timezone).day, valid = validatePlan(nodes.map(n => ({ ...n, source: 'manual' })), day);
    await store.lock(state.character.id, async () => { const p = await store.getProfile(state.character.id); const updated = advanceProfile(p, Date.now()); updated.plans[day] = { nodes: valid, source: 'manual', generatedAt: Date.now() }; await store.putProfile(updated); });
    await syncCharacterCard(client, store, state.character, { forceSync: true });
    closeModal(); await reload(); toast('日程已保存');
  })().catch(e => toast(e.message, true)); }
});
document.getElementById('modal').addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
setInterval(() => { const el = document.querySelector('[data-clock]'); if (el) el.innerHTML = clockText(); const updated = document.querySelector('[data-updated]'); if (updated && state.profile) updated.textContent = relative(state.profile.state.updatedAt); if (state.profile && ['overview', 'schedule'].includes(state.tab) && !state.busy && !document.getElementById('modal').open && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) && state.renderedMinute !== Math.floor(Date.now() / 60000)) { render(); void maybeGenerateScene(); } }, 1000);
async function resumeLife() {
  if (!state.character || state.busy || state.loading || state.resuming || document.hidden || document.getElementById('modal').open || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  state.resuming = true;
  try { const roles = await listCharacters(client), character = roles.find(c => c.id === state.character.id); if (!character) throw new Error('当前角色暂不可用，请重新打开看板'); state.roles = roles; state.character = character; const result = await refreshLife(client, store, character, { generateScene: false }); state.native = result.native; await reload(); }
  catch (e) { toast(e.message || String(e), true); }
  finally { state.resuming = false; void maybeGenerateScene(); }
}
window.addEventListener('focus', () => { void resumeLife(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void resumeLife(); });
// Demo export is intentionally limited to test tools; real hosts never expose it.
if (demo) window.__lifeDemo = { client, store, runBackground: () => runBackground(client, store) };
init();
