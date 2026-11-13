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
