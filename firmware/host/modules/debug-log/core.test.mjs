import assert from 'node:assert/strict'
import test from 'node:test'
import { CommandParser, DebugRecorder, LEASE_MS, PREFIX, safeFields } from './core.js'

function fixture() {
  let time = 0,
    seq = 0,
    writable = true,
    snapshots = 0
  const lines = [],
    changes = []
  const recorder = new DebugRecorder({
    now: () => time,
    stamp: () => ({ ms: time, seq: ++seq }),
    info: () => ({ firmware: '2.1.0-R3', app_sha256: 'a'.repeat(64) }),
    change: (value) => changes.push(value),
    snapshot: () => snapshots++,
    write(line) {
      if (!writable) return false
      lines.push(JSON.parse(line.slice(PREFIX.length)))
      return true
    },
  })
  return {
    recorder,
    lines,
    changes,
    get snapshots() {
      return snapshots
    },
    time(value) {
      time = value
    },
    writable(value) {
      writable = value
    },
  }
}

test('Off skips payload construction; only USB on records; disable/reboot discard state', () => {
  const f = fixture()
  f.recorder.emit('device', 'event', () => {
    throw new Error('must not evaluate')
  })
  assert.equal(f.lines.length, 0)
  f.recorder.command('diag status')
  assert.equal(f.lines.at(-1).enabled, false)
  f.recorder.command('diag on')
  f.recorder.command('diag on')
  assert.equal(f.recorder.enabled, true)
  assert.equal(f.snapshots, 1)
  f.recorder.emit('device', 'event', { phase: 'ready' })
  assert.equal(f.lines.at(-1).phase, 'ready')
  f.recorder.command('diag off')
  assert.equal(f.recorder.enabled, false)
  assert.equal(fixture().recorder.enabled, false)
})

test('disconnect and expired host lease disable recording; keepalive cannot enable it', () => {
  for (const disconnect of [false, true]) {
    const f = fixture()
    f.recorder.command('diag keepalive')
    assert.equal(f.recorder.enabled, false)
    f.recorder.command('diag on')
    f.time(LEASE_MS - 1)
    f.recorder.command('diag keepalive')
    f.time(LEASE_MS + 1)
    f.recorder.tick()
    assert.equal(f.recorder.enabled, true)
    f.time(2 * LEASE_MS)
    f.recorder.tick(!disconnect)
    assert.equal(f.recorder.enabled, false)
    assert.equal(f.recorder.queuedCharacters, 0)
  }
})

test('a transient USB connection indication retains trials; sustained disconnect disables with a reason', () => {
  const f = fixture()
  f.recorder.command('diag on')
  f.time(100)
  f.recorder.tick(false)
  f.time(400)
  f.recorder.tick(true)
  assert.equal(f.recorder.enabled, true)
  f.time(500)
  f.recorder.tick(false)
  f.time(999)
  f.recorder.tick(false)
  assert.equal(f.recorder.enabled, true)
  f.time(1000)
  f.recorder.tick(false)
  assert.equal(f.recorder.enabled, false)
  f.recorder.command('diag status')
  assert.equal(f.lines.at(-1).reason, 'usb_disconnected')
  f.recorder.command('diag on')
  assert.equal(f.lines.at(-1).reason, undefined)
})

test('parser accepts fragmentation and discards invalid and oversized lines through newline', () => {
  const lines = [],
    parser = new CommandParser((line) => lines.push(line))
  const bytes = (text) => new TextEncoder().encode(text)
  parser.feed(bytes('diag o'))
  parser.feed(bytes('n\r\n'))
  parser.feed(bytes('x'.repeat(20000) + 'diag on\n'))
  parser.feed(bytes('diag on\0\n'))
  parser.feed(bytes('diag status\n'))
  assert.deepEqual(lines, ['diag on', undefined, undefined, 'diag status'])
  const f = fixture()
  for (const line of ['eval hello', 'diag verbose', undefined, 'diag off extra']) f.recorder.command(line)
  assert.equal(f.recorder.enabled, false)
  assert.ok(f.lines.every((line) => line.action === 'invalid_command'))
})

test('slow readers have bounded memory, counted losses and no synchronous wait', () => {
  const f = fixture()
  f.recorder.command('diag on')
  f.writable(false)
  for (let i = 0; i < 20000; i++) f.recorder.emit('device', 'event', { request: i })
  assert.ok(f.recorder.queuedCharacters <= 4096)
  assert.ok(f.recorder.dropped > 0)
  f.writable(true)
  for (let i = 0; i < 20; i++) f.recorder.pump()
  f.recorder.command('diag status')
  assert.equal(f.lines.at(-1).dropped, f.recorder.dropped)
  f.writable(false)
  f.recorder.emit('device', 'event')
  f.recorder.disable()
  assert.equal(f.recorder.queuedCharacters, 0)
})

test('safe metadata omits raw messages, credentials, transcripts, tool content and nonfinite values', () => {
  assert.deepEqual(
    safeFields({
      phase: 'ready',
      status: 403,
      bargeIn: true,
      errorCode: 'permission_denied',
      message: 'private text',
      apiKey: 'sk-proj-private',
      password: 'private',
      transcript: 'private words',
      arguments: 'private query',
      output: 'private result',
      reason: 'sk-proj-private',
      item_id: 'Bearer-private',
      freeHeap: NaN,
    }),
    { phase: 'ready', status: 403, bargeIn: true, errorCode: 'permission_denied' },
  )
})

test('native event stamps survive deferred export instead of using host arrival time', () => {
  const f = fixture()
  f.time(200)
  f.recorder.command('diag on')
  f.recorder.emit('audio', 'flush.end', { request: 3 }, { ms: 150, seq: 12 })
  assert.equal(f.lines.at(-1).ms, 150)
  assert.equal(f.lines.at(-1).seq, 12)
})

test('capture trim metadata cannot overwrite the diagnostic session identifier', () => {
  const f = fixture()
  f.recorder.platform.info = () => ({ captureDb: -6 })
  f.recorder.command('diag on')
  assert.equal(f.lines.at(-1).capture, 1)
  assert.equal(f.lines.at(-1).captureDb, -6)
  f.recorder.emit('device', 'snapshot', { captureDb: -6 })
  assert.equal(f.lines.at(-1).capture, 1)
  assert.equal(f.lines.at(-1).captureDb, -6)
})

test('USB trials require enable, validate bounds and settle only after the requested change', async () => {
  const f = fixture(),
    applied = []
  f.recorder.platform.tune = async (name, value) => {
    applied.push([name, value])
  }
  f.recorder.command('diag set speaker 0')
  await Promise.resolve()
  assert.equal(applied.length, 0)
  f.recorder.command('diag on')
  for (const command of [
    'diag set vad 1',
    'diag set silence 10',
    'diag set noise arbitrary',
    'diag set capture 5',
    'diag set nlp 3',
    'diag set speaker ',
  ])
    f.recorder.command(command)
  assert.equal(applied.length, 0)
  for (const command of [
    'diag set speaker 0',
    'diag set capture -12',
    'diag set nlp 2',
    'diag set vad 0.6',
    'diag set silence 1000',
    'diag set noise near_field',
    'diag reset',
  ]) {
    f.recorder.command(command)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    assert.equal(f.lines.at(-1).phase, 'applied')
  }
  assert.equal(applied.length, 7)
})

test('a trial cannot run after its USB session ends or report success in a later capture', async () => {
  const f = fixture()
  let calls = 0
  f.recorder.platform.tune = async () => {
    calls++
  }
  f.recorder.command('diag on')
  f.recorder.command('diag set speaker 0')
  f.recorder.command('diag off')
  f.recorder.command('diag on')
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.equal(calls, 0)
  assert.equal(
    f.lines.some((r) => r.phase === 'applied'),
    false,
  )
})
