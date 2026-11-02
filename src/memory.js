import { VERSION, marker, memoryPayload, uid } from './core.js';
import { ask } from './model.js';
import { GRAPH_RULES, buildGraph, graphContext, hasGraph, isEmptyGraph, memoryBasis, nativePayload, sameGraph } from './memory-graph.js';

function stopped(signal) { if (signal?.aborted) throw new Error('已停止记忆处理'); }
const validId = id => Number.isSafeInteger(id) && id > 0;
function owns(m, d) { return m?.character_id === d.characterId && validId(m.id) && String(m.rawText || '').startsWith(marker(d.id)); }

// No global ingest watermark: each local document is matched to its own native row.
export async function findWrittenMemory(client, d, { signal } = {}) {
  const at = d.nativeTimestamp ?? d.createdAt;
  const options = { minTimestamp: at - 60000, maxTimestamp: at + 60000, ...(signal ? { signal } : {}) };
  const matches = [];
  for (let offset = 0; offset < 1000; offset += 50) {
    stopped(signal);
    const page = await client.memories.list(d.characterId, offset, 50, options);
    if (!Array.isArray(page)) throw new Error('记忆核对返回了无效数据');
    for (const m of page) if (owns(m, d)) {
      if (validId(d.memoryId)) { if (m.id === d.memoryId) return m; }
      else matches.push(m);
    }
    if (page.length < 50) {
      if (matches.length > 1) throw new Error('发现同一记录的多个原生记忆，请先在 Layla 中核对，未自动选择或新增');
      return matches[0] || null;
    }
  }
  throw new Error('同一时间窗的记忆过多，未完成核对，本次未写入');
}
async function log(store, d, status, message) {
  await store.addRun({ id: uid('run'), characterId: d.characterId, at: Date.now(), kind: 'memory', status, message });
}
function invalidateCheck(d) {
  if (d.retrievalStatus !== 'unverified') { d.retrievalStatus = 'unverified'; d.retrievalCheckedAt = null; d.retrievalCheck = null; }
}
function acceptGraph(d, native) {
  if (d.graphVerifiedJSON !== native.knowledgeGraphJSON || d.graphBasis !== memoryBasis(native)) invalidateCheck(d);
  d.graphStatus = 'ready'; d.graphError = ''; d.graphVerifiedJSON = native.knowledgeGraphJSON;
  d.graphVerifiedAt = Date.now(); d.graphBasis = memoryBasis(native); d.nativeTimestamp = native.timestamp;
  return d;
}

async function enrichLocked(client, store, d, opts) {
  let updating = false;
  try {
    stopped(opts.signal);
    if (d.syncStatus !== 'written' || !validId(d.memoryId)) throw new Error('请先核对文本写入，取得原生记忆编号后再补全');
    let native = await findWrittenMemory(client, d, opts);
    if (!native) throw new Error('找不到原记忆；可能已删除或日期改变，未创建替代条目');
    if (hasGraph(native.knowledgeGraphJSON)) {
      acceptGraph(d, native); await store.putDoc(d);
      await log(store, d, 'ok', `记忆 #${d.memoryId} 的原生图谱已核对；自然召回需另行验收`);
      return d;
    }
    if (!isEmptyGraph(native.knowledgeGraphJSON)) throw new Error('原记忆已有无法识别的图谱，未覆盖；请先在 Layla 中检查');
    if (opts.reconcileOnly) {
      d.graphStatus = d.graphDraftJSON ? 'draft' : 'missing'; d.graphError = '当前原生记录尚无可核对的图谱，可手动补全';
      await store.putDoc(d); return d;
    }
    const basis = memoryBasis(native), originalGraph = native.knowledgeGraphJSON;
    const profile = await store.getProfile(d.characterId);
    const context = graphContext(d, native, profile?.name || d.characterId);
    if (!d.graphDraftJSON || d.graphDraftBasis !== basis) {
      d.graphStatus = 'generating'; d.graphError = ''; await store.putDoc(d);
      const text = await ask(client, [{ role: 'system', content: GRAPH_RULES }, { role: 'user', content: JSON.stringify(context) }], opts);
      stopped(opts.signal);
      d.graphDraftJSON = buildGraph(text, context, d); d.graphDraftBasis = basis;
      d.graphGeneratedAt = Date.now(); d.graphStatus = 'draft'; await store.putDoc(d);
    }
    // Re-read after model generation: do not overwrite changes made in native UI.
    const latest = await findWrittenMemory(client, d, opts);
    if (!latest || memoryBasis(latest) !== basis) throw new Error('处理期间原生记忆已变化，未覆盖；请重新核对后重试');
    if (hasGraph(latest.knowledgeGraphJSON)) {
      acceptGraph(d, latest); await store.putDoc(d); return d;
    }
    if (latest.knowledgeGraphJSON !== originalGraph) throw new Error('处理期间原生图谱已变化，未覆盖；请重新核对');
    stopped(opts.signal);
    d.graphStatus = 'writing'; invalidateCheck(d); await store.putDoc(d); updating = true;
    const rows = await client.memories.createOrUpdate([nativePayload(latest, d.graphDraftJSON)], opts.signal ? { signal: opts.signal } : {});
    const receipt = rows?.find(m => m.id === d.memoryId && owns(m, d));
    if (!receipt || memoryBasis(receipt) !== basis || !sameGraph(receipt.knowledgeGraphJSON, d.graphDraftJSON)) throw new Error('图谱写入回执不完整，保留草稿待核对');
    native = await findWrittenMemory(client, d, opts);
    if (!native || memoryBasis(native) !== basis || !sameGraph(native.knowledgeGraphJSON, d.graphDraftJSON)) throw new Error('图谱回读未确认，保留草稿待核对');
    acceptGraph(d, native); d.memoryPipelineVersion = VERSION;
    await store.putDoc(d); await log(store, d, 'ok', `已补全并回读记忆 #${d.memoryId} 的图谱；原文、时间与会话保持原值，召回未自动验收`);
  } catch (e) {
    d.graphStatus = updating ? 'uncertain' : 'error'; d.graphError = String(e.message || e).slice(0, 500);
    await store.putDoc(d); await log(store, d, 'error', `文本记忆保留；图谱未完成：${d.graphError}`);
  }
  return d;
}

async function prepareGraphDraft(client, store, d, payload, characterName, opts) {
  let graphJSON = null, graphError = '';
  try {
    const context = graphContext(d, payload, characterName);
    d.graphStatus = 'generating'; d.graphError = ''; await store.putDoc(d);
    const text = await ask(client, [{ role: 'system', content: GRAPH_RULES }, { role: 'user', content: JSON.stringify(context) }], opts);
    stopped(opts.signal);
    graphJSON = buildGraph(text, context, d);
    d.graphDraftJSON = graphJSON; d.graphGeneratedAt = Date.now(); d.graphStatus = 'draft';
    await store.putDoc(d);
  } catch (e) {
    stopped(opts.signal);
    graphError = String(e.message || e).slice(0, 500);
  }
  return { graphJSON, graphError };
}

export async function enrichMemory(client, store, id, opts = {}) {
  const initial = await store.getDoc(id); if (!initial) throw new Error('记录不存在');
  return store.lock(initial.characterId, async () => enrichLocked(client, store, await store.getDoc(id), opts));
}
export async function writeMemory(client, store, id, opts = {}) {
  const initial = await store.getDoc(id); if (!initial) throw new Error('记录不存在');
  return store.lock(initial.characterId, async () => {
    const d = await store.getDoc(id); stopped(opts.signal);
    if (d.syncStatus === 'written') return opts.reconcileOnly ? d : enrichLocked(client, store, d, opts);
    const profile = await store.getProfile(d.characterId);
    const sessionMode = opts.memorySessionMode || profile?.settings?.memorySessionMode || 'isolated';
    const characterName = profile?.name || d.characterId;
    if (sessionMode === 'active' && !d.sessionId) {
      if (!profile?.selectedSessionId) throw new Error('这个角色还没有原生会话。先进行一次原生聊天，再更新生活状态并重试');
      d.sessionId = profile.selectedSessionId; await store.putDoc(d);
    } else if (!d.sessionId && profile?.selectedSessionId) {
      d.sessionId = profile.selectedSessionId; await store.putDoc(d);
    }
    if (d.syncStatus === 'stale' && validId(d.memoryId)) {
      const existing = await findWrittenMemory(client, d, opts);
      if (!existing) throw new Error('找不到原记忆；可能已删除或日期改变，未创建替代条目');
      if (opts.reconcileOnly) return d;
      const payload = memoryPayload(d, { id: existing.id, timestamp: existing.timestamp, sessionId: existing.session_id });
      const { graphJSON, graphError } = await prepareGraphDraft(client, store, d, payload, characterName, opts);
      stopped(opts.signal); invalidateCheck(d);
      try {
        const rows = await client.memories.createOrUpdate([{ ...payload, knowledgeGraphJSON: graphJSON }], opts.signal ? { signal: opts.signal } : {});
        const receipt = rows?.find(m => m.id === existing.id && owns(m, d));
        if (!receipt) throw new Error('宿主未返回原记忆的更新回执');
      } catch (e) {
        d.syncStatus = 'uncertain'; d.syncError = String(e.message || e); await store.putDoc(d); throw e;
      }
      const updated = await findWrittenMemory(client, d, opts);
      if (!updated) throw new Error('更新后未能回读原记忆，请稍后核对');
      d.nativeTimestamp = updated.timestamp; d.syncedAt = Date.now(); d.syncStatus = 'written'; d.syncError = ''; d.memoryPipelineVersion = VERSION;
      if (graphJSON) d.graphDraftBasis = memoryBasis(updated);
      if (graphJSON && sameGraph(updated.knowledgeGraphJSON, graphJSON)) {
        acceptGraph(d, updated); await store.putDoc(d);
        await log(store, d, 'ok', `已原位更新原生记忆 #${d.memoryId} 的文本与图谱；自然召回需另行验收`);
        return d;
      }
      if (graphError) {
        d.graphStatus = 'error'; d.graphError = graphError; await store.putDoc(d);
        await log(store, d, 'error', `已原位更新记忆 #${d.memoryId} 文本；图谱未完成：${graphError}`);
        return d;
      }
      await store.putDoc(d);
      return enrichLocked(client, store, d, opts);
    }
    let native = await findWrittenMemory(client, d, opts);
    let preGraphJSON = null, preGraphError = '';
    if (!native) {
      if (opts.reconcileOnly || validId(d.memoryId) || ['sending', 'uncertain'].includes(d.syncStatus)) throw new Error('暂未找到写入回执，已保留待核对状态；请检查原生记忆，避免重复新增');
      const basePayload = memoryPayload(d, { memorySessionMode: sessionMode });
      ({ graphJSON: preGraphJSON, graphError: preGraphError } = await prepareGraphDraft(client, store, d, basePayload, characterName, opts));
      stopped(opts.signal); d.syncStatus = 'sending'; await store.putDoc(d);
      try {
        const rows = await client.memories.createOrUpdate([{ ...basePayload, knowledgeGraphJSON: preGraphJSON }], opts.signal ? { signal: opts.signal } : {});
        native = rows?.find(m => owns(m, d));
        if (!native) throw new Error('宿主未返回可核对的记忆回执');
      } catch (e) {
        d.syncStatus = 'uncertain'; d.syncError = String(e.message || e); await store.putDoc(d); throw e;
      }
    }
    d.memoryId = native.id; d.nativeTimestamp = native.timestamp; d.syncedAt = Date.now(); d.syncStatus = 'written'; d.syncError = '';
    d.memoryPipelineVersion = VERSION;
    if (preGraphJSON) d.graphDraftBasis = memoryBasis(native);
    await store.putDoc(d);
    if (opts.reconcileOnly) {
      if (hasGraph(native.knowledgeGraphJSON)) acceptGraph(d, native);
      else d.graphStatus = 'missing';
      await store.putDoc(d); return d;
    }
    if (preGraphJSON) {
      const readback = await findWrittenMemory(client, d, opts);
      if (readback && sameGraph(readback.knowledgeGraphJSON, preGraphJSON)) {
        acceptGraph(d, readback); await store.putDoc(d);
        await log(store, d, 'ok', `已原子保存并回读原生记忆 #${d.memoryId}（文本与图谱同步写入）；自然召回需另行验收`);
        return d;
      }
    }
    if (preGraphError) {
      d.graphStatus = 'error'; d.graphError = preGraphError; await store.putDoc(d);
      await log(store, d, 'error', `文本已保存为原生记忆 #${d.memoryId}；图谱未完成：${preGraphError}`);
      return d;
    }
    await log(store, d, 'ok', `文本已保存为原生记忆 #${d.memoryId}，准备补全图谱`);
    return enrichLocked(client, store, d, opts);
  });
}

// This is the user's test report, never inferred from model output or top-memory rank.
export async function recordRetrievalCheck(store, id, { result, cleanSession = false, note = '' } = {}) {
  if (!['unverified', 'passed', 'failed'].includes(result)) throw new Error('请选择有效的验收结果');
  if (result === 'passed' && !cleanSession) throw new Error('通过验收需确认：在未贴原文的新会话中测试');
  const initial = await store.getDoc(id); if (!initial) throw new Error('记录不存在');
  return store.lock(initial.characterId, async () => {
    const d = await store.getDoc(id);
    if (d.syncStatus !== 'written') throw new Error('文本尚未确认写入，不能记录召回验收');
    d.retrievalStatus = result; d.retrievalCheckedAt = Date.now();
    d.retrievalCheck = { result, cleanSession: !!cleanSession, note: String(note).trim().slice(0, 1000), source: 'user-report', at: d.retrievalCheckedAt };
    d.retrievalChecks = [...(d.retrievalChecks || []), d.retrievalCheck].slice(-10);
    await store.putDoc(d); return d;
  });
}
