import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveSession } from './session.js'
import { readLiveSettings } from './settings.js'

test('saved credentials and context are read afresh; deleting the key disables starting', () => {
  const values = new Map([
    ['ai.token', '  saved-key  '],
    ['ai.context', ' Krótko po polsku. '],
    ['tts.volume', '0.35'],
  ])
  const defaults = { apiKey: '', instructions: 'default', volume: 0.1 }
  const read = () => readLiveSettings(defaults, (domain, key) => values.get(`${domain}.${key}`))
  assert.deepEqual(read(), { apiKey: 'saved-key', instructions: 'Krótko po polsku.', volume: 0.35 })
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
