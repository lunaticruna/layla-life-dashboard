// Match the sorted background queue against THIS run's host visibility before
// spending its single execution slot. Never repair ownership using a name.
const validId = id => (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
const describe = (id, name) => ({ characterId: validId(id) ? id : null, idType: typeof id, name: typeof name === 'string' ? name.slice(0, 100) : '' });
const describeRecord = r => describe(r.characterId, r.name);
const describeCharacter = c => describe(c?.id, c?.data?.data?.name);

export function selectBackgroundRole(records, characters) {
  const candidates = records.map(record => ({ record, character: validId(record.characterId) ? characters.find(c => validId(c?.id) && c.id === record.characterId) : undefined }));
  const available = candidates.filter(x => x.character), unavailable = candidates.filter(x => !x.character);
  const chosen = available[0];
  const reason = characters.length ? 'background_character_mismatch' : 'host_characters_empty';
  const warnings = unavailable.length ? [`${unavailable.length} 条后台配置未匹配到宿主本轮返回的角色，已跳过；原有记录保留，未按同名角色重新绑定`] : [];
  const limit = 20;
  return { record: chosen?.record, character: chosen?.character, warnings, reason,
    diagnostics: {
      configuredCount: records.length, visibleCount: characters.length, matchedCount: available.length, unavailableCount: unavailable.length,
      selected: chosen ? describeCharacter(chosen.character) : null,
      configured: records.slice(0, limit).map(describeRecord),
      visible: characters.slice(0, limit).map(describeCharacter),
      unavailable: unavailable.slice(0, limit).map(x => describeRecord(x.record)),
      truncated: { configured: records.length > limit, visible: characters.length > limit, unavailable: unavailable.length > limit }
    } };
}

export function unavailableBackgroundMessage(selection) {
  return selection.reason === 'host_characters_empty'
    ? '宿主本轮未返回任何可见角色，后台工作已跳过；配置仍保留，需核对宿主角色可见性'
    : '后台配置的角色 ID 均未匹配到宿主本轮返回的角色，本轮已跳过；请核对 diagnostics 中的 configured、visible 与 unavailable';
}
