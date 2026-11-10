import assert from 'node:assert/strict'
import test from 'node:test'
import { formatLiveError, LiveSession } from './session.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
function fixture(overrides = {}) {
  const states = [],
    diagnostics = [],
    events = [],
    instances = []
  let connecting, closing, mute
  let ticks = 0
  const timers = new Map()
  class Conversation {
    constructor(options) {
      this.options = options
      instances.push(this)
    }
    setVolume(value) {
      this.volume = value
    }
    async connect() {
      if (connecting) await connecting.promise
    }
    async close() {
      events.push('native closing')
      const result = closing ? await closing.promise : undefined
      connecting?.reject(new Error('cancelled'))
      events.push('native closed')
      return result ?? { finalized: true }
    }
    async setMuted(value) {
      if (mute) await mute.promise
      this.muted = value
    }
    activity = { capturedSamples: 0, inputActivity: 0, audibleMs: 0 }
    get stats() {
      return { ...this.activity }
    }
  }
  const session = new LiveSession({
    Conversation,
    audio: {
      acquireExclusive() {
        events.push('audio acquired')
        return () => events.push('audio released')
      },
    },
    networkReady: Promise.resolve({ status: 'connected' }),
    acquireLowLatency() {
      events.push('radio acquired')
      return { close: () => events.push('radio released') }
    },
    amp: {
      set sampleRate(value) {
        events.push(`amp ${value}`)
      },
    },
    settings: { apiKey: 'unit-test-only', volume: 0.1, model: 'gpt-live-1', voice: 'marin' },
    onState: (state, detail) => {
      states.push(state)
      if (detail) diagnostics.push(detail)
    },
    Timer: {
      set(callback, delay) {
        const id = {}
        timers.set(id, { callback: () => callback(id), delay, deadline: ticks + delay })
        return id
      },
      clear(id) {
        timers.delete(id)
      },
    },
    ...overrides,
  })
  return {
    session,
    states,
    diagnostics,
    events,
    instances,
    timers,
    tick(milliseconds = 1000, capture = true) {
      ticks += milliseconds
      if (capture) for (const instance of instances) instance.activity.capturedSamples += 16000
      for (const [id, timer] of [...timers]) {
        if (ticks < timer.deadline) continue
        timers.delete(id)
        timer.callback()
      }
    },
    connectPending() {
      connecting = deferred()
      return connecting
    },
    closePending() {
      closing = deferred()
      return closing
    },
    mutePending() {
      mute = deferred()
      return mute
    },
  }
}

test('empty key and unavailable network never acquire audio or create a session', async () => {
  for (const overrides of [{ settings: { apiKey: '' } }, { networkReady: Promise.resolve({ status: 'skipped' }) }]) {
    const f = fixture(overrides)
    assert.equal(await f.session.start(), false)
    assert.equal(f.instances.length, 0)
    assert.deepEqual(f.events, [])
    assert.equal(f.session.active, undefined)
  }
})

test('interruption settings apply only to the next start and preserve user instructions', async () => {
  const f = fixture()
  f.session.settings.instructions = 'Answer in Polish.'
  await f.session.start()
  assert.equal(f.instances[0].options.bargeIn, false)
  assert.equal(f.instances[0].options.instructions, 'Answer in Polish.')
  f.session.settings.bargeIn = true
  assert.equal(f.instances[0].options.bargeIn, false)
  await f.session.stop()
  await f.session.start()
  assert.equal(f.instances[1].options.bargeIn, true)
  assert.ok(f.instances[1].options.instructions.startsWith('Answer in Polish.'))
  assert.ok(f.instances[1].options.instructions.length > f.instances[0].options.instructions.length)
  await f.session.stop()
})
test('start, acknowledged mute and close reuse Conversation and release only after native close', async () => {
  const f = fixture()
  f.session.settings.backendModel = 'test-backend-model'
  assert.equal(await f.session.start(), true)
  assert.equal(f.instances[0].volume, 0.1)
  assert.equal(f.instances[0].options.model, 'gpt-live-1')
  assert.deepEqual(f.instances[0].options.delegation, {
    type: 'responses',
    responses: { model: f.session.settings.backendModel },
  })
  assert.equal(await f.session.setMuted(true), true)
  const closing = f.closePending()
  const stop = f.session.stop()
  assert.equal(stop, f.session.stop())
  assert.equal(f.session.start(), f.session.active.starting)
  assert.ok(!f.events.includes('audio released'))
  closing.resolve()
  await stop
  assert.deepEqual(f.events, [
    'audio acquired',
    'radio acquired',
    'amp 48000',
    'native closing',
    'native closed',
    'amp 24000',
    'radio released',
    'audio released',
  ])
  assert.equal(f.session.active, undefined)
  assert.equal(f.states.at(-1), 'idle')
  assert.equal(await f.session.start(), true)
  assert.equal(f.instances.length, 2)
  await f.session.stop()
})
test('cancellation while Wi-Fi is pending cannot create a paid session after restart', async () => {
  const ready = deferred(),
    f = fixture({ networkReady: ready.promise })
  const old = f.session.start()
  await f.session.stop()
  const current = f.session.start()
  ready.resolve({ status: 'connected' })
  assert.equal(await old, false)
  assert.equal(await current, true)
  assert.equal(f.instances.length, 1)
  await f.session.stop()
})
test('stop during connection waits for native shutdown before a fresh start', async () => {
  const f = fixture(),
    connecting = f.connectPending(),
    closing = f.closePending()
  const start = f.session.start()
  await Promise.resolve()
  const stop = f.session.stop()
  assert.ok(f.session.active)
  assert.ok(!f.events.includes('audio released'))
  closing.resolve()
  await stop
  assert.equal(await start, false)
  connecting.promise.catch(() => {})
  assert.equal(f.session.active, undefined)
})
test('transport errors and remote close release audio/radio and permit manual reconnect', async () => {
  for (const event of ['error', 'closed']) {
    const f = fixture()
    await f.session.start()
    if (event === 'error') f.instances[0].options.onError(new Error('private provider detail'))
    else f.instances[0].options.onStateChanged('closed')
    await f.session.stop()
    assert.equal(f.session.active, undefined)
    assert.equal(f.events.filter((e) => e === 'audio released').length, 1)
    assert.equal(f.states.at(-1), event === 'error' ? 'error' : 'idle')
    await f.session.start()
    await f.session.stop()
  }
})
test('failed radio acquisition and cleanup errors never retain the audio owner', async () => {
  const f = fixture({
    acquireLowLatency() {
      throw new Error('radio')
    },
  })
  assert.equal(await f.session.start(), false)
  assert.deepEqual(f.events, ['audio acquired', 'audio released'])
  assert.equal(f.session.active, undefined)
  const g = fixture({
    amp: {
      set sampleRate(rate) {
        if (rate === 24000) throw new Error('amp')
      },
    },
  })
  await g.session.start()
  await g.session.stop()
  assert.ok(g.events.includes('radio released'))
  assert.ok(g.events.includes('audio released'))
  assert.equal(g.states.at(-1), 'error')
})
test('a late failed mute from a closed session cannot close its replacement', async () => {
  const f = fixture()
  await f.session.start()
  const pending = f.mutePending(),
    muting = f.session.setMuted(true)
  await f.session.stop()
  await f.session.start()
  pending.reject(new Error('old mute timeout'))
  assert.equal(await muting, false)
  assert.equal(f.session.active.conversation, f.instances[1])
  await f.session.stop()
})

test('late error/closed callbacks from an old session cannot stop its replacement', async () => {
  const f = fixture()
  await f.session.start()
  const old = f.instances[0]
  await f.session.stop()
  await f.session.start()
  old.options.onError(new Error('late hangup failure'))
  old.options.onStateChanged('closed')
  assert.equal(f.session.active.conversation, f.instances[1])
  assert.equal(f.states.at(-1), 'connected')
  await f.session.stop()
})

test('startup failures expose status and safe identifiers without exception messages', async () => {
  const f = fixture(),
    pending = f.connectPending()
  const starting = f.session.start()
  await Promise.resolve()
  pending.reject(
    Object.assign(new Error('private body with sk-proj-secret'), {
      code: 'http_error',
      stage: 'signaling',
      status: 403,
      providerCode: 'model_not_found',
      param: 'session.delegation.responses.model',
    }),
  )
  assert.equal(await starting, false)
  assert.deepEqual(f.diagnostics.at(-1), {
    code: 'http_error',
    stage: 'signaling',
    site: 'connect_wait',
    status: 403,
    providerCode: 'model_not_found',
    param: 'session.delegation.responses.model',
  })
  const display = formatLiveError(f.diagnostics.at(-1))
  assert.ok(display.includes('HTTP 403'))
  assert.ok(display.includes('model_not_found'))
  assert.ok(!display.includes('private'))
  assert.ok(!display.includes('sk-proj-secret'))
  assert.equal(f.session.active, undefined)
})

test('the first provider failure survives subsequent close errors', async () => {
  const f = fixture()
  await f.session.start()
  const closing = f.closePending()
  f.instances[0].options.onError(
    Object.assign(new Error('private first error'), {
      code: 'responses_validation_failed',
      stage: 'events',
    }),
  )
  closing.reject(new Error('private later error'))
  await f.session.stop()
  assert.equal(f.diagnostics.at(-1).code, 'responses_validation_failed')
})

test('local audio failures identify the failed operation and still release resources', async () => {
  const f = fixture({
    audio: {
      acquireExclusive() {
        throw new Error('private audio failure')
      },
    },
  })
  assert.equal(await f.session.start(), false)
  assert.deepEqual(f.diagnostics.at(-1), { code: 'operation_failed', stage: 'audio', site: 'audio_acquire' })
  assert.equal(f.instances.length, 0)
})

test('unsafe diagnostic fields are rejected and a new start discards old diagnostics', async () => {
  const f = fixture()
  await f.session.start()
  f.instances[0].options.onError({
    code: 'sk_proj_secret',
    stage: 'sk-proj-secret',
    status: Infinity,
    providerCode: 'sk-proj-secret',
    param: 'sk_proj_secret',
  })
  await f.session.stop()
  assert.deepEqual(f.diagnostics.at(-1), { code: 'operation_failed', stage: 'events', site: 'event_on_error' })
  await f.session.start()
  await f.session.stop()
  assert.equal(f.states.at(-1), 'idle')
})

test('constructor failure reports an exact site, exception type and safe reason', async () => {
  const f = fixture({
    Conversation: class {
      constructor() {
        throw Object.assign(new TypeError('read only value (in stringify)'), { site: 'core_delegation' })
      }
    },
  })
  assert.equal(await f.session.start(), false)
  const detail = f.diagnostics.at(-1)
  assert.deepEqual(detail, {
    stage: 'configuration',
    code: 'readonly_json',
    site: 'core_delegation',
    kind: 'TypeError',
  })
  const display = formatLiveError(detail)
  for (const value of ['R4', 'readonly_json', 'core_delegation', 'TypeError']) assert.ok(display.includes(value))
  assert.equal(f.events.at(-1), 'audio released')
})

test('chosen voice, local pitch and composed style reach each new conversation', async () => {
  const f = fixture({
    settings: { apiKey: 'test-only', voice: 'cedar', pitch: 4, instructions: 'Polish. Speaking style: calm.' },
  })
  assert.equal(await f.session.start(), true)
  const conversation = f.instances[0]
  assert.equal(conversation.options.voice, 'cedar')
  assert.equal(conversation.options.pitch, 4)
  assert.equal(conversation.options.instructions, 'Polish. Speaking style: calm.')
  await f.session.stop()
})

test('one 60-second deadline closes once and exposes standby only after cleanup', async () => {
  const f = fixture()
  await f.session.start()
  assert.equal([...f.timers.values()][0].delay, 60000)
  const staleTick = [...f.timers.values()][0].callback
  f.tick(59000)
  assert.equal(f.states.at(-1), 'connected')
  const closing = f.closePending()
  f.tick()
  assert.equal(f.states.at(-1), 'closing')
  assert.equal(f.timers.size, 0)
  assert.ok(!f.events.includes('audio released'))
  staleTick()
  assert.equal(f.events.filter((event) => event === 'native closing').length, 1)
  closing.resolve()
  await f.session.stop()
  assert.equal(f.states.at(-1), 'standby')
  assert.equal(f.session.active, undefined)
  assert.deepEqual(f.events.slice(-4), ['native closed', 'amp 24000', 'radio released', 'audio released'])
  assert.equal(await f.session.start(), true)
  staleTick()
  assert.equal(f.states.at(-1), 'connected')
  await f.session.stop()
  assert.equal(f.timers.size, 0)
})

test('only nonblank robot words restart the whole interval; incoming words and raw audio do not', async () => {
  const f = fixture()
  await f.session.start()
  f.tick(59000)
  const { options, activity } = f.instances[0]
  options.onTranscript({ role: 'assistant', delta: 'Hello.' })
  f.tick(59000)
  options.onTranscript({ role: 'user', delta: 'Microphone hears me.' })
  options.onTranscript({ role: 'assistant', delta: ' \n ' })
  options.onEvent({ type: 'session.usage.updated', usage: { seconds: 120 } })
  activity.inputActivity++
  activity.audibleMs++
  assert.equal(f.states.at(-1), 'connected')
  f.tick(999)
  assert.equal(f.states.at(-1), 'connected')
  f.tick(1)
  await f.session.stop()
  assert.equal(f.states.at(-1), 'standby')
  assert.equal(f.timers.size, 0)
})

test('standby deadline is identical for every Pitch/Interruption combination and never reads media stats', async () => {
  for (const bargeIn of [false, true]) {
    for (let pitch = -6; pitch <= 6; pitch++) {
      const f = fixture({ settings: { apiKey: 'test-only', pitch, bargeIn } })
      await f.session.start()
      Object.defineProperty(f.instances[0], 'stats', {
        get() {
          throw new Error('Standby must not poll PCM')
        },
      })
      assert.equal(f.instances[0].options.pitch, pitch)
      assert.equal(f.instances[0].options.bargeIn, bargeIn)
      f.tick(59999)
      assert.equal(f.states.at(-1), 'connected')
      f.tick(1)
      await f.session.stop()
      assert.equal(f.states.at(-1), 'standby')
      assert.ok(f.events.includes('audio released'))
    }
  }
})

test('saved timeout applies on the next start, including resume', async () => {
  const f = fixture()
  f.session.settings.standbySeconds = 7
  await f.session.start()
  f.session.settings.standbySeconds = 12
  f.tick(6999)
  assert.equal(f.states.at(-1), 'connected')
  f.tick(1)
  await f.session.stop()
  assert.equal(f.states.at(-1), 'standby')
  await f.session.start()
  f.tick(11999)
  assert.equal(f.states.at(-1), 'connected')
  f.tick(1)
  await f.session.stop()
  assert.equal(f.states.at(-1), 'standby')
})

test('overlapping backend tasks block standby through quiet reasoning and every terminal outcome releases them', async () => {
  for (const terminal of ['completed', 'failed', 'incomplete', 'cancelled']) {
    const f = fixture()
    await f.session.start()
    const receive = f.instances[0].options.onEvent
    receive({ type: 'session.delegation.created', delegation: { id: 'a' } })
    receive({ type: 'response.event', delegation_id: 'a', event: { type: 'response.created' } })
    receive({ type: 'response.event', delegation_id: 'b', event: { type: 'response.created' } })
    f.tick(120000)
    assert.equal(f.states.at(-1), 'connected')
    receive({ type: 'response.event', delegation_id: 'a', event: { type: `response.${terminal}` } })
    f.tick(120000)
    assert.equal(f.states.at(-1), 'connected')
    receive({ type: 'response.event', delegation_id: 'b', event: { type: `response.${terminal}` } })
    f.tick(59000)
    assert.equal(f.states.at(-1), 'connected')
    f.tick()
    await f.session.stop()
    assert.equal(f.states.at(-1), 'standby')
  }
})

test('response IDs correlate backend work when the delegation ID is omitted', async () => {
  const f = fixture()
  await f.session.start()
  const receive = f.instances[0].options.onEvent
  receive({ type: 'response.event', event: { type: 'response.created', response: { id: 'response_1' } } })
  f.tick(120000)
  assert.equal(f.states.at(-1), 'connected')
  receive({ type: 'response.event', event: { type: 'response.completed', response: { id: 'response_1' } } })
  f.tick(60000)
  await f.session.stop()
  assert.equal(f.states.at(-1), 'standby')
})

test('a terminal response without delegation_id still releases a correlated delegation', async () => {
  const f = fixture()
  await f.session.start()
  const receive = f.instances[0].options.onEvent
  receive({ type: 'session.delegation.created', delegation: { id: 'del_1', response_id: 'response_1' } })
  receive({
    type: 'response.event',
    delegation_id: 'del_1',
    event: { type: 'response.created', response: { id: 'response_1' } },
  })
  f.tick(120000)
  assert.equal(f.states.at(-1), 'connected')
  receive({ type: 'response.event', event: { type: 'response.completed', response: { id: 'response_1' } } })
  f.tick(60000)
  await f.session.stop()
  assert.equal(f.states.at(-1), 'standby')
})

test('an open connection, user transcripts and usage heartbeats cannot extend the deadline', async () => {
  const f = fixture()
  await f.session.start()
  f.tick(59000)
  f.instances[0].options.onTranscript({ role: 'user', delta: 'hello' })
  f.instances[0].options.onEvent({ type: 'session.usage.updated', usage: { seconds: 90 } })
  f.tick()
  await f.session.stop()
  assert.equal(f.states.at(-1), 'standby')
})

test('standby resumes a fresh session with bounded RAM text, current settings and no replayed audio', async () => {
  const f = fixture()
  f.session.settings.instructions = 'Polish. Speaking style: calm.'
  f.session.settings.voice = 'cedar'
  f.session.settings.pitch = -4
  f.session.settings.bargeIn = true
  await f.session.start()
  const old = f.instances[0].options
  old.onTranscript({ role: 'user', delta: 'My order ' })
  old.onTranscript({ role: 'user', delta: 'is 42.' })
  old.onTranscript({ role: 'assistant', delta: 'I will remember.' })
  f.tick(60000)
  await f.session.stop()
  await f.session.start()
  const current = f.instances[1].options
  assert.deepEqual(current.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'My order is 42.' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will remember.' }] },
  ])
  assert.equal(current.voice, old.voice)
  assert.equal(current.pitch, old.pitch)
  assert.equal(current.instructions, old.instructions)
  assert.equal(current.bargeIn, old.bargeIn)
  old.onTranscript({ role: 'user', delta: 'stale text' })
  old.onEvent({ type: 'session.delegation.created', delegation: { id: 'stale_task' } })
  assert.ok(!JSON.stringify(f.session.history).includes('stale text'))
  f.tick(60000)
  await f.session.stop()
  assert.equal(f.states.at(-1), 'standby')
  await f.session.start()
  assert.deepEqual(f.instances[2].options.input, current.input, 'resume does not append the seed to itself')
  for (let i = 0; i < 100; i++)
    f.instances[2].options.onTranscript({ role: i % 2 ? 'assistant' : 'user', delta: `${i} ${'x'.repeat(1000)}` })
  f.instances[2].options.onTranscript({ role: 'assistant', delta: 'y'.repeat(100000) })
  f.tick(60000)
  await f.session.stop()
  await f.session.start()
  const input = f.instances[3].options.input
  assert.ok(input.length <= 6)
  assert.ok(input.reduce((size, message) => size + message.content[0].text.length, 0) <= 2048)
  assert.ok(input.at(-1).content[0].text.endsWith('y'.repeat(100)))
  await f.session.stop()
  assert.equal(f.session.history.length, 0, 'explicit stop clears the retained context')
  await f.session.start()
  assert.equal(f.instances[4].options.input, undefined)
  await f.session.stop()
})

test('many short turns evict old fragments without merging distinct speakers', async () => {
  const f = fixture()
  await f.session.start()
  for (let i = 0; i < 10; i++)
    f.instances[0].options.onTranscript({ role: i % 2 ? 'assistant' : 'user', delta: `turn ${i}` })
  assert.equal(f.session.history.length, 6)
  assert.equal(f.session.history[0].text, 'turn 4')
  assert.equal(f.session.history.at(-1).text, 'turn 9')
  await f.session.stop()
})

test('standby retains RAM history after a missing remote close acknowledgment, after local cleanup', async () => {
  const f = fixture()
  await f.session.start()
  f.tick(59000)
  assert.equal(f.states.at(-1), 'connected')
  const closing = f.closePending()
  f.tick()
  closing.resolve({ finalized: true })
  await f.session.stop()
  assert.equal(f.states.at(-1), 'standby')
  await f.session.start()
  f.instances.at(-1).options.onTranscript({ role: 'assistant', delta: 'retained context' })
  const failure = f.closePending()
  f.tick(60000)
  f.instances.at(-1).options.onError({ code: 'close_timeout', stage: 'close' })
  assert.equal(f.states.at(-1), 'closing')
  assert.ok(!f.events.slice(f.events.lastIndexOf('native closing')).includes('audio released'))
  failure.resolve({ finalized: false, reason: 'close_timeout' })
  await f.session.stop()
  assert.equal(f.states.at(-1), 'standby')
  assert.equal(f.session.history.at(-1).text, 'retained context')
  assert.equal(f.timers.size, 0)
  assert.ok(f.events.includes('audio released'))
  assert.equal(f.diagnostics.at(-1).code, 'close_timeout')
  await f.session.start()
  assert.equal(f.instances.at(-1).options.input.at(-1).content[0].text, 'retained context')
  await f.session.stop()
})

test('standby keeps cleanup failures visible and retains the bounded transcript for retry', async () => {
  for (const result of [{ finalized: false, reason: 'cleanup_error' }, new Error('native close failed')]) {
    const f = fixture()
    await f.session.start()
    f.instances[0].options.onTranscript({ role: 'user', delta: 'retained despite cleanup failure' })
    const closing = f.closePending()
    f.tick(60000)
    if (result instanceof Error) closing.reject(result)
    else closing.resolve(result)
    await f.session.stop()
    assert.equal(f.states.at(-1), 'error')
    assert.equal(f.session.history[0].text, 'retained despite cleanup failure')
  }
})

test('late transport errors during standby close preserve resume context at every Pitch with On/Off', async () => {
  for (const bargeIn of [false, true]) {
    for (let pitch = -6; pitch <= 6; pitch++) {
      for (const reason of ['close_timeout', 'connection_lost', 'transport_error']) {
        const f = fixture()
        Object.assign(f.session.settings, { bargeIn, pitch })
        await f.session.start()
        f.instances[0].options.onTranscript({ role: 'user', delta: 'context survives automatic close' })
        const closing = f.closePending()
        f.tick(60000)
        f.instances[0].options.onError({ code: reason, stage: 'transport' })
        f.instances[0].options.onStateChanged('error')
        closing.resolve({ finalized: false, reason })
        await f.session.stop()
        assert.equal(f.states.at(-1), 'standby')
        assert.equal(f.session.history[0].text, 'context survives automatic close')
        await f.session.start()
        assert.equal(f.instances[1].options.input[0].content[0].text, 'context survives automatic close')
        await f.session.stop()
        assert.equal(f.session.history.length, 0)
      }
    }
  }
})
