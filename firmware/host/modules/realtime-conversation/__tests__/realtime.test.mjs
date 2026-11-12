import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { LiveSession } from '../../../../mods/examples/openai_live_webrtc/session.js'
import ToolRunner from '../tools.js'
import { summarizeWebSearchResponse } from '../web-search.js'

let source = readFileSync(new URL('../core.js', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)))
for (const [name, path] of Object.entries(manifest.modules))
  source = source.replaceAll(`'${name}'`, `'${new URL(`../${path}.js`, import.meta.url).href}'`)
const { default: Conversation } = await import(`data:text/javascript,${encodeURIComponent(source)}`)
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

for (const protocol of ['live', 'realtime']) {
  for (const cancellation of ['local', 'server']) {
    test(`${protocol} ${cancellation} interrupted accepted tools return cancellation once without obsolete continuation`, async () => {
      let resolve,
        cancelled = 0
      const sent = [],
        timers = new Set()
      const runner = new ToolRunner(
        [
          {
            name: 'lookup',
            parameters: { type: 'object' },
            execute(_args, context) {
              context.onCancel(() => {
                cancelled++
              })
              return new Promise((done) => {
                resolve = done
              })
            },
          },
        ],
        {
          protocol,
          send: (event) => sent.push(event),
          platform: {
            setTimeout(fn) {
              const timer = { fn }
              timers.add(timer)
              return timer
            },
            clearTimeout(timer) {
              timers.delete(timer)
            },
          },
        },
      )
      const event = (value) =>
        runner.receive(protocol === 'live' ? { type: 'response.event', delegation_id: 'task', event: value } : value)
      event({ type: 'response.created', response: { id: 'search' } })
      event({
        type: 'response.output_item.done',
        response_id: 'search',
        item: { type: 'function_call', call_id: 'lookup_1', name: 'lookup', arguments: '{}' },
      })
      event({
        type: protocol === 'live' ? 'response.completed' : 'response.done',
        response: { id: 'search', status: 'completed' },
      })
      await flush()
      if (cancellation === 'server') {
        event({
          type: protocol === 'live' ? 'response.cancelled' : 'response.done',
          response: { id: 'search', status: 'cancelled' },
        })
      } else runner.cancelPending(true)
      runner.cancelPending(true)
      assert.equal(cancelled, 1)
      assert.equal(sent.length, 1)
      assert.equal(sent[0].type, protocol === 'live' ? 'response.item.create' : 'conversation.item.create')
      assert.equal(sent[0].item.call_id, 'lookup_1')
      assert.deepEqual(JSON.parse(sent[0].item.output), { error: 'tool_cancelled' })
      resolve({ found: 'late result' })
      await flush()
      assert.equal(sent.length, 1)
      assert.equal(timers.size, 0)
      runner.close()
      assert.equal(sent.length, 1)
    })
  }

  test(`${protocol} cancellation from a result callback cannot continue an obsolete turn`, async () => {
    const sent = []
    const runner = new ToolRunner([{ name: 'lookup', parameters: { type: 'object' }, execute: () => 'found' }], {
      protocol,
      send: (event) => sent.push(event),
      platform: { setTimeout, clearTimeout },
      onResult: () => runner.cancelPending(true),
    })
    const event = (value) =>
      runner.receive(protocol === 'live' ? { type: 'response.event', delegation_id: 'task', event: value } : value)
    event({ type: 'response.created', response: { id: 'search' } })
    event({
      type: 'response.output_item.done',
      response_id: 'search',
      item: { type: 'function_call', call_id: 'lookup_1', name: 'lookup', arguments: '{}' },
    })
    event({
      type: protocol === 'live' ? 'response.completed' : 'response.done',
      response: { id: 'search', status: 'completed' },
    })
    await flush()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].item.output, 'found')
    runner.close()
  })
}

for (const first of ['input_audio_buffer.speech_started', 'output_audio_buffer.cleared']) {
  test(`Mini ${first} flushes once, preserves capture/session and resumes the next response`, async () => {
    const f = fixture({ bargeIn: true })
    await f.connect()
    f.message({ type: 'response.created', response: { id: 'old' } })
    f.message({ type: first, response_id: 'old' })
    f.message({ type: 'input_audio_buffer.speech_started' })
    f.message({ type: 'output_audio_buffer.cleared', response_id: 'old' })
    assert.equal(f.interrupted, 1)
    assert.equal(f.mute, false)
    assert.equal(f.closed, 0)
    f.message({ type: 'response.done', response: { id: 'old', status: 'cancelled' } })
    f.message({ type: 'response.created', response: { id: 'fresh' } })
    const resumed = f.resumed
    assert.ok(resumed > 0)
    f.message({ type: 'output_audio_buffer.cleared', response_id: 'old' })
    assert.equal(f.interrupted, 1)
    f.message({ type: 'error', error: { code: 'response_cancel_not_active' } })
    assert.deepEqual(f.errors, [])
    assert.equal(f.c.state, 'connected')
    f.message({ type: 'input_audio_buffer.speech_started' })
    assert.equal(f.interrupted, 2)
    await f.c.close()
  })
}

for (const mode of ['live', 'realtime']) {
  test(`${mode} ignores interruption while Off or explicitly muted`, async () => {
    for (const bargeIn of [false, true]) {
      const f = fixture({ mode, bargeIn })
      await f.connect()
      if (bargeIn) {
        const muting = f.c.setMuted(true)
        if (mode === 'live') f.message({ type: 'session.input_audio.muted', client_event_id: f.sent.at(-1).event_id })
        await muting
      }
      f.message({ type: 'input_audio_buffer.speech_started' })
      f.message({ type: 'output_audio_buffer.cleared' })
      f.message({ type: 'session.output_transcript.delta', delta: 'Story.', start_ms: 0, end_ms: 1000 })
      f.message({ type: 'session.input_transcript.delta', delta: 'Please stop.', start_ms: 300, end_ms: 800 })
      assert.equal(f.interrupted, 0)
      const closing = f.c.close()
      if (mode === 'live')
        f.message({ type: 'session.closed', session: { id: 'sess_test' }, reason: 'close_requested' })
      await closing
    }
  })
}

test('Live interrupts one overlapping caller turn and ignores its late fragments after a fresh reply', async () => {
  const f = fixture({ mode: 'live', bargeIn: true })
  await f.connect()
  const caption = (role, text, start_ms, end_ms) =>
    f.message({ type: `session.${role}_transcript.delta`, delta: text, start_ms, end_ms })
  caption('output', 'A story.', 0, 1000)
  caption('input', 'Please stop.', 300, 800)
  assert.equal(f.interrupted, 1)
  caption('input', ' Now I am talking.', 800, 1200)
  assert.equal(f.interrupted, 1)
  caption('output', 'What would you like?', 2000, 2600)
  assert.equal(f.resumed, 1)
  caption('input', ' Please listen.', 1200, 1600)
  caption('input', 'Please stop.', 300, 800)
  assert.equal(f.interrupted, 1)
  caption('input', 'Another question.', 2400, 3000)
  assert.equal(f.interrupted, 2)
  assert.equal(f.c.state, 'connected')
  assert.equal(f.mute, false)
  const closing = f.c.close()
  f.message({ type: 'session.closed', session: { id: 'sess_test' }, reason: 'close_requested' })
  await closing
})

for (const [name, fragments] of [
  [
    'A: continued answer and late caller fragments',
    [
      ['output', 0, 3000, 0, 0],
      ['input', 2000, 2300, 1, 0],
      ['output', 3000, 5000, 1, 1],
      ['output', 5000, 12000, 1, 1],
      ['input', 2300, 2700, 1, 1],
      ['input', 7500, 7800, 2, 1],
      ['output', 12000, 12500, 2, 2],
    ],
  ],
  [
    'B: caller end advances inside an assistant turn',
    [
      ['output', 0, 3000, 0, 0],
      ['input', 2500, 2900, 1, 0],
      ['input', 2900, 3600, 1, 0],
      ['output', 3400, 3700, 1, 0],
      ['output', 3700, 4000, 1, 1],
    ],
  ],
  [
    'C: delayed assistant captions reveal overlap',
    [
      ['output', 0, 1500, 0, 0],
      ['input', 2500, 2900, 0, 0],
      ['output', 1500, 3000, 1, 0],
      ['output', 3000, 3400, 1, 1],
      ['output', 3400, 3800, 1, 1],
    ],
  ],
]) {
  test(`Live recovery ${name}`, async () => {
    const f = fixture({ mode: 'live', bargeIn: true })
    await f.connect()
    try {
      for (const [role, start_ms, end_ms, interrupted, resumed] of fragments) {
        f.message({ type: `session.${role}_transcript.delta`, delta: 'Spoken fragment.', start_ms, end_ms })
        assert.equal(f.interrupted, interrupted, `${role} ${start_ms}-${end_ms} interruptions`)
        assert.equal(f.resumed, resumed, `${role} ${start_ms}-${end_ms} resumes`)
      }
      assert.equal(f.c.state, 'connected')
      assert.equal(f.mute, false)
    } finally {
      const closing = f.c.close()
      f.message({ type: 'session.closed', session: { id: 'sess_test' }, reason: 'close_requested' })
      await closing
    }
  })
}

test('Live never interrupts a newer assistant turn for an older caller caption arriving for the first time', async () => {
  const f = fixture({ mode: 'live', bargeIn: true })
  await f.connect()
  f.message({ type: 'session.output_transcript.delta', delta: 'An old answer.', start_ms: 0, end_ms: 200 })
  f.message({ type: 'session.output_transcript.delta', delta: 'A fresh answer.', start_ms: 1800, end_ms: 2200 })
  f.message({ type: 'session.input_transcript.delta', delta: 'Please stop.', start_ms: 300, end_ms: 800 })
  assert.equal(f.interrupted, 0)
  const closing = f.c.close()
  f.message({ type: 'session.closed', session: { id: 'sess_test' }, reason: 'close_requested' })
  await closing
})

for (const turnDetection of [
  { type: 'server_vad', threshold: 0.3 },
  { type: 'server_vad', threshold: 0.5 },
  { type: 'semantic_vad', eagerness: 'auto' },
]) {
  test(`Mini negotiates ${JSON.stringify(turnDetection)} without changing On/Off`, async () => {
    for (const bargeIn of [false, true]) {
      const f = fixture({ bargeIn, turnDetection })
      await f.connect()
      assert.deepEqual(f.setup[0].session.audio.input.turn_detection, {
        ...turnDetection,
        create_response: true,
        interrupt_response: bargeIn,
      })
      await f.c.close()
    }
  })
}
function fixture(options = {}) {
  let callback,
    pendingSearch,
    pendingHangup,
    searchCancelled = 0,
    closed = 0,
    quiesced = false,
    interrupted = 0,
    resumed = 0,
    mute = false
  const requests = [],
    sent = [],
    transcripts = [],
    errors = [],
    events = [],
    timers = new Set(),
    starts = []
  const c = new Conversation(
    {
      mode: 'realtime',
      apiKey: 'test-only',
      instructions: 'Use Polish.',
      search: { model: 'test-backend', reasoningEffort: 'medium' },
      onTranscript: (value) => transcripts.push(value),
      onError: (value) => errors.push(value),
      onEvent: (value) => events.push(value),
      ...options,
    },
    {
      createTransport(fn) {
        callback = fn
        return {
          start: (value) => starts.push(value),
          setVolume() {},
          interruptOutput() {
            interrupted++
          },
          resumeOutput() {
            resumed++
          },
          quiesce() {
            quiesced = true
          },
          setMuted(value) {
            mute = value
          },
          acceptAnswer(sdp) {
            assert.equal(sdp, 'v=0\r\nanswer')
          },
          send(text) {
            sent.push(JSON.parse(text))
          },
          async close() {
            closed++
          },
        }
      },
      fetch(url, init) {
        requests.push({ url, init })
        if (url.endsWith('/hangup') && pendingHangup) return pendingHangup
        if (url.endsWith('/responses') && pendingSearch) {
          const promise = pendingSearch
          promise.cancel = () => {
            searchCancelled++
          }
          return promise
        }
        return Promise.resolve({
          status: url.endsWith('/hangup') ? 200 : 201,
          ok: true,
          location: '/v1/realtime/calls/rtc_test',
          text: async () =>
            options.mode === 'live'
              ? JSON.stringify({ session: { id: 'sess_test' }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer' } })
              : 'v=0\r\nanswer',
        })
      },
      setTimeout(fn, ms) {
        const t = { fn, ms }
        timers.add(t)
        return t
      },
      clearTimeout(t) {
        timers.delete(t)
      },
    },
  )
  const message = (value) => callback({ type: 'message', data: JSON.stringify(value) })
  return {
    c,
    requests,
    sent,
    transcripts,
    errors,
    events,
    timers,
    starts,
    message,
    get closed() {
      return closed
    },
    get quiesced() {
      return quiesced
    },
    get interrupted() {
      return interrupted
    },
    get resumed() {
      return resumed
    },
    get mute() {
      return mute
    },
    get searchCancelled() {
      return searchCancelled
    },
    setSearch(promise) {
      pendingSearch = promise
    },
    setHangup(promise) {
      pendingHangup = promise
    },
    async signal() {
      callback({ type: 'offer', sdp: 'v=0\r\noffer' })
      await flush()
    },
    async connect() {
      const connecting = c.connect()
      await this.signal()
      if (options.mode === 'live') message({ type: 'session.started', session: { id: 'sess_test' } })
      else {
        message({ type: 'session.created', session: { id: 'sess_test' } })
        message({
          type: 'session.updated',
          session: { ...sent.at(-1).session, id: 'sess_test' },
        })
      }
      this.setup = sent.splice(0)
      await connecting
    },
    call(id = 'call_test') {
      message({ type: 'response.created', response: { id: 'resp_test' } })
      message({
        type: 'response.output_item.done',
        response_id: 'resp_test',
        item: {
          type: 'function_call',
          call_id: id,
          name: 'search_web',
          arguments: '{"query":"current weather"}',
        },
      })
      message({ type: 'response.done', response: { id: 'resp_test', status: 'completed' } })
    },
  }
}

for (const mode of ['live', 'realtime']) {
  for (const bargeIn of [false, true]) {
    test(`integrated ${mode} retains LIVE and its resources after a response conflict (interruption ${bargeIn})`, async () => {
      let f,
        audioReleased = 0,
        radioReleased = 0
      const states = [],
        idleTimers = new Set()
      const session = new LiveSession({
        Conversation: class {
          constructor(options) {
            f = fixture(options)
          }
          setVolume(value) {
            f.c.setVolume(value)
          }
          connect() {
            return f.connect()
          }
          close() {
            return f.c.close()
          }
        },
        settings: { mode, bargeIn, apiKey: 'test-only', volume: 0, instructions: 'Use Polish.' },
        audio: { acquireExclusive: () => () => audioReleased++ },
        acquireLowLatency: () => ({ close: () => radioReleased++ }),
        networkReady: Promise.resolve({ status: 'connected' }),
        amp: { sampleRate: 24000 },
        onState: (state) => states.push(state),
        Timer: {
          set(fn, ms) {
            const timer = { fn, ms }
            idleTimers.add(timer)
            return timer
          },
          clear(timer) {
            idleTimers.delete(timer)
          },
        },
      })
      assert.equal(await session.start(), true)
      const entry = session.active
      for (const event_id of [undefined, null, 'tool_continue_old']) {
        f.message({ type: 'error', error: { code: 'conversation_already_has_active_response', event_id } })
        await flush()
        assert.equal(session.active, entry)
        assert.equal(entry.cancelled, false)
        assert.equal(f.c.state, 'connected')
        assert.equal(states.at(-1), 'connected')
        assert.equal(f.closed, 0)
        assert.equal(audioReleased, 0)
        assert.equal(radioReleased, 0)
      }
      assert.equal(idleTimers.size, mode === 'live' ? 1 : 0)
      // Real failures still reach the integrated control and release ownership.
      f.message({ type: 'error', error: { code: 'invalid_api_key', message: 'Rejected' } })
      if (mode === 'live') f.message({ type: 'session.closed', reason: 'close_requested' })
      await session.stop()
      assert.equal(session.active, undefined)
      assert.equal(states.at(-1), 'error')
      assert.equal(f.closed, 1)
      assert.equal(audioReleased, 1)
      assert.equal(radioReleased, 1)
      assert.equal(idleTimers.size, 0)
      assert.equal(f.timers.size, 0)
    })
  }
}
async function requestedSession(f) {
  const request = f.requests[0]
  const body = await new Response(request.init.body, {
    headers: { 'Content-Type': request.init.headers['Content-Type'] },
  }).formData()
  return JSON.parse(body.get('session'))
}
test('Mini waits for the requested instructions before opening microphone input', async () => {
  const f = fixture({ instructions: 'Reply only: copper penguin.' })
  const connecting = f.c.connect()
  await f.signal()
  const requested = await requestedSession(f)
  f.message({ type: 'session.created', session: { ...requested, id: 'sess_test', instructions: 'Server defaults.' } })
  assert.equal(f.c.state, 'connecting')
  assert.equal(f.mute, true)
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].session.instructions, requested.instructions)
  f.message({ type: 'session.updated', session: { ...requested, ...f.sent[0].session, id: 'sess_test' } })
  await connecting
  assert.equal(f.c.state, 'connected')
  assert.equal(f.mute, false)
  await f.c.close()
})
test('Mini rejects an acknowledged configuration that still omits its system prompt', async () => {
  const f = fixture()
  const connecting = f.c.connect()
  const outcome = connecting.then(
    () => 'connected',
    (error) => error.code,
  )
  await f.signal()
  const requested = await requestedSession(f)
  const wrong = { ...requested, id: 'sess_test', instructions: '' }
  f.message({ type: 'session.created', session: wrong })
  f.message({ type: 'session.updated', session: wrong })
  await flush()
  assert.equal(f.errors.at(-1)?.code, 'configuration_mismatch')
  assert.equal(await outcome, 'configuration_mismatch')
  assert.equal(f.mute, true)
  assert.equal(f.closed, 1)
  assert.equal(f.timers.size, 0)
})
test('Mini waits for far-field filtering before enabling interruption input', async () => {
  const f = fixture({ bargeIn: true })
  const connecting = f.c.connect()
  await f.signal()
  const requested = await requestedSession(f)
  const unfiltered = { ...requested, id: 'sess_test', audio: { input: { ...requested.audio.input } } }
  delete unfiltered.audio.input.noise_reduction
  f.message({ type: 'session.created', session: unfiltered })
  assert.equal(f.c.state, 'connecting')
  assert.equal(f.mute, true)
  assert.equal(f.sent.length, 1)
  assert.deepEqual(f.sent[0].session.audio.input.noise_reduction, { type: 'far_field', strength: 1 })
  f.message({ type: 'session.updated', session: { ...requested, ...f.sent[0].session, id: 'sess_test' } })
  await connecting
  assert.equal(f.c.state, 'connected')
  assert.equal(f.mute, false)
  await f.c.close()
})
for (const noise of [undefined, null, { type: 'near_field', strength: 1 }, { type: 'far_field', strength: 0.5 }]) {
  test(`Mini rejects an interruption filter acknowledgement of ${JSON.stringify(noise)}`, async () => {
    const f = fixture({ bargeIn: true })
    const connecting = f.c.connect()
    const outcome = connecting.then(
      () => 'connected',
      (error) => error.code,
    )
    await f.signal()
    const requested = await requestedSession(f)
    const wrong = {
      ...requested,
      id: 'sess_test',
      audio: { input: { ...requested.audio.input, noise_reduction: noise } },
    }
    f.message({ type: 'session.created', session: wrong })
    f.message({ type: 'session.updated', session: wrong })
    await flush()
    assert.equal(await outcome, 'configuration_mismatch')
    assert.equal(f.mute, true)
    assert.equal(f.closed, 1)
    assert.equal(f.timers.size, 0)
  })
}
test('Mini accepts a complete initial configuration without an unnecessary update', async () => {
  for (const bargeIn of [false, true]) {
    const f = fixture({ bargeIn })
    const connecting = f.c.connect()
    await f.signal()
    f.message({ type: 'session.created', session: { ...(await requestedSession(f)), id: 'sess_test' } })
    await connecting
    assert.equal(f.c.state, 'connected')
    assert.equal(f.mute, false)
    assert.deepEqual(f.sent, [])
    await f.c.close()
  }
})
function searchReply() {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify(
        summarizeWebSearchResponse(
          JSON.stringify({
            status: 'completed',
            output: [
              { type: 'web_search_call', status: 'completed' },
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: 'Answer.',
                    annotations: [{ type: 'url_citation', url: 'https://example.com/source', title: 'Source' }],
                  },
                ],
              },
            ],
          }),
        ),
      ),
  }
}
test('both Realtime models use multipart WebRTC, server VAD and supported tools at either interruption setting', async () => {
  const thresholds = []
  for (const [model, bargeIn] of [undefined, 'gpt-realtime-2.1-mini', 'gpt-realtime-2.1'].flatMap((model) => [
    [model, false],
    [model, true],
  ])) {
    const f = fixture({ bargeIn, model, voice: 'cedar', pitch: 2 })
    await f.connect()
    const request = f.requests[0]
    assert.equal(request.url, 'https://api.openai.com/v1/realtime/calls')
    const boundary = request.init.headers['Content-Type'].split('boundary=')[1]
    const body = await new Response(request.init.body, {
      headers: { 'Content-Type': request.init.headers['Content-Type'] },
    }).formData()
    const session = JSON.parse(body.get('session'))
    assert.equal(body.get('sdp'), 'v=0\r\noffer')
    assert.ok(request.init.body.endsWith(`--${boundary}--\r\n`))
    assert.equal(session.model, model ?? 'gpt-realtime-2.1-mini')
    assert.equal(session.instructions, 'Use Polish.')
    assert.equal(session.audio.output.voice, 'cedar')
    assert.deepEqual(session.audio.input.noise_reduction, bargeIn ? { type: 'far_field', strength: 1 } : undefined)
    const turn = session.audio.input.turn_detection
    assert.equal(turn.type, 'server_vad')
    assert.equal(turn.create_response, true)
    assert.equal(turn.interrupt_response, bargeIn)
    assert.ok(turn.threshold > 0 && turn.threshold < 1)
    thresholds.push(turn.threshold)
    assert.equal(session.tools[0].name, 'search_web')
    assert.equal(session.tools[0].strict, undefined)
    assert.equal(session.delegation, undefined)
    assert.deepEqual(f.starts, [{ bargeIn, pitch: 2, realtime: true }])
    assert.equal(f.setup[0].type, 'session.update')
    assert.deepEqual(f.setup[0].session.audio.input.noise_reduction, session.audio.input.noise_reduction)
    assert.equal(f.setup[0].session.audio.input.turn_detection.interrupt_response, bargeIn)
    assert.equal(f.c.state, 'connected')
    await f.c.setMuted(true)
    assert.equal(f.mute, true)
    await f.c.setMuted(false)
    assert.equal(f.mute, false)
    assert.deepEqual(f.sent, [])
    await f.c.close()
    assert.equal(f.closed, 1)
    assert.equal(f.timers.size, 0)
    assert.ok(f.requests.at(-1).url.endsWith('/rtc_test/hangup'))
  }
  assert.equal(new Set(thresholds).size, 1)
})

test('Realtime rejects unsupported explicit models before starting native transport', () => {
  for (const model of ['gpt-live-1', 'unsupported-model', '', 1]) assert.throws(() => fixture({ model }), TypeError)
})

test('full Realtime gates prompt acknowledgement, cancels interrupted search and releases playback resources', async () => {
  const f = fixture({ model: 'gpt-realtime-2.1', bargeIn: true })
  const connecting = f.c.connect()
  await f.signal()
  f.message({ type: 'session.created', session: { id: 'sess_test' } })
  assert.equal(f.c.state, 'connecting')
  assert.equal(f.mute, true)
  f.message({ type: 'session.updated', session: { ...f.sent.at(-1).session, id: 'sess_test' } })
  await connecting
  assert.equal(f.c.state, 'connected')
  assert.equal(f.mute, false)
  f.sent.splice(0)
  let resolve
  f.setSearch(
    new Promise((done) => {
      resolve = done
    }),
  )
  f.call()
  await flush()
  assert.equal(f.requests[1].url, 'https://api.openai.com/v1/responses')
  f.message({ type: 'input_audio_buffer.speech_started' })
  f.message({ type: 'output_audio_buffer.cleared' })
  assert.equal(f.searchCancelled, 1)
  assert.ok(f.interrupted > 0)
  resolve(searchReply())
  await flush()
  assert.equal(f.sent.length, 1)
  assert.deepEqual(JSON.parse(f.sent[0].item.output), { error: 'tool_cancelled' })
  await f.c.close()
  assert.equal(f.closed, 1)
  assert.equal(f.timers.size, 0)
})
test('delayed search leaves event processing responsive, sends sources once and then continues', async () => {
  const f = fixture()
  await f.connect()
  let resolve
  f.setSearch(
    new Promise((done) => {
      resolve = done
    }),
  )
  f.call()
  await flush()
  assert.equal(f.requests.length, 2)
  for (let i = 0; i < 20; i++) f.message({ type: 'response.output_audio_transcript.delta', delta: 'word ' })
  assert.equal(f.transcripts.length, 20)
  assert.deepEqual(f.sent, [])
  const search = JSON.parse(f.requests[1].init.body)
  assert.equal(search.input, 'current weather')
  assert.equal(search.store, false)
  assert.equal(search.tools[0].type, 'web_search')
  resolve(searchReply())
  await flush()
  assert.deepEqual(
    f.sent.map((event) => event.type),
    ['conversation.item.create', 'response.create'],
  )
  assert.equal(f.sent[0].item.call_id, 'call_test')
  const result = JSON.parse(f.sent[0].item.output)
  assert.equal(result.answer, 'Answer.')
  assert.equal(result.sources[0].url, 'https://example.com/source')
  f.call()
  await flush()
  assert.equal(f.requests.length, 2)
  await f.c.close()
})
test('STOP cancels pending search and suppresses late function results after cleanup', async () => {
  const f = fixture()
  await f.connect()
  let resolve
  f.setSearch(
    new Promise((done) => {
      resolve = done
    }),
  )
  f.call()
  await flush()
  await f.c.close()
  assert.equal(f.searchCancelled, 1)
  assert.equal(f.closed, 1)
  assert.equal(f.timers.size, 0)
  resolve(searchReply())
  await flush()
  assert.deepEqual(f.sent, [])
})

test('STOP silences immediately but retains media resources until hangup settles, including failure', async () => {
  for (const confirmed of [true, false]) {
    const f = fixture()
    await f.connect()
    let settle
    f.setHangup(
      new Promise((resolve, reject) => {
        settle = confirmed ? () => resolve({ ok: true, text: async () => '' }) : () => reject(new Error('timed out'))
      }),
    )
    const closing = f.c.close()
    await flush()
    assert.equal(f.quiesced, true)
    assert.equal(f.closed, 0)
    assert.equal(f.c.state, 'closing')
    assert.equal(f.requests.at(-1).init.timeoutMs, 3000)
    settle()
    const result = await closing
    assert.equal(f.closed, 1)
    assert.equal(result.finalized, confirmed)
    assert.equal(result.reason, confirmed ? 'client_request' : 'hangup_failed')
    assert.equal(f.c.state, 'closed')
    assert.equal(f.timers.size, 0)
    assert.equal(f.errors.length, confirmed ? 0 : 1)
  }
})

test('new speech cancels an obsolete search when interruption is enabled', async () => {
  const f = fixture({ bargeIn: true })
  await f.connect()
  let resolve
  f.setSearch(
    new Promise((done) => {
      resolve = done
    }),
  )
  f.call()
  await flush()
  f.message({ type: 'input_audio_buffer.speech_started' })
  assert.equal(f.searchCancelled, 1)
  resolve(searchReply())
  await flush()
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].item.call_id, 'call_test')
  assert.deepEqual(JSON.parse(f.sent[0].item.output), { error: 'tool_cancelled' })
  f.message({ type: 'output_audio_buffer.cleared' })
  await flush()
  assert.equal(f.sent.length, 1)
  assert.equal(f.searchCancelled, 1)
  await f.c.close()
})

test('search continuation waits for the active VAD response without replaying function output', async () => {
  const f = fixture()
  await f.connect()
  let resolve
  f.setSearch(
    new Promise((done) => {
      resolve = done
    }),
  )
  f.call()
  await flush()
  f.message({ type: 'response.created', response: { id: 'other_response' } })
  resolve(searchReply())
  await flush()
  assert.deepEqual(
    f.sent.map((event) => event.type),
    ['conversation.item.create'],
  )
  f.message({ type: 'response.done', response: { id: 'other_response', status: 'completed' } })
  assert.deepEqual(
    f.sent.map((event) => event.type),
    ['conversation.item.create', 'response.create'],
  )
  f.message({ type: 'response.created', response: { id: 'continuation_response' } })
  f.message({ type: 'response.done', response: { id: 'continuation_response', status: 'completed' } })
  assert.equal(f.sent.length, 2)
  await f.c.close()
})

test('a VAD/create race retries only continuation, with a bounded timer canceled by STOP', async () => {
  const f = fixture()
  await f.connect()
  f.setSearch(Promise.resolve(searchReply()))
  f.call()
  await flush()
  const continuation = f.sent.at(-1)
  f.message({
    type: 'error',
    error: { code: 'conversation_already_has_active_response', event_id: continuation.event_id },
  })
  assert.equal(f.errors.length, 0)
  const timer = [...f.timers].find((item) => item.ms === 250)
  assert.ok(timer)
  f.timers.delete(timer)
  timer.fn()
  assert.deepEqual(
    f.sent.map((event) => event.type),
    ['conversation.item.create', 'response.create', 'response.create'],
  )
  await f.c.close()
  assert.equal(f.timers.size, 0)
})

for (const bargeIn of [false, true]) {
  for (const eventID of [undefined, null]) {
    test(`an uncorrelated active-response conflict preserves Mini and retries its pending continuation (interruption ${bargeIn}, ID ${eventID})`, async () => {
      const f = fixture({ bargeIn })
      await f.connect()
      f.setSearch(Promise.resolve(searchReply()))
      f.call()
      await flush()
      const conflict = {
        type: 'error',
        error: { code: 'conversation_already_has_active_response', event_id: eventID },
      }
      f.message(conflict)
      assert.equal(f.errors.length, 0)
      assert.equal(f.c.state, 'connected')
      assert.deepEqual(f.events.at(-1), JSON.parse(JSON.stringify(conflict)))
      const timer = [...f.timers].find((item) => item.ms === 250)
      assert.ok(timer)
      // An actual response completion resumes work before the retry timer.
      f.message({ type: 'response.created', response: { id: 'vad_response' } })
      f.message({ type: 'response.done', response: { id: 'vad_response', status: 'completed' } })
      assert.equal(f.timers.size, 0)
      f.message({ type: 'response.created', response: { id: 'answer' } })
      f.message({ type: 'response.output_audio_transcript.delta', delta: 'Search answer.' })
      f.message({ type: 'response.done', response: { id: 'answer', status: 'completed' } })
      assert.deepEqual(f.transcripts, [{ role: 'assistant', delta: 'Search answer.' }])
      assert.deepEqual(
        f.sent.map((event) => event.type),
        ['conversation.item.create', 'response.create', 'response.create'],
      )
      assert.equal(f.closed, 0)
      await f.c.close()
      assert.equal(f.closed, 1)
      assert.equal(f.timers.size, 0)
    })
  }

  test(`repeated active-response conflicts wait for completion after bounded retries (interruption ${bargeIn})`, async () => {
    const f = fixture({ bargeIn })
    await f.connect()
    f.setSearch(Promise.resolve(searchReply()))
    f.call()
    await flush()
    const continuation = f.sent.at(-1)
    for (let attempt = 1; attempt <= 3; attempt++) {
      f.message({
        type: 'error',
        error: { code: 'conversation_already_has_active_response', event_id: continuation.event_id },
      })
      assert.equal(f.errors.length, 0)
      const timers = [...f.timers]
      assert.equal(timers.length, attempt < 3 ? 1 : 0)
      for (const timer of timers) {
        f.timers.delete(timer)
        timer.fn()
      }
    }
    assert.equal(f.sent.filter((event) => event.type === 'response.create').length, 3)
    f.message({ type: 'response.created', response: { id: 'busy_response' } })
    f.message({ type: 'response.done', response: { id: 'unrelated_response', status: 'completed' } })
    assert.equal(f.sent.filter((event) => event.type === 'response.create').length, 3)
    f.message({ type: 'response.done', response: { id: 'busy_response', status: 'completed' } })
    assert.equal(f.sent.filter((event) => event.type === 'response.create').length, 4)
    assert.equal(f.sent.filter((event) => event.item?.type === 'function_call_output').length, 1)
    f.message({ type: 'response.created', response: { id: 'answer' } })
    f.message({ type: 'response.output_audio_transcript.delta', delta: 'Still connected.' })
    f.message({ type: 'response.done', response: { id: 'answer', status: 'completed' } })
    assert.equal(f.c.state, 'connected')
    assert.equal(f.transcripts.at(-1).delta, 'Still connected.')
    assert.equal(f.closed, 0)
    assert.equal(f.timers.size, 0)
    await f.c.close()
    assert.equal(f.closed, 1)
  })

  test(`late or foreign conflicts never replay a completed tool result (interruption ${bargeIn})`, async () => {
    const f = fixture({ bargeIn })
    await f.connect()
    f.setSearch(Promise.resolve(searchReply()))
    f.call()
    await flush()
    const continuation = f.sent.at(-1)
    f.message({
      type: 'error',
      error: { code: 'conversation_already_has_active_response', event_id: 'unrelated_command' },
    })
    assert.equal(f.errors.length, 0)
    assert.equal(f.timers.size, 0)
    assert.equal(f.sent.length, 2)
    f.message({ type: 'response.created', response: { id: 'answer' } })
    f.message({ type: 'error', error: { code: 'conversation_already_has_active_response' } })
    assert.equal(f.errors.length, 0)
    assert.equal(f.timers.size, 0)
    f.message({ type: 'response.done', response: { id: 'answer', status: 'completed' } })
    for (const event_id of [continuation.event_id, 'unrelated_command', undefined]) {
      f.message({ type: 'error', error: { code: 'conversation_already_has_active_response', event_id } })
      assert.equal(f.errors.length, 0)
      assert.equal(f.timers.size, 0)
      assert.equal(f.sent.length, 2)
    }
    f.message({ type: 'response.created', response: { id: 'next_turn' } })
    f.message({ type: 'response.output_audio_transcript.delta', delta: 'Next turn.' })
    f.message({ type: 'response.done', response: { id: 'next_turn', status: 'completed' } })
    assert.equal(f.c.state, 'connected')
    assert.equal(f.transcripts.at(-1).delta, 'Next turn.')
    f.message({ type: 'error', error: { code: 'invalid_api_key', message: 'Rejected' } })
    assert.equal(f.errors.at(-1).code, 'invalid_api_key')
    await f.c.close()
    assert.equal(f.timers.size, 0)
  })

  test(`STOP cancels a pending conflict retry (interruption ${bargeIn})`, async () => {
    const f = fixture({ bargeIn })
    await f.connect()
    f.setSearch(Promise.resolve(searchReply()))
    f.call()
    await flush()
    f.message({ type: 'error', error: { code: 'conversation_already_has_active_response' } })
    assert.equal(f.errors.length, 0)
    assert.equal(f.timers.size, 1)
    await f.c.close()
    assert.equal(f.timers.size, 0)
    assert.equal(f.sent.filter((event) => event.type === 'response.create').length, 1)
    assert.equal(f.closed, 1)
  })

  test(`a known active response resumes the rejected continuation without polling (interruption ${bargeIn})`, async () => {
    const f = fixture({ bargeIn })
    await f.connect()
    f.setSearch(Promise.resolve(searchReply()))
    f.call()
    await flush()
    const continuation = f.sent.at(-1)
    f.message({ type: 'response.created', response: { id: 'vad_response' } })
    f.message({
      type: 'error',
      error: { code: 'conversation_already_has_active_response', event_id: continuation.event_id },
    })
    assert.equal(f.errors.length, 0)
    assert.equal(f.timers.size, 0)
    assert.equal(f.sent.length, 2)
    f.message({ type: 'response.done', response: { id: 'vad_response', status: 'completed' } })
    assert.equal(f.sent.length, 3)
    assert.equal(f.sent.at(-1).event_id, continuation.event_id)
    f.message({ type: 'response.created', response: { id: 'answer' } })
    f.message({ type: 'response.done', response: { id: 'answer', status: 'completed' } })
    assert.equal(f.sent.filter((event) => event.item?.type === 'function_call_output').length, 1)
    await f.c.close()
    assert.equal(f.timers.size, 0)
  })
}
