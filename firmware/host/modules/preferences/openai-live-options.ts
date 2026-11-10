// GPT-Live voices; this is separate from the Realtime/TTS voice lists.
// https://developers.openai.com/api/reference/resources/live/methods/create
export const OPENAI_LIVE_VOICES: readonly string[] = Object.freeze([
  'alloy',
  'ash',
  'ballad',
  'beacon',
  'bossa',
  'brise',
  'cedar',
  'cinder',
  'coral',
  'delta',
  'echo',
  'flitz',
  'gleam',
  'harema',
  'juni',
  'marin',
  'meridian',
  'nira',
  'noeul',
  'nuri',
  'quartz',
  'ripple',
  'sage',
  'shida',
  'shimmer',
  'sillage',
  'stone',
  'tempo',
  'verse',
  'vesper',
  'willow',
])
export const OPENAI_LIVE_STYLES: readonly string[] = Object.freeze(['default', 'calm', 'expressive'])
export const OPENAI_LIVE_PITCH_MIN = -6
export const OPENAI_LIVE_PITCH_MAX = 6
export const OPENAI_LIVE_STANDBY_MIN = 1
export const OPENAI_LIVE_STANDBY_MAX = 3600

export function isLivePitch(value: unknown): boolean {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return false
  const pitch = Number(value)
  return Number.isInteger(pitch) && pitch >= OPENAI_LIVE_PITCH_MIN && pitch <= OPENAI_LIVE_PITCH_MAX
}

export function isLiveVoicePreference(prop: string, value: unknown): boolean {
  if (prop === 'openailive.standbySeconds') {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return false
    const seconds = Number(value)
    return Number.isInteger(seconds) && seconds >= OPENAI_LIVE_STANDBY_MIN && seconds <= OPENAI_LIVE_STANDBY_MAX
  }
  if (prop === 'openailive.voice') return typeof value === 'string' && OPENAI_LIVE_VOICES.includes(value)
  if (prop === 'openailive.pitch') return isLivePitch(value)
  if (prop === 'openailive.style') return typeof value === 'string' && OPENAI_LIVE_STYLES.includes(value)
  return true
}

// Guide delivery only, retaining the user's context and interruption policy.
// https://developers.openai.com/api/docs/guides/live-prompting
export function liveStyleInstructions(instructions: string, style: string): string {
  const delivery =
    style === 'calm'
      ? 'Speak calmly and evenly, with gentle, restrained expression.'
      : style === 'expressive'
        ? 'Speak expressively, with lively, varied intonation and clear articulation.'
        : ''
  return delivery ? `${instructions}${instructions ? '\n' : ''}Speaking style: ${delivery}` : instructions
}
