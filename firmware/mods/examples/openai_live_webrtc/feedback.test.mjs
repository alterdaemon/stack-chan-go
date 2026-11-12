import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationFeedback } from './feedback.js'

function fixture(bargeIn = true, motion) {
  let now = 0,
    audible = 0
  const colors = [],
    entry = { backend: new Map(), conversation: { muted: false }, inputUntil: 0 }
  const feedback = new ConversationFeedback({
    entry,
    bargeIn,
    motion,
    now: () => now,
    led: { on: (...rgb) => colors.push(rgb), off: () => colors.push([0, 0, 0]) },
  })
  return {
    feedback,
    entry,
    colors,
    tick(time, progress = 0, extra = {}) {
      now = time
      audible += progress
      feedback.tick({ audibleMs: audible, outputIdleMs: 10000, ...extra })
    },
  }
}

test('fixed colors reflect confirmed activity, coalesce bursts and never rewrite a stable color', () => {
  const f = fixture(false)
  f.tick(0)
  assert.deepEqual(f.colors.at(-1), [0, 19, 6])
  f.entry.inputUntil = Infinity
  for (let i = 1; i < 100; i++) f.tick(i)
  assert.deepEqual(f.colors, [
    [0, 19, 6],
    [0, 75, 25],
  ])
  f.entry.inputUntil = 1000
  f.tick(1000)
  assert.deepEqual(f.colors.at(-1), [0, 19, 6])
  f.entry.responseId = 'r'
  f.entry.searchId = 's'
  f.tick(1100)
  assert.deepEqual(f.colors.at(-1), [50, 15, 85])
  f.entry.responseId = undefined
  f.tick(1200)
  assert.equal(f.colors.length, 4, 'pending search retains purple')
  f.tick(1300, 20)
  assert.deepEqual(f.colors.at(-1), [0, 45, 95])
  f.tick(1699)
  assert.equal(f.colors.length, 5, 'word gaps retain speaking')
  f.tick(5000)
  assert.deepEqual(f.colors.at(-1), [50, 15, 85], 'delayed tick expires once without catch-up')
  f.entry.searchId = undefined
  f.tick(5100, 0, { outputIdleMs: 0 })
  assert.deepEqual(f.colors.at(-1), [0, 0, 0])
  assert.equal(f.entry.inputUntil, 0)
  f.tick(5200)
  assert.deepEqual(f.colors.at(-1), [0, 19, 6])
  f.entry.conversation.muted = true
  f.tick(5300)
  assert.deepEqual(f.colors.at(-1), [0, 0, 0])
  f.feedback.close()
  const count = f.colors.length
  f.tick(5400, 100)
  assert.equal(f.colors.length, count, 'closed feedback cannot relight')
})

test('interrupted in-flight audio and a rapidly resumed first sample only rebase playback', () => {
  const f = fixture()
  f.tick(0, 100)
  f.tick(100, 20)
  assert.deepEqual(f.colors.at(-1), [0, 45, 95])
  f.feedback.interrupt()
  f.tick(200, 20)
  assert.deepEqual(f.colors.at(-1), [0, 19, 6], 'first resumed sample is baseline-only')
  f.tick(300, 20, { outputSuppressed: true })
  f.tick(400, 20)
  assert.deepEqual(f.colors.at(-1), [0, 19, 6])
  f.tick(500, 20)
  assert.deepEqual(f.colors.at(-1), [0, 45, 95])
})

test('sustained speech permits one small gesture, returns smoothly and releases torque', () => {
  const calls = [],
    rotation = { y: 0.2, p: -0.7, r: 0 }
  let current = true,
    acquisitions = 0
  const handle = {
    rotation,
    valid: () => current,
    move: (target, time, done) => {
      calls.push({ target, time })
      done()
    },
    release: (done) => {
      calls.push('release')
      done()
    },
    cancel: () => {
      current = false
      calls.push('cancel')
    },
  }
  const f = fixture(true, {
    trySpeakingMotion(done) {
      acquisitions++
      done(handle)
    },
  })
  f.tick(0)
  for (let t = 100; t <= 2100; t += 100) f.tick(t, 100)
  assert.equal(acquisitions, 1)
  assert.equal(calls.length, 1)
  assert.ok(Math.abs(calls[0].target.p - rotation.p) <= Math.PI / 60 + 1e-12)
  assert.ok(Math.abs(calls[0].target.y - rotation.y) <= Math.PI / 45 + 1e-12)
  assert.equal(calls[0].time, 0.5)
  f.tick(2600)
  assert.deepEqual(calls[1].target, rotation, 'normal end only returns to starting pose')
  f.tick(3100)
  assert.equal(calls[2], 'release')
  assert.equal(calls.length, 4)
})

test('cancellation invalidates delayed motion reads and callbacks without a return sweep', () => {
  let acquire,
    guard,
    cancelled = 0
  const f = fixture(true, {
    trySpeakingMotion(done, current) {
      acquire = done
      guard = current
    },
  })
  f.tick(0)
  for (let t = 100; t <= 2100; t += 100) f.tick(t, 100)
  assert.equal(guard(), true)
  f.feedback.close()
  assert.equal(guard(), false, 'close guards even an acquisition still reading the first axis')
  acquire({
    cancel() {
      cancelled++
    },
  })
  assert.equal(cancelled, 1)
})

test('delayed pose acquisition does not shorten the minimum spacing between gesture starts', () => {
  let acquire
  const moves = []
  const f = fixture(true, {
    trySpeakingMotion(done) {
      acquire = done
    },
  })
  const motion = {
    rotation: { y: 0, p: -0.7, r: 0 },
    valid: () => true,
    move(target, _time, done) {
      moves.push({ time: f.feedback.now(), target })
      done()
      return true
    },
    release(done) {
      done()
    },
    cancel() {},
  }
  f.tick(0)
  for (let t = 100; t <= 2100; t += 100) f.tick(t, 100)
  f.tick(2400, 100)
  acquire(motion)
  for (let t = 2500; t < 4400; t += 100) f.tick(t, 100)
  assert.equal(moves.length, 2, 'only the first target and its baseline return occur before two seconds')
  f.tick(6000, 100)
  assert.ok(moves[2].time - moves[0].time >= 2000)
})

test('hardware failure disables only the failed channel and missing hardware stays usable', () => {
  const f = fixture()
  f.feedback.led = {
    on() {
      throw new Error('I2C unavailable')
    },
  }
  f.tick(0)
  f.tick(100, 10)
  assert.equal(f.feedback.led, undefined)
  f.feedback.close()
})
