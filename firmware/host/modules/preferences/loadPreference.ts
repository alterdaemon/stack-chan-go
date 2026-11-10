import structuredClone from 'structuredClone'
import { DOMAIN, PREF_KEYS } from 'consts'
import config from 'mc/config'
import Modules from 'modules'
import { isLiveVoicePreference } from 'openai-live-options'
import Preference from 'preference'

// biome-ignore lint/suspicious/noExplicitAny: Match the type definition of mc/config
type ConfigRecord = Record<string, any>
export type PreferenceDomain = keyof typeof DOMAIN
export type PreferenceConfig = Record<PreferenceDomain, ConfigRecord>

const LEGACY_RENDERER_DOMAIN = 'renderer'
let modConfig: ConfigRecord | undefined

export function loadModConfig(): ConfigRecord {
  if (modConfig) return modConfig
  try {
    modConfig = Modules.has('mod/config') ? (Modules.importNow('mod/config') as ConfigRecord) : {}
  } catch (error) {
    trace(
      `[preferences] mod config unavailable: ${error && typeof error === 'object' && 'message' in error ? error.message : error}\n`,
    )
    modConfig = {}
  }
  return modConfig
}

const PREFERENCE_DOMAINS: PreferenceDomain[] = [
  DOMAIN.wifi,
  DOMAIN.driver,
  DOMAIN.ui,
  DOMAIN.tts,
  DOMAIN.ai,
  DOMAIN.openailive,
  DOMAIN.led,
  DOMAIN.mcp,
  DOMAIN.time,
  DOMAIN.www,
]

export default function loadPreferences(category: PreferenceDomain): ConfigRecord {
  const mcPreference = structuredClone((config[category.toLowerCase()] ?? {}) as ConfigRecord)
  const modPreference = structuredClone((loadModConfig()[category.toLowerCase()] ?? {}) as ConfigRecord)

  const preference = { ...mcPreference, ...modPreference }
  if (category === DOMAIN.www) preference.password ??= ''
  if (category === DOMAIN.openailive) {
    // Match GPT-Live's whole-block MOD override and expose only its editable fields.
    const live = loadModConfig().openaiLive ?? config.openaiLive ?? {}
    preference.backendModel = live.backendModel
    preference.reasoningEffort = live.reasoningEffort
    preference.bargeIn = 0 // Opt-in, including installations with no saved preference.
    preference.voice = isLiveVoicePreference('openailive.voice', live.voice) ? live.voice : 'marin'
    preference.pitch = isLiveVoicePreference('openailive.pitch', live.pitch) ? Number(live.pitch) : 0
    preference.style = isLiveVoicePreference('openailive.style', live.style) ? live.style : 'default'
  }
  const lockedDriverType =
    category === DOMAIN.driver && mcPreference.typeLocked === true && typeof mcPreference.type === 'string'
      ? mcPreference.type
      : undefined
  if (lockedDriverType !== undefined) {
    preference.type = lockedDriverType
    preference.typeLocked = true
  }

  const keys = PREF_KEYS.filter((s) => s[0] === category)
  for (const [domain, key, ctor] of keys) {
    const value = Preference.get(domain, key)
    if (value != null) {
      if (!isLiveVoicePreference(`${domain}.${key}`, value)) continue
      if (domain === DOMAIN.driver && key === 'type' && lockedDriverType !== undefined) {
        if (String(value) !== lockedDriverType) {
          trace(`[preferences] ignored stored driver.type=${value}; platform locks it to ${lockedDriverType}\n`)
        }
        continue
      }
      preference[key] = ctor(value)
    }
  }

  if (category === DOMAIN.openailive) preference.bargeIn = preference.bargeIn === 1 ? 1 : 0

  if (category === DOMAIN.ui && Preference.get(DOMAIN.ui, 'type') == null) {
    const legacyType = Preference.get(LEGACY_RENDERER_DOMAIN, 'type')
    if (legacyType != null) {
      preference.type = String(legacyType)
      // Write back to the canonical domain so legacy migration is one-shot.
      Preference.set(DOMAIN.ui, 'type', preference.type)
      trace(`[preferences] migrated ${LEGACY_RENDERER_DOMAIN}.type to ${DOMAIN.ui}.type\n`)
    }
  }

  return preference
}

export function loadPreferenceConfig(): PreferenceConfig {
  return Object.fromEntries(PREFERENCE_DOMAINS.map((domain) => [domain, loadPreferences(domain)])) as PreferenceConfig
}
