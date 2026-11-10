// Read on each manual start so saved BLE preferences take effect without a rebuild.
export function readLiveSettings(defaults, getPreference) {
  const token = getPreference('ai', 'token')
  const context = getPreference('ai', 'context')
  const savedVolume = getPreference('tts', 'volume')
  const volume = savedVolume === undefined || savedVolume === '' ? NaN : Number(savedVolume)
  return {
    ...defaults,
    apiKey: typeof token === 'string' ? token.trim() : (defaults.apiKey ?? ''),
    instructions: typeof context === 'string' && context.trim() ? context.trim() : defaults.instructions,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : (defaults.volume ?? 1),
  }
}
