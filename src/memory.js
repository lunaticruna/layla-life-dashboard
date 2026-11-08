import { VERSION, confirmedWakeTime, hasUnconfirmedWakeTime, hash, marker, memoryPayload, uid } from './core.js';
import { ask } from './model.js';
import { GRAPH_RULES, buildGraph, graphContext, hasGraph, isEmptyGraph, isStaleNativeGraph, memoryBasis, nativePayload, sameGraph } from './memory-graph.js';

export function syncDocumentWakeFacts(d, profile, now = Date.now()) {
  const wake = profile ? confirmedWakeTime(profile, d.day, now) : '';
  d.timelineFacts ||= {};
  d.timelineFacts.wakeTime = wake;
  d.timelineFacts.wakePhrase = wake ? `${wake}起床` : '';
  d.timelineFacts.wakeSource = wake ? 'manual' : (d.timelineFacts.wakeSource === 'manual' ? (d.timelineFacts.firstAwakeTime ? 'scene' : 'schedule') : (d.timelineFacts.wakeSource || 'schedule'));
  return wake;
}

export function assertNoUnconfirmedWake(d, wakeTime) {
  if (['diary', 'reflection'].includes(d.kind)) {
    const scanText = [d.title, d.body, d.summary].filter(Boolean).join('\n');
    if (hasUnconfirmedWakeTime(scanText, wakeTime, { firstAwakeTime: d.timelineFacts?.firstAwakeTime })) {
      throw new Error('文稿包含未确认或冲突的起床时间，已严格拦截写入原生记忆；请核对起床时间后重新生成文稿');
    }
  }
}

function stopped(signal) { if (signal?.aborted) throw new Error('已停止记忆处理'); }
const validId = id => Number.isSafeInteger(id) && id > 0;
function owns(m, d) { return m?.character_id === d.characterId && validId(m.id) && String(m.rawText || '').startsWith(marker(d.id)); }

function payloadDigest(rawText, summary) {
  return hash(JSON.stringify([String(rawText ?? ''), String(summary ?? '')]));
}
function buildPendingWrite({ op, targetMemoryId = null, payload, graphJSON = null, existing = null, at = Date.now() }) {
  const rawText = String(payload?.rawText ?? '');
  const summary = String(payload?.summary ?? '');
  return {
    op,
    targetMemoryId: validId(targetMemoryId) ? targetMemoryId : null,
    rawText,
    summary,
    payloadHash: payloadDigest(rawText, summary),
    graphJSON: graphJSON ?? null,
    previousBasis: existing ? memoryBasis(existing) : null,
    previousGraphJSON: existing ? (existing.knowledgeGraphJSON ?? null) : null,
    attemptedAt: at
  };
}
function matchesPendingWrite(native, pending) {
  if (!native || !pending || typeof pending !== 'object') return false;
  if (validId(pending.targetMemoryId) && native.id !== pending.targetMemoryId) return false;
  const nativeRaw = String(native.rawText ?? '');
  const nativeSummary = String(native.summary ?? '');
  const hasText = typeof pending.rawText === 'string' && typeof pending.summary === 'string' && (pending.rawText !== '' || pending.summary !== '');
  const hasHash = typeof pending.payloadHash === 'string' && Boolean(pending.payloadHash);
  if (!hasText && !hasHash) return false;
  if (hasText && (nativeRaw !== pending.rawText || nativeSummary !== pending.summary)) return false;
  if (hasHash && payloadDigest(nativeRaw, nativeSummary) !== pending.payloadHash) return false;
  return true;
}
function matchesPreviousWrite(native, pending) {
  if (!native || !pending?.previousBasis || memoryBasis(native) !== pending.previousBasis) return false;
  const currentGraph = native.knowledgeGraphJSON ?? null;
  const previousGraph = pending.previousGraphJSON ?? null;
  return currentGraph === previousGraph || sameGraph(currentGraph, previousGraph);
}
function clip(text, max = 42) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function versionDiffText(native, expectedRawText, expectedSummary) {
  const idPart = validId(native?.id) ? ` #${native.id}` : '';
  const nativeSum = String(native?.summary ?? '');
  const expSum = String(expectedSummary ?? '');
  if (nativeSum !== expSum) {
    return `原生记忆${idPart}仍为旧版本或不同内容（原生摘要：“${clip(nativeSum)}” vs 待更新：“${clip(expSum)}”）`;
  }
  const nativeBody = String(native?.rawText ?? '').replace(/^【Layla生活记录:[^】]+】\s*/, '');
  const expBody = String(expectedRawText ?? '').replace(/^【Layla生活记录:[^】]+】\s*/, '');
  return `原生记忆${idPart}正文尚未更新到当前本地版本（原生：“${clip(nativeBody)}” vs 待更新：“${clip(expBody)}”）`;
}

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
    const basis = memoryBasis(native), originalGraph = native.knowledgeGraphJSON;
    const hasCurrentDraft = Boolean(d.graphDraftJSON && d.graphDraftBasis === basis);
    const matchesCurrentDraft = hasCurrentDraft && sameGraph(native.knowledgeGraphJSON, d.graphDraftJSON);
    const isFlaggedOldGraph = ['uncertain', 'error'].includes(d.graphStatus) && !d.graphVerifiedJSON && /旧版/.test(d.graphError || '');
    // Current readback evidence supersedes a previous failed graph check.
    const hasGraphConflict = !matchesCurrentDraft && (Boolean(d.graphDraftJSON) || (hasGraph(native.knowledgeGraphJSON) && (isStaleNativeGraph(native.knowledgeGraphJSON, d, native) || isFlaggedOldGraph)));
    if (hasGraph(native.knowledgeGraphJSON) && !hasGraphConflict) {
      acceptGraph(d, native); await store.putDoc(d);
      await log(store, d, 'ok', `记忆 #${d.memoryId} 的原生图谱已核对；自然召回需另行验收`);
      return d;
    }
    if (hasGraph(native.knowledgeGraphJSON) && hasGraphConflict) {
      invalidateCheck(d); d.graphVerifiedJSON = null; d.graphBasis = null;
      if (opts.reconcileOnly) {
        d.graphStatus = 'uncertain';
        d.graphError = '原生文本已更新为新版本，但原生图谱仍为旧版本或与当前版本不一致，请核对后重试';
        await store.putDoc(d); return d;
      }
      throw new Error('原记忆已有旧版本或与当前版本不一致的图谱，未自动覆盖；请先在 Layla 中检查');
    }
    if (!isEmptyGraph(native.knowledgeGraphJSON)) throw new Error('原记忆已有无法识别的图谱，未覆盖；请先在 Layla 中检查');
    if (opts.reconcileOnly) {
      d.graphStatus = d.graphDraftJSON ? 'draft' : 'missing'; d.graphError = '当前原生记录尚无可核对的图谱，可手动补全';
      await store.putDoc(d); return d;
    }
    const profile = await store.getProfile(d.characterId);
    const confirmedWake = syncDocumentWakeFacts(d, profile);
    assertNoUnconfirmedWake(d, confirmedWake);
    await store.putDoc(d);
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
      if (!sameGraph(latest.knowledgeGraphJSON, d.graphDraftJSON)) throw new Error('处理期间原生图谱已变化，且与当前草稿不一致，未覆盖；请先在 Layla 中核对');
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
  const basis = memoryBasis(payload);
  if (d.graphDraftJSON && d.graphDraftBasis === basis) {
    return { graphJSON: d.graphDraftJSON, graphError: '' };
  }
  let graphJSON = null, graphError = '';
  try {
    const context = graphContext(d, payload, characterName);
    d.graphStatus = 'generating'; d.graphError = ''; await store.putDoc(d);
    const text = await ask(client, [{ role: 'system', content: GRAPH_RULES }, { role: 'user', content: JSON.stringify(context) }], opts);
    stopped(opts.signal);
    graphJSON = buildGraph(text, context, d);
    d.graphDraftJSON = graphJSON; d.graphDraftBasis = basis; d.graphGeneratedAt = Date.now(); d.graphStatus = 'draft';
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

    if (!opts.reconcileOnly) {
      const profile = await store.getProfile(d.characterId);
      const confirmedWake = syncDocumentWakeFacts(d, profile);
      assertNoUnconfirmedWake(d, confirmedWake);
      await store.putDoc(d);
    }

    if (!validId(d.memoryId) && !d.pendingWrite) {
      const discovered = await findWrittenMemory(client, d, opts);
      if (discovered) {
        const discoveredExpected = memoryPayload(d, { id: discovered.id, timestamp: discovered.timestamp, sessionId: discovered.session_id });
        const matchesDiscovered = String(discovered.rawText ?? '') === discoveredExpected.rawText
          && String(discovered.summary ?? '') === discoveredExpected.summary;
        if (!matchesDiscovered) {
          d.memoryId = discovered.id; d.nativeTimestamp = discovered.timestamp;
          if (opts.reconcileOnly) {
            const diff = versionDiffText(discovered, discoveredExpected.rawText, discoveredExpected.summary);
            d.syncStatus = d.syncStatus === 'pending' ? 'stale' : 'uncertain';
            d.syncError = `${diff}；原生记忆尚未更新到当前本地版本，请核对后再更新`;
            d.graphVerifiedJSON = null; d.graphBasis = null;
            d.graphStatus = d.graphDraftJSON ? 'draft' : 'pending'; d.graphError = '';
            invalidateCheck(d);
            await store.putDoc(d);
            await log(store, d, 'error', d.syncError);
            return d;
          }
          if (d.syncStatus === 'pending') {
            d.syncStatus = 'stale'; d.syncError = '';
            await store.putDoc(d);
          }
        }
      }
    }

    const isUpdateIntent = d.pendingWrite?.op === 'update'
      || (d.syncStatus === 'stale' && validId(d.memoryId))
      || (!d.pendingWrite && ['sending', 'uncertain'].includes(d.syncStatus) && validId(d.memoryId));

    if (isUpdateIntent) {
      const pending = d.pendingWrite?.op === 'update' ? d.pendingWrite : null;
      if (!validId(d.memoryId) && validId(pending?.targetMemoryId)) d.memoryId = pending.targetMemoryId;
      const existing = await findWrittenMemory(client, d, opts);
      if (!existing) throw new Error('找不到原记忆；可能已删除或日期改变，未创建替代条目');

      const fallbackExpected = !pending ? memoryPayload(d, { id: existing.id, timestamp: existing.timestamp, sessionId: existing.session_id }) : null;
      const isNativeUpdated = pending
        ? matchesPendingWrite(existing, pending)
        : (['sending', 'uncertain'].includes(d.syncStatus)
          && String(existing.rawText ?? '') === fallbackExpected.rawText
          && String(existing.summary ?? '') === fallbackExpected.summary);

      if (isNativeUpdated) {
        const expectedGraph = pending?.graphJSON ?? d.graphDraftJSON ?? null;
        d.memoryId = existing.id; d.nativeTimestamp = existing.timestamp; d.syncedAt = Date.now();
        d.syncStatus = 'written'; d.syncError = ''; d.pendingWrite = null; d.memoryPipelineVersion = VERSION;
        if (expectedGraph) {
          d.graphDraftJSON = expectedGraph;
          d.graphDraftBasis = memoryBasis(existing);
        }
        if (expectedGraph) {
          if (sameGraph(existing.knowledgeGraphJSON, expectedGraph)) {
            acceptGraph(d, existing); await store.putDoc(d);
            await log(store, d, 'ok', `已核对原位更新后的原生记忆 #${d.memoryId} 文本与图谱；自然召回需另行验收`);
            return d;
          }
          if (isEmptyGraph(existing.knowledgeGraphJSON)) {
            d.graphVerifiedJSON = null; d.graphBasis = null;
            if (opts.reconcileOnly) {
              d.graphStatus = 'draft'; d.graphError = '原生文本已确认为新版本，尚无可核对的原生图谱，可手动补全';
              await store.putDoc(d);
              await log(store, d, 'ok', `已核对原位更新后的原生记忆 #${d.memoryId} 文本；原生图谱待补全`);
              return d;
            }
            await store.putDoc(d);
            return enrichLocked(client, store, d, opts);
          }
          d.graphStatus = 'uncertain'; d.graphVerifiedJSON = null; d.graphBasis = null;
          d.graphError = '原生文本已更新为新版本，但原生图谱与当前版本不一致（可能仍为旧版图谱），请核对图谱';
          await store.putDoc(d);
          await log(store, d, 'error', `已核对原生记忆 #${d.memoryId} 文本为新版本；${d.graphError}`);
          return d;
        }
        const hasStaleOrPrevGraph = hasGraph(existing.knowledgeGraphJSON) && (
          (pending?.previousGraphJSON && sameGraph(existing.knowledgeGraphJSON, pending.previousGraphJSON)) ||
          isStaleNativeGraph(existing.knowledgeGraphJSON, d, existing)
        );
        if (hasStaleOrPrevGraph) {
          d.graphStatus = 'uncertain'; d.graphVerifiedJSON = null; d.graphBasis = null;
          d.graphError = '原生文本已更新为新版本，但原生图谱仍保留更新前旧版本内容，请核对图谱';
          await store.putDoc(d);
          await log(store, d, 'error', `已核对原生记忆 #${d.memoryId} 文本为新版本；${d.graphError}`);
          return d;
        }
        if (hasGraph(existing.knowledgeGraphJSON)) {
          acceptGraph(d, existing); await store.putDoc(d);
          await log(store, d, 'ok', `已核对原位更新后的原生记忆 #${d.memoryId} 文本与图谱；自然召回需另行验收`);
          return d;
        }
        if (opts.reconcileOnly) {
          d.graphVerifiedJSON = null; d.graphBasis = null;
          d.graphStatus = d.graphDraftJSON ? 'draft' : 'missing';
          d.graphError = '当前原生记录尚无可核对的图谱，可手动补全';
          await store.putDoc(d);
          await log(store, d, 'ok', `已核对原位更新后的原生记忆 #${d.memoryId} 文本；原生图谱待补全`);
          return d;
        }
        await store.putDoc(d);
        return enrichLocked(client, store, d, opts);
      }

      if (opts.reconcileOnly) {
        if (d.syncStatus === 'stale' && !pending) return d;
        const expRaw = pending ? pending.rawText : fallbackExpected.rawText;
        const expSum = pending ? pending.summary : fallbackExpected.summary;
        const diff = versionDiffText(existing, expRaw, expSum);
        const matchesPrev = matchesPreviousWrite(existing, pending);
        d.syncStatus = matchesPrev ? 'stale' : 'uncertain';
        d.syncError = matchesPrev
          ? `${diff}；更新在宿主落库前中断，原生记忆仍保留旧版本，可点击“更新原记忆”重试`
          : `${diff}；原生记忆尚未更新到当前本地版本，请核对后再试`;
        d.graphVerifiedJSON = null; d.graphBasis = null;
        d.graphStatus = d.graphDraftJSON ? 'draft' : 'pending'; d.graphError = '';
        invalidateCheck(d);
        await store.putDoc(d);
        await log(store, d, 'error', d.syncError);
        return d;
      }

      // A read-only reconciliation restores stale but retains the original baseline.
      if (pending || ['sending', 'uncertain'].includes(d.syncStatus)) {
        const matchesPrev = matchesPreviousWrite(existing, pending);
        if (!matchesPrev) {
          const expRaw = pending ? pending.rawText : fallbackExpected.rawText;
          const expSum = pending ? pending.summary : fallbackExpected.summary;
          const diff = versionDiffText(existing, expRaw, expSum);
          d.syncStatus = 'uncertain';
          d.syncError = `${diff}；原生记忆与更新前基准不一致，未自动覆盖，请先核对`;
          await store.putDoc(d);
          throw new Error(d.syncError);
        }
      }

      const profile = await store.getProfile(d.characterId);
      const sessionMode = opts.memorySessionMode || profile?.settings?.memorySessionMode || 'isolated';
      const characterName = profile?.name || d.characterId;
      if (sessionMode === 'active' && !d.sessionId) {
        if (!profile?.selectedSessionId) throw new Error('这个角色还没有原生会话。先进行一次原生聊天，再更新生活状态并重试');
        d.sessionId = profile.selectedSessionId; await store.putDoc(d);
      } else if (!d.sessionId && profile?.selectedSessionId) {
        d.sessionId = profile.selectedSessionId; await store.putDoc(d);
      }
      const confirmedWake = syncDocumentWakeFacts(d, profile);
      assertNoUnconfirmedWake(d, confirmedWake);
      await store.putDoc(d);
      const payload = memoryPayload(d, { id: existing.id, timestamp: existing.timestamp, sessionId: existing.session_id });
      const { graphJSON, graphError } = await prepareGraphDraft(client, store, d, payload, characterName, opts);
      stopped(opts.signal); invalidateCheck(d);
      d.pendingWrite = buildPendingWrite({ op: 'update', targetMemoryId: existing.id, payload, graphJSON, existing });
      d.syncStatus = 'sending'; d.syncError = '';
      await store.putDoc(d);
      let updated;
      try {
        // Model generation can take time; preserve native edits made since the first read.
        const latest = await findWrittenMemory(client, d, opts);
        if (!matchesPreviousWrite(latest, d.pendingWrite)) {
          throw new Error('处理期间原生记忆或图谱已变化，未覆盖；请先在 Layla 中核对');
        }
        stopped(opts.signal);
        const rows = await client.memories.createOrUpdate([{ ...payload, knowledgeGraphJSON: graphJSON }], opts.signal ? { signal: opts.signal } : {});
        const receipt = rows?.find(m => m.id === existing.id && owns(m, d));
        if (!receipt) throw new Error('宿主未返回原记忆的更新回执');
        if (!matchesPendingWrite(receipt, d.pendingWrite)) throw new Error('宿主返回的更新回执仍为旧版本或内容不一致');
        updated = await findWrittenMemory(client, d, opts);
        if (!updated) throw new Error('更新后未能回读原记忆，请稍后核对');
        if (!matchesPendingWrite(updated, d.pendingWrite)) throw new Error('更新后回读内容仍为旧版本，尚未确认写入');
      } catch (e) {
        d.syncStatus = 'uncertain'; d.syncError = String(e.message || e).slice(0, 500); await store.putDoc(d); throw e;
      }
      const prevGraphJSON = d.pendingWrite?.previousGraphJSON ?? null;
      d.nativeTimestamp = updated.timestamp; d.syncedAt = Date.now(); d.syncStatus = 'written'; d.syncError = '';
      d.pendingWrite = null; d.memoryPipelineVersion = VERSION;
      if (graphJSON) d.graphDraftBasis = memoryBasis(updated);
      if (graphJSON && sameGraph(updated.knowledgeGraphJSON, graphJSON)) {
        acceptGraph(d, updated); await store.putDoc(d);
        await log(store, d, 'ok', `已原位更新原生记忆 #${d.memoryId} 的文本与图谱；自然召回需另行验收`);
        return d;
      }
      if (graphError) {
        if (prevGraphJSON && hasGraph(updated.knowledgeGraphJSON) && sameGraph(updated.knowledgeGraphJSON, prevGraphJSON)) {
          d.graphStatus = 'uncertain'; d.graphVerifiedJSON = null; d.graphBasis = null;
          d.graphError = `文本已更新，图谱生成失败（${graphError}），且原生图谱仍为旧版本内容，请重试补全图谱`;
        } else {
          d.graphStatus = 'error'; d.graphError = graphError;
        }
        await store.putDoc(d);
        await log(store, d, 'error', `已原位更新记忆 #${d.memoryId} 文本；图谱未完成：${d.graphError}`);
        return d;
      }
      await store.putDoc(d);
      return enrichLocked(client, store, d, opts);
    }

    const pendingCreate = d.pendingWrite?.op === 'create' ? d.pendingWrite : null;
    let native = await findWrittenMemory(client, d, opts);
    let preGraphJSON = pendingCreate?.graphJSON ?? null, preGraphError = '';
    if (native && pendingCreate && !matchesPendingWrite(native, pendingCreate)) {
      const diff = versionDiffText(native, pendingCreate.rawText, pendingCreate.summary);
      d.memoryId = native.id; d.nativeTimestamp = native.timestamp;
      d.syncStatus = 'uncertain';
      d.syncError = `${diff}；已存在同标记但内容不同的原生记忆，未标记为已写入`;
      d.graphVerifiedJSON = null; d.graphBasis = null;
      await store.putDoc(d);
      if (opts.reconcileOnly) {
        await log(store, d, 'error', d.syncError);
        return d;
      }
      throw new Error(d.syncError);
    }
    if (!native) {
      if (opts.reconcileOnly || validId(d.memoryId) || ['sending', 'uncertain'].includes(d.syncStatus)) throw new Error('暂未找到写入回执，已保留待核对状态；请检查原生记忆，避免重复新增');
      const profile = await store.getProfile(d.characterId);
      const sessionMode = opts.memorySessionMode || profile?.settings?.memorySessionMode || 'isolated';
      const characterName = profile?.name || d.characterId;
      if (sessionMode === 'active' && !d.sessionId) {
        if (!profile?.selectedSessionId) throw new Error('这个角色还没有原生会话。先进行一次原生聊天，再更新生活状态并重试');
        d.sessionId = profile.selectedSessionId; await store.putDoc(d);
      } else if (!d.sessionId && profile?.selectedSessionId) {
        d.sessionId = profile.selectedSessionId; await store.putDoc(d);
      }
      const confirmedWake = syncDocumentWakeFacts(d, profile);
      assertNoUnconfirmedWake(d, confirmedWake);
      await store.putDoc(d);
      const basePayload = memoryPayload(d, { memorySessionMode: sessionMode });
      ({ graphJSON: preGraphJSON, graphError: preGraphError } = await prepareGraphDraft(client, store, d, basePayload, characterName, opts));
      stopped(opts.signal);
      d.pendingWrite = buildPendingWrite({ op: 'create', targetMemoryId: null, payload: basePayload, graphJSON: preGraphJSON });
      d.syncStatus = 'sending'; d.syncError = '';
      await store.putDoc(d);
      try {
        const rows = await client.memories.createOrUpdate([{ ...basePayload, knowledgeGraphJSON: preGraphJSON }], opts.signal ? { signal: opts.signal } : {});
        native = rows?.find(m => owns(m, d) && matchesPendingWrite(m, d.pendingWrite));
        if (!native) throw new Error('宿主未返回可核对的记忆回执');
      } catch (e) {
        d.syncStatus = 'uncertain'; d.syncError = String(e.message || e).slice(0, 500); await store.putDoc(d); throw e;
      }
    }
    d.memoryId = native.id; d.nativeTimestamp = native.timestamp; d.syncedAt = Date.now(); d.syncStatus = 'written'; d.syncError = '';
    d.pendingWrite = null; d.memoryPipelineVersion = VERSION;
    if (preGraphJSON) d.graphDraftBasis = memoryBasis(native);
    await store.putDoc(d);
    if (opts.reconcileOnly) {
      if (preGraphJSON) {
        if (sameGraph(native.knowledgeGraphJSON, preGraphJSON)) acceptGraph(d, native);
        else if (isEmptyGraph(native.knowledgeGraphJSON)) { d.graphStatus = 'draft'; d.graphError = '当前原生记录尚无可核对的图谱，可手动补全'; }
        else { d.graphStatus = 'uncertain'; d.graphError = '原生图谱与待核对草稿不一致，请核对图谱'; }
      } else if (hasGraph(native.knowledgeGraphJSON)) {
        if (isStaleNativeGraph(native.knowledgeGraphJSON, d, native)) {
          d.graphStatus = 'uncertain'; d.graphVerifiedJSON = null; d.graphBasis = null;
          d.graphError = '原生图谱仍为旧版本或与当前正文不一致，请核对图谱';
        } else {
          acceptGraph(d, native);
        }
      } else {
        d.graphStatus = d.graphDraftJSON ? 'draft' : 'missing';
      }
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
