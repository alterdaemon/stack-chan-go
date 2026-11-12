import { isLiveVoicePreference, liveStyleInstructions } from 'openai-live-options'

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
  const savedMode = getPreference('openailive', 'mode')
  const mode = savedMode === 'realtime' || savedMode === 'realtime-full' ? 'realtime' : 'live'
  const realtimeVoice = getPreference('openailive', 'realtimeVoice')
  const savedVolume = getPreference('tts', 'volume')
  const volume = savedVolume === undefined || savedVolume === '' ? NaN : Number(savedVolume)
  const voiceSettings = {}
  for (const [key, fallback] of [
    ['voice', 'marin'],
    ['pitch', 0],
    ['style', 'default'],
    ['standbySeconds', 60],
  ]) {
    const prop = `openailive.${key}`
    const saved = getPreference('openailive', key)
    const value = isLiveVoicePreference(prop, saved)
      ? saved
      : isLiveVoicePreference(prop, defaults[key])
        ? defaults[key]
        : fallback
    voiceSettings[key] = key === 'pitch' || key === 'standbySeconds' ? Number(value) : value
  }
  return {
    ...copyConfig(defaults),
    ...voiceSettings,
    mode,
    ...(mode === 'realtime'
      ? {
          model: savedMode === 'realtime-full' ? 'gpt-realtime-2.1' : 'gpt-realtime-2.1-mini',
          voice: isLiveVoicePreference('openailive.realtimeVoice', realtimeVoice) ? realtimeVoice : 'marin',
        }
      : {}),
    bargeIn: bargeIn === 1 || bargeIn === '1',
    ...(typeof backendModel === 'string' && backendModel.trim() ? { backendModel: backendModel.trim() } : {}),
    ...(['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort) ? { reasoningEffort } : {}),
    apiKey: typeof token === 'string' ? token.trim() : (defaults.apiKey ?? ''),
    instructions: liveStyleInstructions(
      typeof context === 'string' && context.trim() ? context.trim() : (defaults.instructions ?? ''),
      voiceSettings.style,
    ),
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : (defaults.volume ?? 1),
  }
}
