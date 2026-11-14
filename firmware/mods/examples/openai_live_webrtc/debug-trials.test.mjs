import assert from 'node:assert/strict'
import test from 'node:test'
import { trialInput, trialPreferences } from './debug-trials.js'

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

test('explicit USB connection overlay is RAM only and fixed input preserves Unicode', () => {
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
  assert.equal(trialInput(), undefined)
  assert.equal(trialInput({ prompt: 'arbitrary' }), undefined)
  assert.match(trialInput({ prompt: 'polish' })[0].content[0].text, /Cześć/)
  assert.match(trialInput({ prompt: 'english' })[0].content[0].text, /voice test/)
})
