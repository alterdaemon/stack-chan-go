export const DOMAIN = {
  wifi: 'wifi',
  driver: 'driver',
  ui: 'ui',
  tts: 'tts',
  ai: 'ai',
  openailive: 'openailive',
  led: 'led',
  mcp: 'mcp',
  time: 'time',
  www: 'www',
} as const

export const PREF_KEYS: readonly [keyof typeof DOMAIN, string, StringConstructor | NumberConstructor][] = Object.freeze(
  [
    [DOMAIN.wifi, 'ssid', String],
    [DOMAIN.wifi, 'password', String],
    [DOMAIN.ui, 'type', String],
    [DOMAIN.ui, 'language', String],
    [DOMAIN.driver, 'type', String],
    [DOMAIN.driver, 'baudrate', Number],
    [DOMAIN.driver, 'offsetPan', Number],
    [DOMAIN.driver, 'offsetTilt', Number],
    [DOMAIN.tts, 'type', String],
    [DOMAIN.tts, 'host', String],
    [DOMAIN.tts, 'port', Number],
    [DOMAIN.tts, 'token', String],
    [DOMAIN.tts, 'volume', Number],
    [DOMAIN.tts, 'voice', String],
    [DOMAIN.tts, 'speed', Number],
    [DOMAIN.ai, 'token', String],
    [DOMAIN.ai, 'context', String],
    [DOMAIN.openailive, 'backendModel', String],
    [DOMAIN.openailive, 'reasoningEffort', String],
    [DOMAIN.openailive, 'bargeIn', Number],
    [DOMAIN.mcp, 'token', String],
    [DOMAIN.time, 'timezone', String],
    [DOMAIN.www, 'password', String],
  ],
  true,
)

export const DEFAULT_FONT = 'OpenSans-Regular-24.bf4'
