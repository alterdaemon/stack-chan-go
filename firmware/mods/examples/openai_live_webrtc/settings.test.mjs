import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { LiveSession } from './session.js'

const optionsURL = new URL('../../../host/modules/preferences/openai-live-options.ts', import.meta.url).href
const settingsSource = readFileSync(new URL('./settings.js', import.meta.url), 'utf8').replace(
  "'openai-live-options'",
  JSON.stringify(optionsURL),
)
const { readLiveSettings } = await import(`data:text/javascript,${encodeURIComponent(settingsSource)}`)

test('voice interruption is opt-in and invalid or missing saved values stay off', () => {
  let saved
  const read = () => readLiveSettings({ bargeIn: true }, (_domain, key) => (key === 'bargeIn' ? saved : undefined))
  for (saved of [undefined, '', 'false', 'true', '2', 2, false, true]) assert.equal(read().bargeIn, false)
  for (saved of ['1', 1]) assert.equal(read().bargeIn, true)
  for (saved of ['0', 0, undefined]) assert.equal(read().bargeIn, false)
})

test('standby seconds reload on each start and invalid storage falls back to firmware or 60 seconds', () => {
  let saved
  const read = (defaults = {}) =>
    readLiveSettings(defaults, (_domain, key) => (key === 'standbySeconds' ? saved : undefined))
  assert.equal(read().standbySeconds, 60)
  for (saved of ['1', '45', '3600', 90]) assert.equal(read().standbySeconds, Number(saved))
  for (saved of [undefined, '', '0', '-1', '3601', '2.5', 'NaN', false, null]) {
    assert.equal(read().standbySeconds, 60)
    assert.equal(read({ standbySeconds: 30 }).standbySeconds, 30)
    assert.equal(read({ standbySeconds: 0 }).standbySeconds, 60)
  }
})

test('OpenAI defaults come from the host manifest; saved overrides are read on every start', () => {
  const defaults = JSON.parse(
    readFileSync(new URL('../../../host/app/manifest_openai_live_settings.json', import.meta.url)),
  ).config.openaiLive
  const saved = new Map()
  const read = () => readLiveSettings(defaults, (domain, key) => saved.get(`${domain}.${key}`))
  assert.equal(read().backendModel, defaults.backendModel)
  assert.equal(read().reasoningEffort, defaults.reasoningEffort)
  saved.set('openailive.backendModel', '  saved-backend  ')
  for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
    saved.set('openailive.reasoningEffort', effort)
    assert.equal(read().backendModel, 'saved-backend')
    assert.equal(read().reasoningEffort, effort)
    assert.equal(read().model, defaults.model)
    assert.deepEqual(read().tools, defaults.tools)
  }
  for (const invalid of [undefined, '', '  ', 42, 'unsupported']) {
    saved.set('openailive.backendModel', invalid === 'unsupported' ? '' : invalid)
    saved.set('openailive.reasoningEffort', invalid)
    assert.equal(read().backendModel, defaults.backendModel)
    assert.equal(read().reasoningEffort, defaults.reasoningEffort)
  }
})

test('nested read-only defaults become independent mutable session data', () => {
  const domains = Object.freeze(['example.com'])
  const filters = Object.freeze({ allowed_domains: domains })
  const tools = Object.freeze([Object.freeze({ type: 'web_search', filters })])
  const defaults = Object.freeze({ tools, instructions: '' })
  const first = readLiveSettings(defaults, () => undefined)
  const second = readLiveSettings(defaults, () => undefined)
  assert.deepEqual(first.tools, defaults.tools)
  first.tools[0].filters.allowed_domains.push('other.example')
  assert.deepEqual(second.tools, defaults.tools)
  assert.equal(defaults.tools[0].filters.allowed_domains.length, 1)
  assert.doesNotThrow(() => JSON.stringify(first))
})

test('saved credentials and context are read afresh; deleting the key disables starting', () => {
  const values = new Map([
    ['ai.token', '  saved-key  '],
    ['ai.context', ' Krótko po polsku. '],
    ['tts.volume', '0.35'],
  ])
  const defaults = { apiKey: '', instructions: 'default', volume: 0.1 }
  const read = () => readLiveSettings(defaults, (domain, key) => values.get(`${domain}.${key}`))
  assert.deepEqual(read(), {
    apiKey: 'saved-key',
    instructions: 'Krótko po polsku.',
    volume: 0.35,
    bargeIn: false,
    voice: 'marin',
    pitch: 0,
    style: 'default',
    standbySeconds: 60,
  })
  values.set('ai.token', '')
  values.set('ai.context', '')
  assert.equal(read().apiKey, '')
  assert.equal(read().instructions, 'default')
  assert.equal(defaults.apiKey, '')
})

test('stored volume is bounded and invalid or absent values preserve the default', () => {
  for (const [stored, expected] of [
    [undefined, 0.1],
    ['', 0.1],
    ['invalid', 0.1],
    ['Infinity', 0.1],
    ['-1', 0],
    ['2', 1],
    ['0', 0],
  ]) {
    const result = readLiveSettings({ volume: 0.1 }, (domain) => (domain === 'tts' ? stored : undefined))
    assert.equal(result.volume, expected)
  }
})

test('backend settings and hosted search are forwarded without adding instructions', async () => {
  let options, volume
  const session = new LiveSession({
    Conversation: class {
      constructor(value) {
        options = value
      }
      setVolume(value) {
        volume = value
      }
      async connect() {}
      async close() {
        return { finalized: true }
      }
    },
    audio: { acquireExclusive: () => () => {} },
    networkReady: Promise.resolve({ status: 'connected' }),
    acquireLowLatency: () => ({ close() {} }),
    amp: {},
    Timer: { set() {}, clear() {} },
    settings: readLiveSettings(
      {
        backendModel: 'gpt-6.1-terra',
        reasoningEffort: 'medium',
        instructions: '',
        volume: 1,
        tools: [{ type: 'web_search' }],
      },
      (domain, key) => (domain === 'ai' && key === 'token' ? 'test-only' : undefined),
    ),
    onState() {},
  })
  assert.equal(await session.start(), true)
  assert.deepEqual(options.delegation, {
    type: 'responses',
    responses: {
      model: 'gpt-6.1-terra',
      reasoning: { effort: 'medium' },
      tools: [{ type: 'web_search' }],
      tool_choice: 'auto',
    },
  })
  assert.equal(options.instructions, '')
  assert.equal(volume, 1)
  await session.stop()
})

test('voice, pitch and style reload saved values and recover from invalid storage', () => {
  const defaults = { voice: 'marin', pitch: 0, style: 'default', instructions: 'Mów po polsku.' }
  const saved = new Map()
  const read = () => readLiveSettings(defaults, (domain, key) => saved.get(`${domain}.${key}`))
  saved.set('openailive.voice', 'cedar')
  saved.set('openailive.pitch', '-4')
  saved.set('openailive.style', 'calm')
  assert.equal(read().voice, 'cedar')
  assert.equal(read().pitch, -4)
  assert.ok(read().instructions.startsWith(defaults.instructions))
  assert.notEqual(read().instructions, defaults.instructions)
  saved.set('openailive.style', 'default')
  assert.equal(read().instructions, defaults.instructions)
  for (const value of ['', 'invalid', null, false, 7, -7, 0.5]) {
    for (const key of ['voice', 'pitch', 'style']) saved.set(`openailive.${key}`, value)
    const result = read()
    assert.equal(result.voice, defaults.voice)
    assert.equal(result.pitch, defaults.pitch)
    assert.equal(result.style, defaults.style)
    assert.equal(result.instructions, defaults.instructions)
  }
})
