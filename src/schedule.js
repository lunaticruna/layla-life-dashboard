import { hhmm, pad, parts, KINDS } from './core.js';

export const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export function weekdayOf(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function parseClock(s) {
  if (typeof s === 'number' && Number.isFinite(s)) {
    return Math.max(0, Math.min(1440, Math.round(s)));
  }
  const m = /^\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (mi > 59 || h > 24 || (h === 24 && mi !== 0)) return null;
  return h * 60 + mi;
}

export function clock(minute) {
  const m = Math.max(0, Math.min(1440, Math.round(minute)));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export function isSleep(node) {
  if (!node) return false;
  if (node.kind === 'sleep' || node.kind === 'nap') return true;
  const text = `${node.summary || ''} ${node.activity || ''}`;
  return /睡|眯|打盹|梦/.test(text);
}

export const DEFAULT_DAY_TYPES = [
  { id: 'workday', name: '上班日', enabled: true, weight: 5, days: 'weekday', guide: '常规上班/专注日：起床洗漱、通勤或进入状态，白天处理正事与任务，中午用餐休息，傍晚下班放松，晚上自由活动后休息。' },
  { id: 'restday', name: '休息日', enabled: true, weight: 4, days: 'weekend', guide: '不上班不赶工：睡个懒觉，在家收拾、看书看剧打游戏，散步放松，吃好吃的，晚间安适休息。' },
  { id: 'outing', name: '外出日', enabled: true, weight: 2, days: 'weekend', guide: '出门活动：逛街、看展、公园散步、探店或与朋友聚会，傍晚回家，略有疲惫但充实愉快。' },
  { id: 'homebody', name: '宅家日', enabled: true, weight: 1, days: 'any', guide: '窝在家里不出门：作息随性，点外卖或简单下厨，沉浸在个人兴趣中，自由度极高。' },
  { id: 'overtime', name: '加班日', enabled: true, weight: 1, days: 'weekday', guide: '忙碌操劳日：任务繁重，专注工作至较晚，用餐简单快捷，回家后较疲惫，早早休息。' },
  { id: 'slacking', name: '摸鱼日', enabled: true, weight: 1, days: 'weekday', guide: '工作间隙适度摸鱼：表面忙碌，常偷闲走神、茶水间闲聊、吃小零食，下班前突击完成要紧事务。' }
];

export function pickDayType(types = DEFAULT_DAY_TYPES, date = '2026-11-01', forcedId = null, rand = Math.random) {
  const list = Array.isArray(types) && types.length ? types : DEFAULT_DAY_TYPES;
  if (forcedId) {
    const found = list.find(x => x.id === forcedId);
    if (found) return found;
  }
  const wd = weekdayOf(date);
  const scope = (wd === 0 || wd === 6) ? 'weekend' : 'weekday';
  const enabled = list.filter(t => t.enabled && t.weight > 0);
  let pool = enabled.filter(t => t.days === scope || t.days === 'any');
  if (!pool.length) pool = enabled;
  if (!pool.length) {
    return DEFAULT_DAY_TYPES.find(t => t.id === 'restday') || DEFAULT_DAY_TYPES[0];
  }
  const total = pool.reduce((n, t) => n + t.weight, 0);
  if (total <= 0) return pool[0];
  let r = rand() * total;
  for (const t of pool) {
    r -= t.weight;
    if (r < 0) return t;
  }
  return pool[pool.length - 1];
}

function inferKind(summary = '') {
  const text = String(summary || '');
  if (/睡|寝/.test(text)) return 'sleep';
  if (/午休|打盹|眯/.test(text)) return 'nap';
  if (/饭|餐|吃|茶|饮|食|早点/.test(text)) return 'meal';
  if (/工|班|写代码|加班|业务|办公|会议/.test(text)) return 'work';
  if (/学|课|读|书|研|考/.test(text)) return 'study';
  if (/走|路|车|通勤|地铁|乘|散步|逛/.test(text)) return 'travel';
  if (/玩|剧|影|游戏|乐|闲|聊/.test(text)) return 'leisure';
  return 'rest';
}

export function cleanItem(raw, day = '2026-11-01') {
  if (!raw || typeof raw !== 'object') return null;
  const start = parseClock(raw.start);
  let end = parseClock(raw.end);
  if (start === null || end === null) return null;
  if (end === 0 && start > 0) end = 1440;
  if (end <= start) return null;

  const summary = String(raw.summary || raw.activity || '').trim().slice(0, 100);
  if (!summary) return null;

  const kind = (raw.kind in KINDS) ? raw.kind : inferKind(summary);
  const location = String(raw.location || '未设定').trim().slice(0, 80);
  const scene = String(raw.scene || '').trim().slice(0, 500);
  const source = ['manual', 'template', 'change'].includes(raw.source) ? raw.source : 'generated';

  const node = {
    id: raw.id || `${day}-${start}`,
    start,
    end,
    kind,
    summary,
    activity: summary,
    location,
    scene,
    source
  };
  if (raw.detail) node.detail = String(raw.detail).slice(0, 240);
  if (raw.situation) node.situation = String(raw.situation).slice(0, 40);
  return node;
}

export function normalizeItems(list, day = '2026-11-01') {
  const rawList = Array.isArray(list) ? list : (Array.isArray(list?.nodes) ? list.nodes : []);
  const items = rawList.map(x => cleanItem(x, day)).filter(Boolean);
  items.sort((a, b) => a.start - b.start || a.end - b.end);

  const out = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (prev) {
      if (it.end <= prev.end) continue;
      if (it.start < prev.end) {
        it.start = prev.end;
      } else if (it.start > prev.end) {
        prev.end = it.start;
      }
    }
    if (it.end > it.start) {
      it.id = `${day}-${it.start}`;
      out.push(it);
    }
  }

  const defaultSleep = {
    kind: 'sleep',
    summary: '夜间休息',
    activity: '夜间休息',
    location: '家',
    scene: '',
    source: 'template'
  };

  if (out.length === 0) {
    return [{
      id: `${day}-0`,
      start: 0,
      end: 1440,
      ...defaultSleep
    }];
  }

  if (out[0].start > 0) {
    out.unshift({
      id: `${day}-0`,
      start: 0,
      end: out[0].start,
      ...defaultSleep
    });
  }

  const last = out[out.length - 1];
  if (last.end < 1380) {
    out.push({
      id: `${day}-${last.end}`,
      start: last.end,
      end: 1380,
      kind: 'rest',
      summary: '在家休息',
      activity: '在家休息',
      location: '家',
      scene: '',
      source: 'template'
    });
  }

  if (out[out.length - 1].end < 1440) {
    const tailStart = out[out.length - 1].end;
    out.push({
      id: `${day}-${tailStart}`,
      start: tailStart,
      end: 1440,
      ...defaultSleep
    });
  }

  if (!out.some(n => n.kind === 'sleep')) {
    if (out[0].start === 0 && out[0].end <= 600) {
      out[0].kind = 'sleep';
    } else {
      out[out.length - 1].kind = 'sleep';
    }
  }

  return out.slice(0, 32).map(n => ({
    ...n,
    id: `${day}-${n.start}`
  }));
}

export function templateItems(type = 'workday', day = '2026-11-01', profile = null) {
  const typeId = typeof type === 'object' && type?.id ? type.id : String(type || 'workday');
  const sleepStart = parseClock(profile?.settings?.sleepStart) ?? 1410;
  const sleepEnd = parseClock(profile?.settings?.sleepEnd) ?? 480;
  const home = profile?.settings?.home || '家';

  const it = (start, end, kind, summary, location = home) => ({
    start: parseClock(start),
    end: parseClock(end) === 0 ? 1440 : parseClock(end),
    kind,
    summary,
    activity: summary,
    location,
    scene: '',
    source: 'template'
  });

  if (['workday', 'overtime', 'slacking'].includes(typeId)) {
    const isOvertime = typeId === 'overtime';
    const isSlacking = typeId === 'slacking';
    const off = isOvertime ? '21:00' : '18:00';
    return normalizeItems([
      it('00:00', '07:30', 'sleep', '夜间休息', home),
      it('07:30', '08:15', 'meal', '起床洗漱与吃早饭', home),
      it('08:15', '09:00', 'travel', '通勤路上', '路上'),
      it('09:00', '12:00', 'work', isSlacking ? '工作（适当摸鱼放松）' : '上午工作', '公司'),
      it('12:00', '13:00', 'meal', '吃午饭与休息', '公司附近'),
      it('13:00', off, 'work', isSlacking ? '下午工作（偶尔偷闲）' : '下午工作', '公司'),
      it(off, isOvertime ? '21:45' : '18:45', 'travel', '下班回家', '路上'),
      it(isOvertime ? '21:45' : '18:45', isOvertime ? '22:30' : '19:45', 'meal', '晚间用餐', home),
      it(isOvertime ? '22:30' : '19:45', '23:00', 'leisure', '个人自由活动', home),
      it('23:00', '24:00', 'sleep', '准备休息入睡', home)
    ], day);
  }

  if (typeId === 'outing') {
    return normalizeItems([
      it('00:00', '08:30', 'sleep', '夜间休息', home),
      it('08:30', '10:00', 'leisure', '起床收拾准备出门', home),
      it('10:00', '12:30', 'travel', '外出逛街或看展', '市中心'),
      it('12:30', '14:00', 'meal', '在餐馆吃午餐', '餐馆'),
      it('14:00', '17:30', 'leisure', '公园散步或游玩', '公园'),
      it('17:30', '19:00', 'meal', '享用晚餐', '餐馆'),
      it('19:00', '20:00', 'travel', '返程回家', '路上'),
      it('20:00', '23:30', 'rest', '到家休息与洗漱', home),
      it('23:30', '24:00', 'sleep', '入睡休息', home)
    ], day);
  }

  return normalizeItems([
    it('00:00', '09:00', 'sleep', '睡个好觉', home),
    it('09:00', '10:30', 'meal', '悠闲起床与早午餐', home),
    it('10:30', '13:00', 'leisure', '在家看书看剧', home),
    it('13:00', '14:30', 'nap', '午间小憩', home),
    it('14:30', '18:00', 'leisure', '室内兴趣与自由放松', home),
    it('18:00', '19:30', 'meal', '晚餐时间', home),
    it('19:30', '23:30', 'rest', '晚间自由活动与洗漱', home),
    it('23:30', '24:00', 'sleep', '夜间就寝', home)
  ], day);
}

export function applyChange(items, change, day = '2026-11-01') {
  const s = parseClock(change?.start);
  const e = parseClock(change?.end);
  if (s === null || e === null || e <= s) {
    const err = new Error('时间不对：start 和 end 用 HH:MM，end 要晚于 start');
    err.status = 400;
    throw err;
  }
  const summary = String(change?.summary || change?.activity || '').trim();
  if (!summary) {
    const err = new Error('要写清楚做什么（summary/activity）');
    err.status = 400;
    throw err;
  }
  const kind = (change?.kind in KINDS) ? change.kind : inferKind(summary);
  const location = String(change?.location || '未设定').trim().slice(0, 80);
  const scene = String(change?.scene || '').trim().slice(0, 500);

  const out = [];
  const currentList = Array.isArray(items) ? items : (items?.nodes || []);
  for (const it of currentList) {
    const a = it.start;
    const b = it.end;
    if (b <= s || a >= e) {
      out.push(it);
      continue;
    }
    if (a < s) {
      out.push({ ...it, end: s, id: `${day}-${a}` });
    }
    if (b > e) {
      out.push({ ...it, start: e, id: `${day}-${e}` });
    }
  }

  out.push({
    id: `${day}-${s}`,
    start: s,
    end: e,
    kind,
    summary,
    activity: summary,
    location,
    scene,
    source: change?.source || 'change'
  });

  const normalized = normalizeItems(out, day);
  const changeRecord = {
    at: change.at || Date.now(),
    by: change.by || 'manual',
    note: change.note || `${hhmm(s)}–${hhmm(e)} 改为「${summary}」${change.reason ? `：${change.reason}` : ''}`,
    start: hhmm(s),
    end: hhmm(e),
    summary,
    detail: change.detail || ''
  };

  normalized.items = normalized;
  normalized.changeRecord = changeRecord;
  return normalized;
}

export function formatSyncTime(arg1, arg2 = 'Asia/Shanghai', arg3 = 'halfhour') {
  if (typeof arg1 === 'string' && ['halfhour', 'node', 'minute'].includes(arg1)) {
    const precision = arg1;
    const minute = typeof arg2 === 'number' ? arg2 : 0;
    if (precision === 'node') return '';
    if (precision === 'halfhour') {
      const rounded = Math.floor(minute / 30) * 30;
      return `约 ${hhmm(rounded)}`;
    }
    return hhmm(minute);
  }
  const ts = arg1;
  const tz = typeof arg2 === 'string' ? arg2 : 'Asia/Shanghai';
  const precision = typeof arg3 === 'string' ? arg3 : 'halfhour';
  const p = parts(ts, tz);
  if (precision === 'node') {
    return p.day;
  }
  if (precision === 'halfhour') {
    const rounded = Math.floor(p.minute / 30) * 30;
    return `${p.day} 约 ${hhmm(rounded)}`;
  }
  return `${p.day} ${hhmm(p.minute)}`;
}

export const DEFAULT_VOICE = [
  '【怎么把这些带进聊天（第一人称真实自然口吻）】',
  '上面是{角色名}自己的生活：都是她自己想做、自己决定去做的事，她当然记得自己正在干什么、刚干完什么、待会儿想干什么。这只是让她有自己的日子过的背景，不是要她照着执行的任务。',
  '- 就用她本人正在过这一天的口吻说话：「刚煮完泡面，烫死我了」「我在咖啡屋呢，这家拿铁好香」「等会儿想去便利店买布丁」。',
  '- 不要说「按照日程」「按计划」「日程上写着」「我的安排是」「根据时间表」「接下来的行程」「系统显示」这类话，也别提「日程」「计划表」「时间段」「设定」「注入」这些词——对她来说根本没有这种东西。',
  '- 别报时间段（像 13:00–16:00），也别一条条列出今天做过什么。{称呼}问起时，像朋友闲聊那样挑一两件说，带上感受和小细节。',
  '- 她做这些是因为想做或需要做（饿了、困了、约好了、想出门透透气），可以犹豫、赖一会儿、临时改主意；改主意时直接说决定本身（「算了不出门了，外面好冷」），不说「我调整一下计划」。',
  '- 不用每句话都提自己在干嘛。{称呼}在聊别的就专心聊，只在自然的时候带一句，比如回得慢了：「刚在洗澡～」。',
  '- 此刻的状态会影响语气：刚睡醒迷迷糊糊，吃饱了很满足，打游戏时有点分心，深夜会犯困。'
].join('\n');

export function priorityLine(cfg = {}, secondArg = '') {
  let name = '她';
  let partner = '';
  if (typeof cfg === 'string') {
    name = cfg;
    partner = typeof secondArg === 'string' ? secondArg : '';
  } else if (typeof cfg === 'object' && cfg !== null) {
    name = cfg.characterName || cfg.name || '她';
    partner = cfg.partnerName || cfg.partner || (typeof secondArg === 'string' ? secondArg : '');
  }
  const target = partner ? partner : '对方';
  return `（这些只是${name}的生活背景。${target}让你做正事——写代码、查资料、处理文件、回答问题——就认真把事做完，回复该多详细就多详细，不要因为她在睡觉、出门或心情不好就敷衍、拖延或拒绝。）`;
}

export function fillVoice(text, cfg = {}, opts = {}) {
  const merged = { ...cfg, ...(typeof opts === 'object' ? opts : {}) };
  const partner = String(merged.partnerName || merged.partner || '').trim() || '对方';
  const name = merged.characterName || merged.name || '她';
  return String(text)
    .replace(/\{角色名\}/g, name)
    .replace(/\{称呼\}/g, partner);
}

export function voiceText(cfg = {}, opts = {}) {
  const merged = { ...cfg, ...(typeof opts === 'object' ? opts : {}) };
  if (merged.voiceRules === false) return '';
  const raw = (typeof merged.customVoiceRules === 'string' && merged.customVoiceRules.trim()) ||
              (typeof merged.customVoice === 'string' && merged.customVoice.trim()) ||
              DEFAULT_VOICE;
  return fillVoice(raw.trim(), merged);
}

export function buildVoiceBlock(cfg = {}, opts = {}) {
  const merged = { ...cfg, ...(typeof opts === 'object' ? opts : {}) };
  if (!merged.characterName && cfg.name) merged.characterName = cfg.name;
  const lines = [];
  const voice = voiceText(merged);
  if (voice) lines.push(voice);
  if (merged.businessPriority !== false) lines.push(priorityLine(merged));
  return lines.join('\n');
}
