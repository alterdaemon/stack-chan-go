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
  const auth = getPreference('openailive', 'auth') ?? 'api-key'
  if (!['api-key', 'chatgpt'].includes(auth)) throw new Error('Invalid authentication mode')
  const subscription = auth === 'chatgpt'
  const token = subscription ? undefined : getPreference('ai', 'token')
  const context = getPreference('ai', 'context')
  const backendModel = getPreference('openailive', subscription ? 'codexModel' : 'backendModel')
  const subscriptionModel = subscription ? (backendModel ?? 'gpt-6.1-terra') : undefined
  if (subscription && !isLiveVoicePreference('openailive.codexModel', subscriptionModel))
    throw new Error('Unsupported subscription backend model')
  const reasoningEffort = getPreference('openailive', subscription ? 'codexEffort' : 'reasoningEffort')
  const subscriptionEffort = subscription ? (reasoningEffort ?? 'medium') : undefined
  if (subscription && !isLiveVoicePreference('openailive.codexEffort', subscriptionEffort))
    throw new Error('Unsupported subscription reasoning effort')
  const bargeIn = getPreference('openailive', 'bargeIn')
  const savedMode = getPreference('openailive', 'mode')
  const mode = !subscription && ['realtime', 'realtime-full'].includes(savedMode) ? 'realtime' : 'live'
  const realtimeVoice = subscription ? undefined : getPreference('openailive', 'realtimeVoice')
  const savedVolume = getPreference('tts', 'volume')
  const volume = savedVolume === undefined || savedVolume === '' ? NaN : Number(savedVolume)
  const voiceSettings = {}
  for (const [key, fallback] of [
    ['voice', 'marin'],
    ['pitch', 0],
    ['style', 'default'],
    ['standbySeconds', 60],
  ]) {
    if (subscription && key === 'voice') {
      const voice = getPreference('openailive', 'codexVoice') ?? 'cove'
      if (!isLiveVoicePreference('openailive.codexVoice', voice)) throw new Error('Unsupported subscription voice')
      voiceSettings.voice = voice
      continue
    }
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
    auth,
    ...(subscription
      ? {
          model: 'gpt-live-1.1-codex',
          delegation: undefined,
          tools: undefined,
          search: undefined,
          backendModel: subscriptionModel.trim(),
          reasoningEffort: subscriptionEffort,
        }
      : {}),
    ...(mode === 'realtime'
      ? {
          model: savedMode === 'realtime-full' ? 'gpt-realtime-2.1' : 'gpt-realtime-2.1-mini',
          voice: isLiveVoicePreference('openailive.realtimeVoice', realtimeVoice) ? realtimeVoice : 'marin',
        }
      : {}),
    bargeIn: bargeIn === 1 || bargeIn === '1',
    ...(!subscription && typeof backendModel === 'string' && backendModel.trim()
      ? { backendModel: backendModel.trim() }
      : {}),
    ...(!subscription && ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)
      ? { reasoningEffort }
      : {}),
    apiKey: subscription ? undefined : typeof token === 'string' ? token.trim() : (defaults.apiKey ?? ''),
    instructions: liveStyleInstructions(
      typeof context === 'string' && context.trim() ? context.trim() : (defaults.instructions ?? ''),
      voiceSettings.style,
    ),
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : (defaults.volume ?? 1),
  }
}
