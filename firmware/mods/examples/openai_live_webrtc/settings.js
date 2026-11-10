// Read on each manual start so saved BLE preferences take effect without a rebuild.
function copyConfig(value) {
  // mc/config is preloaded in flash. XS 10.0.2 JSON.stringify marks objects
  // while walking them and rejects a ROM-backed array. Clone into RAM before
  // passing nested configuration to Conversation's JSON copy.
  // See Moddable xs/sources/xsJSON.c, fxStringifyJSONProperty.
  if (Array.isArray(value)) return value.map(copyConfig)
  if (value && typeof value === 'object') {
    const copy = {}
    for (const key of Object.keys(value)) copy[key] = copyConfig(value[key])
    return copy
  }
  return value
}

export function readLiveSettings(defaults, getPreference) {
  const token = getPreference('ai', 'token')
  const context = getPreference('ai', 'context')
  const backendModel = getPreference('openailive', 'backendModel')
  const reasoningEffort = getPreference('openailive', 'reasoningEffort')
  const bargeIn = getPreference('openailive', 'bargeIn')
  const savedVolume = getPreference('tts', 'volume')
  const volume = savedVolume === undefined || savedVolume === '' ? NaN : Number(savedVolume)
  return {
    ...copyConfig(defaults),
    bargeIn: bargeIn === 1 || bargeIn === '1',
    ...(typeof backendModel === 'string' && backendModel.trim() ? { backendModel: backendModel.trim() } : {}),
    ...(['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort) ? { reasoningEffort } : {}),
    apiKey: typeof token === 'string' ? token.trim() : (defaults.apiKey ?? ''),
    instructions: typeof context === 'string' && context.trim() ? context.trim() : defaults.instructions,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : (defaults.volume ?? 1),
  }
}
