import { installLaylaMock } from '@layla-network/sdk';
import { SQL } from './store.js';
import { createProfile, documentId, epoch, parts, templatePlan } from './core.js';

const KEY = 'layla-life-demo-v1';
const DEMO_ID = 'life-demo-mio';
export function demoCharacter() {
  return { id: DEMO_ID, data: { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '澪', description: '这是中文生活看板的示例角色。喜欢读书、散步与记录生活。', personality: '平和、细心，有一点好奇心。', scenario: '普通的日常生活。', first_mes: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '演示数据', character_version: '1.0', extensions: {} } } };
}
export function demoPlan(day) {
  const p = createProfile(demoCharacter()); p.settings.home = '家里';
  const nodes = templatePlan(day, p);
  for (const n of nodes) {
    n.source = 'generated';
    if (n.start >= 780 && n.end <= 1080) { n.kind = 'study'; n.summary = '读书与整理随手笔记'; n.location = '窗边书桌'; n.scene = '翻到昨天折角的那一页，把想到的一句话写进本子里。偶尔停下来，望一眼窗外。'; }
    if (n.start >= 1140 && n.kind === 'leisure') { n.summary = '听音乐，收拾今天的片段'; n.location = '房间'; n.scene = '把白天写下的零散句子放在一起，留一盏小灯，慢慢听完一张专辑。'; }
  }
  return nodes;
}
export function makeDemoData(now = Date.now()) {
  const role = demoCharacter(), day = parts(now).day, p = createProfile(role, now - 90 * 60000);
  p.settings.home = '家里'; p.settings.weatherCity = '示例城市'; p.settings.weatherNote = '多云 · 18°C（示例）'; p.settings.weatherAt = now - 25 * 60000;
  p.state.energy = 76; p.state.hunger = 32; p.state.mood = .38; p.state.arousal = .46;
  p.plans[day] = { nodes: demoPlan(day), source: 'generated', generatedAt: epoch(day, 480) };
  p.selectedSessionId = 'life-demo-session'; p.lastRunAt = now - 90 * 60000;
  const diaryId = documentId(DEMO_ID, 'diary', day);
  const dreamId = documentId(DEMO_ID, 'dream', day);
  const documents = [
    {
      id: diaryId,
      characterId: DEMO_ID,
      sessionId: 'life-demo-session',
      kind: 'diary',
      day,
      title: '把平常的一天收进本子',
      body: '今天早上8:44起床，简单收拾之后，安排并不算特别。读书的时候记下了几句喜欢的话，又把窗边的桌面收拾了一遍。\n\n比起把每一分钟都排满，我更想给刚冒出来的念头留一点空间。有些句子现在还不完整，先写下来也很好。\n\n这是看板演示用的生活日记，没有写入真实角色。',
      summary: '早上8:44起床，整理了读书笔记，想给未完成的想法留出空间。',
      createdAt: now - 3600000,
      syncStatus: 'written',
      memoryId: 11,
      nativeTimestamp: now - 2 * 3600000,
      graphStatus: 'ready',
      graphVerifiedJSON: JSON.stringify([
        { subject: '澪', relationship: '记录中作息', object: '早上8:44起床' },
        { subject: '澪', relationship: '记录中地点', object: '窗边书桌' },
        { subject: '澪', relationship: '记录中细节', object: '读书笔记' }
      ]),
      retrievalStatus: 'unverified',
      timelineFacts: {
        day,
        plannedSleepStart: '23:30',
        plannedWakeTime: '08:00',
        wakeTime: '08:44',
        wakePhrase: '早上8:44起床',
        wakeSource: 'diary',
        wakeSummary: '08:44（日记记录“早上8:44起床”；日常作息设定 23:30–08:00）'
      },
      sourceMessageIds: []
    },
    {
      id: dreamId,
      characterId: DEMO_ID,
      sessionId: 'life-demo-session',
      kind: 'dream',
      day,
      title: '梦里有一条缓慢的河',
      body: '梦里沿着一条河走了很久，灯光在水面上慢慢散开。桥的另一边有人在等车，却总也看不清脸。\n\n醒来只记得风很轻，像一句还没有说完的话。\n\n这是一段梦境示例，不是现实发生的经历。',
      summary: '示例梦境：河流、灯光与等车的人，醒后留下安静的余韵。',
      createdAt: now - 2 * 3600000,
      syncStatus: 'pending',
      memoryId: null,
      retrievalStatus: 'unverified',
      sourceMessageIds: []
    }
  ];
  const demoRuns = [
    { id: 'run-demo-1', characterId: DEMO_ID, at: now - 3 * 3600000, kind: 'plan', status: 'ok', message: '已生成今日日程（演示）' },
    { id: 'run-demo-2', characterId: DEMO_ID, at: now - 2 * 3600000, kind: 'scene', status: 'ok', message: '已细化生活场景：晨起与简单收拾（演示）' },
    { id: 'run-demo-3', characterId: DEMO_ID, at: now - 3600000, kind: 'refresh', status: 'ok', message: '生活状态已同步（演示）' }
  ];
  const morningScene = {
    id: 'scene-demo-morning',
    characterId: DEMO_ID,
    key: `${day}-480/awake/1`,
    nodeKey: `${day}-480`,
    nodeId: `${day}-480`,
    day,
    start: epoch(day, 480),
    end: epoch(day, 540),
    phase: 'awake',
    summary: '晨起与简单收拾',
    location: '家里',
    scene: '澪按自己的节奏起床洗漱，把被子叠整齐，拉开窗帘让晨光落进房间。清晨的空气还有些凉，她先去厨房热了一杯水。',
    source: 'generated',
    generatedAt: now - 4 * 3600000
  };
  return {
    profiles: { [DEMO_ID]: p },
    documents: Object.fromEntries(documents.map(d => [d.id, d])),
    runs: Object.fromEntries(demoRuns.map(r => [r.id, r])),
    locks: {},
    scenes: { [morningScene.id]: morningScene }
  };
}
export function createMockSQL(initial, storage = null) {
  let data = initial;
  data.scenes ||= {};
  const persist = () => storage?.setItem(KEY, JSON.stringify(data));
  function execute(query, args = []) {
    let rows = [], changed = 0;
    if ([SQL.profiles, SQL.docs, SQL.runs, SQL.locks, SQL.scenes, SQL.scenesByScope, SQL.scenesByCharacter].includes(query)) return { rows, rowsAffected: 0, insertId: 0 };
    if (query === SQL.getProfile) rows = data.profiles[args[0]] ? [{ data: JSON.stringify(data.profiles[args[0]]) }] : [];
    else if (query === SQL.listProfiles) rows = Object.values(data.profiles).map(p => ({ data: JSON.stringify(p) }));
    else if (query === SQL.putProfile) { data.profiles[args[0]] = JSON.parse(args[1]); changed = 1; }
    else if (query === SQL.getDoc) rows = data.documents[args[0]] ? [{ data: JSON.stringify(data.documents[args[0]]) }] : [];
    else if (query === SQL.listDocs) rows = Object.values(data.documents).filter(d => d.characterId === args[0]).sort((a, b) => b.createdAt - a.createdAt).map(d => ({ data: JSON.stringify(d) }));
    else if (query === SQL.putDoc) { data.documents[args[0]] = JSON.parse(args[5]); changed = 1; }
    else if (query === SQL.addRun) { data.runs[args[0]] = JSON.parse(args[3]); changed = 1; }
    else if (query === SQL.listRuns) rows = Object.values(data.runs).filter(r => r.characterId === args[0]).sort((a, b) => b.at - a.at).slice(0, 20).map(r => ({ data: JSON.stringify(r) }));
    else if (query === SQL.listAllRuns) rows = Object.values(data.runs).filter(r => r.characterId === args[0]).sort((a, b) => b.at - a.at).map(r => ({ data: JSON.stringify(r) }));
    else if (query === SQL.putScene) { data.scenes[args[0]] = JSON.parse(args[5]); changed = 1; }
    else if (query === SQL.getScene) rows = Object.values(data.scenes).reverse().filter(r => r.key === args[0] && r.generatedAt <= args[1]).sort((a, b) => b.generatedAt - a.generatedAt).slice(0, 1).map(r => ({ data: JSON.stringify(r) }));
    else if (query === SQL.listScenes) rows = Object.values(data.scenes).reverse().filter(r => r.characterId === args[0] && r.generatedAt <= args[1]).sort((a, b) => b.generatedAt - a.generatedAt).slice(0, args[2]).map(r => ({ data: JSON.stringify(r) }));
    else if (query === SQL.acquire) { if (!data.locks[args[0]]) { data.locks[args[0]] = { owner: args[1], expires: args[2] }; changed = 1; } }
    else if (query === SQL.takeover) { if (data.locks[args[2]]?.expires < args[3]) { data.locks[args[2]] = { owner: args[0], expires: args[1] }; changed = 1; } }
    else if (query === SQL.getLock) rows = data.locks[args[0]] ? [{ owner: data.locks[args[0]].owner }] : [];
    else if (query === SQL.release) { if (data.locks[args[0]]?.owner === args[1]) { delete data.locks[args[0]]; changed = 1; } }
    else throw new Error(`演示数据库不支持此查询：${query}`);
    if (changed) persist(); return { rows, rowsAffected: changed, insertId: 0 };
  }
  return { execute, get data() { return data; } };
}
export function installDemo() {
  const now = Date.now(); let initial;
  try { initial = JSON.parse(localStorage.getItem(KEY)); } catch { /* Empty demo. */ }
  if (!initial?.profiles || !initial?.documents) initial = makeDemoData(now);
  // Expired preview locks are never carried across a page reload.
  initial.locks = {};
  const sql = createMockSQL(initial, localStorage), role = demoCharacter();
  const day = parts(now).day;
  const diaryDocId = documentId(DEMO_ID, 'diary', day);
  const handle = installLaylaMock({
    debug: false, latencyMs: 20, tokenDelayMs: 3, characters: [role],
    executionContext: { app_version: '7.6.2', character: null, session_id: null },
    persona: { name: '示例用户', description: '仅用于界面演示。' },
    chatHistory: [
      { id: 1, role: 'user', character_id: DEMO_ID, session_id: 'life-demo-session', content: '今天有没有想做的事？', timestamp: now - 2 * 3600000 },
      { id: 2, role: 'assistant', character_id: DEMO_ID, session_id: 'life-demo-session', content: '想把前几天读书时留下的笔记整理一下。', timestamp: now - 2 * 3600000 + 10000 }
    ],
    memories: [
      { id: 10, character_id: DEMO_ID, session_id: 'life-demo-session', timestamp: now - 86400000, rawText: '澪想整理读书笔记。', summary: '角色示例：整理阅读笔记。', knowledgeGraphJSON: null },
      {
        id: 11,
        character_id: DEMO_ID,
        session_id: 'life-demo-session',
        timestamp: now - 2 * 3600000,
        rawText: `【Layla生活记录:${diaryDocId}】\n类型：日记；日期：${day}。角色当日第一人称生活与作息记录；涉及与用户的互动以实际聊天为准。\n标题：把平常的一天收进本子\n今天早上8:44起床，简单收拾之后，安排并不算特别。读书的时候记下了几句喜欢的话，又把窗边的桌面收拾了一遍。\n\n比起把每一分钟都排满，我更想给刚冒出来的念头留一点空间。有些句子现在还不完整，先写下来也很好。\n\n这是看板演示用的生活日记，没有写入真实角色。`,
        summary: `日记（${day}）《把平常的一天收进本子》：早上8:44起床，整理了读书笔记，想给未完成的想法留出空间。`,
        knowledgeGraphJSON: JSON.stringify([
          { subject: '澪', relationship: '记录中作息', object: '早上8:44起床' },
          { subject: '澪', relationship: '记录中地点', object: '窗边书桌' },
          { subject: '澪', relationship: '记录中细节', object: '读书笔记' }
        ])
      }
    ],
    executeSql: (query, params) => sql.execute(query, params || []),
    respond: messages => {
      const system = String(messages.find(m => m.role === 'system')?.content || '');
      const day = parts(Date.now()).day;
      if (system.includes('TASK:MEMORY_GRAPH')) {
        const c = JSON.parse(messages.find(m => m.role === 'user').content);
        const detail = c.rawText.includes('窗边') ? '窗边' : c.rawText.includes('河') ? '河' : c.rawText.slice(-12);
        return JSON.stringify([{ subject: c.recordNode, relationship: c.allowedRelationships.find(r => r.endsWith('细节')), object: detail }]);
      }
      if (system.includes('TASK:PLAN')) return JSON.stringify({ nodes: demoPlan(day).map(n => ({ ...n, start: `${String(Math.floor(n.start / 60)).padStart(2, '0')}:${String(n.start % 60).padStart(2, '0')}`, end: n.end === 1440 ? '24:00' : `${String(Math.floor(n.end / 60)).padStart(2, '0')}:${String(n.end % 60).padStart(2, '0')}` })) });
      if (system.includes('TASK:SCENE')) {
        const context = JSON.parse(messages.find(m => m.role === 'user').content), phase = context.state.sleepPhase;
        const scene = phase === 'deep_sleep' ? '澪仍沉在安稳的睡眠里，呼吸缓慢而均匀，手指松松地搭在被子边缘。房间里没有什么动静，她偶尔轻轻翻个身，把被角拉近一点，又重新安静下来。枕边留着合上的书，书签停在昨晚读到的那一页，尚未醒来的她并没有去碰它。眼下的生活像是暂时放轻了脚步，只剩下细小的呼吸声和被褥轻微的起伏。' : ['falling_asleep', 'light_sleep'].includes(phase) ? '澪已经躺好，把被子往肩边拢了拢，手边的书安静地合着。她的呼吸渐渐放缓，身体也一点点松弛下来，只偶尔因为细小的动静调整一下姿势。那些还没整理完的笔记先留在原处，不急着为它们找一个结尾。房间里的物件都保持着熟悉的位置，她在这份熟悉里慢慢休息。' : phase === 'woken' ? '短暂清醒的澪还带着些睡意，刚才回复过后，并没有马上离开休息的地方。她轻轻调整了一下姿势，让被子继续搭在身上，动作比平时慢一些。枕边的书仍旧合着，她没有接着读，只让视线停留了一小会儿。待这阵细微的动静过去，房间又重新安静下来，接下来的事可以等精神清楚一点再说。' : context.currentNode.kind === 'study' ? '澪坐在书桌前，翻到上次夹着书签的那一页，指尖沿着页边慢慢划过。读到有意思的地方，她会停下来，在随手本上记几个字，再把笔轻轻搁回去。桌面还留着几张尚未整理的纸，她先将它们叠在一旁，给正在读的书腾出一点位置。偶尔想起前面没看明白的句子，她又往回翻一页，让刚刚冒出来的想法慢慢接上。' : context.currentNode.kind === 'meal' ? '澪在用餐的地方坐下来，把手边的餐具稍稍摆正，动作不紧不慢。她先专心吃了几口，让注意力从刚才的事情里退出来，再稍微调整一下坐姿。那些还没完成的安排暂时留在一边，这一小段时间只用来好好吃饭。等呼吸和节奏都慢下来，她才又看一眼身旁收好的东西，没有急着开始下一件事。' : `澪按自己的节奏继续${context.currentNode.summary}，先把手边零散的物件放回顺手的位置。她停下来想了一会儿，又接着做眼前的小事，动作里带着熟悉的从容。偶尔有一个没来得及记下的念头冒出来，她便在心里留个位置，准备稍后再慢慢整理。这段日常没有特别的波折，只是在细小的停顿和继续之间，一点点留下属于今天的痕迹。`;
        return JSON.stringify({ scene });
      }
      const kind = system.includes('TASK:WORK') ? '创作' : system.includes('TASK:REFLECTION') ? '反思' : system.includes('TASK:DREAM') ? '梦境' : '日记';
      return JSON.stringify({ title: kind === '创作' ? '窗边的一盏灯' : `${kind}里的小小停顿`, body: `这是一段${kind}演示。\n\n把今天留下的句子整理在一起，发现有些想法需要慢一点才看得清楚。窗边的书仍翻在那一页，晚些时候还想继续读下去。\n\n演示内容由本地固定样例生成，没有调用真实模型，也没有改动真实角色。`, summary: `${kind}示例：整理日常片段，留住未完成的阅读与思考。` });
    }
  });
  return { handle, sql };
}
