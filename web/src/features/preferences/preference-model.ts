export const PREFERENCE_KEYS = [
  'wifi.ssid',
  'wifi.password',
  'driver.type',
  'driver.offsetPan',
  'driver.offsetTilt',
  'ui.type',
  'ui.language',
  'tts.type',
  'tts.host',
  'tts.port',
  'tts.token',
  'tts.voice',
  'tts.volume',
  'ai.token',
  'ai.context',
  'openailive.backendModel',
  'openailive.reasoningEffort',
  'openailive.bargeIn',
  'openailive.voice',
  'openailive.pitch',
  'openailive.style',
  'openailive.standbySeconds',
  'mcp.token',
  'www.password',
] as const

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number]
export type PreferenceValues = Record<PreferenceKey, string>

export const DEFAULT_PREFERENCES: PreferenceValues = {
  'wifi.ssid': '',
  'wifi.password': '',
  'driver.type': 'm5stackchan',
  'driver.offsetPan': '0',
  'driver.offsetTilt': '0',
  'ui.type': 'simple',
  'ui.language': 'ja',
  'tts.type': 'voicevox',
  'tts.host': '',
  'tts.port': '',
  'tts.token': '',
  'tts.voice': '',
  'tts.volume': '1',
  'ai.token': '',
  'ai.context': '',
  // Populated by the device, including its firmware defaults.
  'openailive.backendModel': '',
  'openailive.reasoningEffort': '',
  'openailive.bargeIn': '0',
  'openailive.voice': 'marin',
  'openailive.pitch': '0',
  'openailive.style': 'default',
  'openailive.standbySeconds': '60',
  'mcp.token': '',
  'www.password': '',
}

export const OPENAI_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export const isPreferenceKey = (value: string): value is PreferenceKey =>
  (PREFERENCE_KEYS as readonly string[]).includes(value)
export {
  OPENAI_LIVE_VOICES,
  OPENAI_LIVE_STYLES,
  OPENAI_LIVE_PITCH_MIN,
  OPENAI_LIVE_PITCH_MAX,
  OPENAI_LIVE_STANDBY_MIN,
  OPENAI_LIVE_STANDBY_MAX,
  isLiveVoicePreference,
} from '../../../../firmware/host/modules/preferences/openai-live-options'
