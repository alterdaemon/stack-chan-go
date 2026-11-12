import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { writeAliasPackage, writeAliasPackageSubpath } from '../testing/node-alias-package.js'
import { DOMAIN } from './consts.js'

type FakeConfig = {
  resetConfig(values?: Record<string, unknown>): void
}

type FakeModules = {
  resetModules(values?: Record<string, unknown>): void
}

type FakePreference = {
  resetPreference(values?: Record<string, unknown>): void
  default: {
    get(domain: string, name: string): unknown
  }
}

function installBareSpecifierPackages(): void {
  const modulesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  writeAliasPackage(modulesRoot, 'consts', resolve(modulesRoot, 'preferences/consts.js'))
  writeAliasPackage(modulesRoot, 'openai-live-options', resolve(modulesRoot, 'preferences/openai-live-options.js'))
  writeAliasPackage(modulesRoot, 'modules', resolve(modulesRoot, 'testing/fakes/modules.js'), {
    hasDefaultExport: true,
  })
  writeAliasPackage(modulesRoot, 'preference', resolve(modulesRoot, 'testing/fakes/preference.js'), {
    hasDefaultExport: true,
  })
  writeAliasPackage(modulesRoot, 'structuredClone', resolve(modulesRoot, 'testing/fakes/structured-clone.js'), {
    hasDefaultExport: true,
  })
  writeAliasPackageSubpath(modulesRoot, 'mc', 'config', resolve(modulesRoot, 'testing/fakes/mc-config.js'), {
    hasDefaultExport: true,
  })
}

async function setup() {
  installBareSpecifierPackages()
  const [modules, config, preference, loadPreference] = await Promise.all([
    import('../testing/fakes/modules.js') as Promise<FakeModules>,
    import('../testing/fakes/mc-config.js') as Promise<FakeConfig>,
    import('../testing/fakes/preference.js') as Promise<FakePreference>,
    import('./loadPreference.js'),
  ])
  const traces: string[] = []
  ;(globalThis as typeof globalThis & { trace: (...messages: unknown[]) => void }).trace = (...messages) => {
    traces.push(messages.map(String).join(''))
  }
  modules.resetModules()
  config.resetConfig({ ui: { type: 'simple' } })
  preference.resetPreference()
  return { loadPreferences: loadPreference.default, modules, config, preference, traces }
}

test('loadPreferences migrates legacy renderer.type to ui.type when ui.type is absent', async () => {
  const { loadPreferences, preference } = await setup()
  preference.resetPreference({
    'renderer.type': 'dog',
  })

  assert.equal(loadPreferences(DOMAIN.ui).type, 'dog')
  assert.equal(preference.default.get(DOMAIN.ui, 'type'), 'dog')
})

test('loadPreferences traces legacy renderer migration only once after canonical write-back', async () => {
  const { loadPreferences, preference, traces } = await setup()
  preference.resetPreference({
    'renderer.type': 'dog',
  })

  assert.equal(loadPreferences(DOMAIN.ui).type, 'dog')
  assert.equal(loadPreferences(DOMAIN.ui).type, 'dog')
  assert.deepEqual(traces, ['[preferences] migrated renderer.type to ui.type\n'])
})

test('loadPreferences keeps explicit ui.type when legacy renderer.type also exists', async () => {
  const { loadPreferences, preference } = await setup()
  preference.resetPreference({
    'ui.type': 'simple',
    'renderer.type': 'dog',
  })

  assert.equal(loadPreferences(DOMAIN.ui).type, 'simple')
  assert.equal(preference.default.get(DOMAIN.ui, 'type'), 'simple')
})

test('loadPreferences ignores a stored driver type when the platform locks its driver', async () => {
  const { loadPreferences, config, preference, traces } = await setup()
  config.resetConfig({
    driver: { type: 'm5stackchan', typeLocked: true },
  })
  preference.resetPreference({
    'driver.type': 'scservo',
  })

  const driver = loadPreferences(DOMAIN.driver)

  assert.equal(driver.type, 'm5stackchan')
  assert.equal(driver.typeLocked, true)
  assert.deepEqual(traces, ['[preferences] ignored stored driver.type=scservo; platform locks it to m5stackchan\n'])
})

test('loadPreferences keeps stored driver selection on an unlocked platform', async () => {
  const { loadPreferences, config, preference } = await setup()
  config.resetConfig({
    driver: { type: 'm5stackchan' },
  })
  preference.resetPreference({
    'driver.type': 'scservo',
  })

  assert.equal(loadPreferences(DOMAIN.driver).type, 'scservo')
})

test('loadPreferences does not let MOD config relax a platform driver lock', async () => {
  const { modules, config } = await setup()
  modules.resetModules({
    'mod/config': { driver: { type: 'scservo', typeLocked: false } },
  })
  config.resetConfig({
    driver: { type: 'm5stackchan', typeLocked: true },
  })
  const freshModule = await import(new URL('./loadPreference.js?platform-lock', import.meta.url).href)

  const driver = freshModule.default(DOMAIN.driver)

  assert.equal(driver.type, 'm5stackchan')
  assert.equal(driver.typeLocked, true)
})

test('loadPreferences reads the MCP authentication token from preferences', async () => {
  const { loadPreferences, preference } = await setup()
  preference.resetPreference({
    'mcp.token': 'secret-token',
  })

  assert.equal(loadPreferences(DOMAIN.mcp).token, 'secret-token')
})

test('loadPreferences reads the selected time zone from preferences', async () => {
  const { loadPreferences, preference } = await setup()
  preference.resetPreference({
    'time.timezone': 'london',
  })

  assert.equal(loadPreferences(DOMAIN.time).timezone, 'london')
})

test('OpenAI preferences expose host defaults and stored overrides without changing AI preferences', async () => {
  const { loadPreferences, config, preference } = await setup()
  const defaults = {
    mode: 'live',
    realtimeVoice: 'marin',
    backendModel: 'host-backend',
    reasoningEffort: 'medium',
    bargeIn: 0,
    voice: 'marin',
    pitch: 0,
    style: 'default',
    standbySeconds: 60,
  }
  config.resetConfig({ openaiLive: { ...defaults, model: 'voice-model', apiKey: 'host-only' } })
  assert.deepEqual(loadPreferences(DOMAIN.openailive), defaults)
  preference.resetPreference({
    'openailive.backendModel': 'saved-backend',
    'openailive.reasoningEffort': 'none',
    'ai.token': 'shared-token',
    'ai.context': 'shared-context',
  })
  assert.deepEqual(loadPreferences(DOMAIN.openailive), {
    mode: 'live',
    realtimeVoice: 'marin',
    backendModel: 'saved-backend',
    reasoningEffort: 'none',
    bargeIn: 0,
    voice: 'marin',
    pitch: 0,
    style: 'default',
    standbySeconds: 60,
  })
  assert.deepEqual(loadPreferences(DOMAIN.ai), { token: 'shared-token', context: 'shared-context' })
})

test('voice interruption defaults off and survives saved settings reloads', async () => {
  const { loadPreferences, config, preference } = await setup()
  config.resetConfig({ openaiLive: { backendModel: 'host', bargeIn: true } })
  assert.equal(loadPreferences(DOMAIN.openailive).bargeIn, 0)
  for (const value of ['1', 1, '0', 0, 'invalid', 2]) {
    preference.resetPreference({ 'openailive.bargeIn': value })
    assert.equal(loadPreferences(DOMAIN.openailive).bargeIn, value === '1' || value === 1 ? 1 : 0)
  }
})

test('standby preference exposes the same default and validated saved timeout used by GPT-Live', async () => {
  const { loadPreferences, config, preference } = await setup()
  config.resetConfig({ openaiLive: { standbySeconds: 30 } })
  for (const value of [undefined, '0', '3601', '2.5', '', '45', 120]) {
    preference.resetPreference(value === undefined ? {} : { 'openailive.standbySeconds': value })
    assert.equal(loadPreferences(DOMAIN.openailive).standbySeconds, value === '45' ? 45 : value === 120 ? 120 : 30)
  }
})

test('OpenAI preferences use the same whole MOD configuration override as GPT-Live', async () => {
  const { modules, config } = await setup()
  config.resetConfig({ openaiLive: { backendModel: 'host-backend', reasoningEffort: 'high' } })
  modules.resetModules({ 'mod/config': { openaiLive: { backendModel: 'mod-backend' } } })
  const fresh = await import(new URL('./loadPreference.js?openai-mod', import.meta.url).href)
  assert.deepEqual(fresh.default(DOMAIN.openailive), {
    mode: 'live',
    realtimeVoice: 'marin',
    backendModel: 'mod-backend',
    reasoningEffort: undefined,
    bargeIn: 0,
    voice: 'marin',
    pitch: 0,
    style: 'default',
    standbySeconds: 60,
  })
})

test('voice preferences survive reload and invalid saved values preserve firmware defaults', async () => {
  const { loadPreferences, config, preference } = await setup()
  config.resetConfig({ openaiLive: { voice: 'cedar', pitch: -2, style: 'calm' } })
  preference.resetPreference({ 'openailive.voice': 'coral', 'openailive.pitch': '5', 'openailive.style': 'expressive' })
  let result = loadPreferences(DOMAIN.openailive)
  assert.equal(result.voice, 'coral')
  assert.equal(result.pitch, 5)
  assert.equal(result.style, 'expressive')
  preference.resetPreference({
    'openailive.voice': 'unknown',
    'openailive.pitch': '6.5',
    'openailive.style': 'unknown',
  })
  result = loadPreferences(DOMAIN.openailive)
  assert.equal(result.voice, 'cedar')
  assert.equal(result.pitch, -2)
  assert.equal(result.style, 'calm')
})

test('mode and independent Realtime voice reload without changing saved Live voice', async () => {
  const { loadPreferences, preference } = await setup()
  for (const mode of ['realtime', 'realtime-full']) {
    preference.resetPreference({
      'openailive.mode': mode,
      'openailive.realtimeVoice': 'cedar',
      'openailive.voice': 'bossa',
    })
    const result = loadPreferences(DOMAIN.openailive)
    assert.equal(result.mode, mode)
    assert.equal(result.realtimeVoice, 'cedar')
    assert.equal(result.voice, 'bossa')
  }
  preference.resetPreference({
    'openailive.mode': 'unknown',
    'openailive.realtimeVoice': 'bossa',
    'openailive.voice': 'bossa',
  })
  const result = loadPreferences(DOMAIN.openailive)
  assert.equal(result.mode, 'live')
  assert.equal(result.realtimeVoice, 'marin')
  assert.equal(result.voice, 'bossa')
})
