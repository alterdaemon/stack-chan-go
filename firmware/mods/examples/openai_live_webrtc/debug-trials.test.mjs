import assert from 'node:assert/strict'
import test from 'node:test'
import { trialPreferences } from './debug-trials.js'

test('USB overlay replaces only bounded session fields and never writes or invents credentials', () => {
  const calls = []
  const saved = (domain, key) => {
    calls.push(`${domain}.${key}`)
    return 'saved value'
  }
  assert.equal(trialPreferences(saved), saved)
  const get = trialPreferences(saved, {
    pitch: -6,
    volume: 0,
    standby: 1,
    style: 'calm',
    prompt: 'long',
    apiKey: 'ignored',
  })
  assert.equal(get('openailive', 'pitch'), -6)
  assert.equal(get('openailive', 'standbySeconds'), 1)
  assert.equal(get('openailive', 'style'), 'calm')
  assert.equal(get('tts', 'volume'), 0)
  assert.ok(get('ai', 'context').length > 4096)
  assert.ok(get('ai', 'context').length < 8192)
  assert.equal(get('openailive', 'auth'), 'saved value')
  assert.deepEqual(calls, ['openailive.auth'])
})

test('explicit USB connection overlay is RAM only and leaves saved selection unchanged', () => {
  const saved = new Map([
    ['openailive.auth', 'chatgpt'],
    ['openailive.mode', 'realtime-full'],
    ['ai.token', 'fixture-key'],
  ])
  const read = (d, k) => saved.get(`${d}.${k}`)
  const api = trialPreferences(read, { connection: 'api-live' })
  assert.equal(api('openailive', 'auth'), 'api-key')
  assert.equal(api('openailive', 'mode'), 'live')
  assert.equal(api('ai', 'token'), 'fixture-key')
  assert.equal(read('openailive', 'auth'), 'chatgpt')
  assert.equal(trialPreferences(read, { connection: 'invalid' })('openailive', 'auth'), 'chatgpt')
})

test('fixed persona trial exercises shared prompt without replacing saved text or volume', () => {
  const saved = (domain, key) => `${domain}.${key}`
  const get = trialPreferences(saved, { prompt: 'persona' })
  assert.match(get('ai', 'context'), /Tu Bursztyn/)
  assert.equal(get('tts', 'volume'), 'tts.volume')
  assert.equal(saved('ai', 'context'), 'ai.context')
  assert.equal(trialPreferences(saved)('ai', 'context'), 'ai.context')
})
