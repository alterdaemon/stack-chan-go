import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isLivePitch,
  isLiveVoicePreference,
  liveStyleInstructions,
  OPENAI_LIVE_STYLES,
  OPENAI_LIVE_VOICES,
} from './openai-live-options.js'

test('every offered voice and style is writable; unrecognized values are rejected', () => {
  assert.equal(new Set(OPENAI_LIVE_VOICES).size, OPENAI_LIVE_VOICES.length)
  for (const voice of OPENAI_LIVE_VOICES) assert.ok(isLiveVoicePreference('openailive.voice', voice))
  for (const style of OPENAI_LIVE_STYLES) assert.ok(isLiveVoicePreference('openailive.style', style))
  for (const value of [undefined, null, '', 'unknown', 0, false, {}, []]) {
    assert.equal(isLiveVoicePreference('openailive.voice', value), false)
    assert.equal(isLiveVoicePreference('openailive.style', value), false)
  }
})

test('pitch accepts whole semitones over both preference transports', () => {
  for (let pitch = -6; pitch <= 6; pitch++) {
    assert.ok(isLivePitch(pitch))
    assert.ok(isLivePitch(String(pitch)))
  }
  for (const value of [undefined, null, false, true, [], {}, '', ' ', NaN, Infinity, -7, 7, 0.5, 'invalid'])
    assert.equal(isLivePitch(value), false)
})

test('default style preserves context exactly; selected styles add delivery without mutating it', () => {
  const context = 'Mów po polsku. Give one step at a time.'
  assert.equal(liveStyleInstructions(context, 'default'), context)
  assert.equal(liveStyleInstructions(context, 'unknown'), context)
  const variants = ['calm', 'expressive'].map((style) => liveStyleInstructions(context, style))
  for (const value of variants) {
    assert.ok(value.startsWith(`${context}\n`))
    assert.ok(value.length > context.length)
  }
  assert.notEqual(...(variants as [string, string]))
})
