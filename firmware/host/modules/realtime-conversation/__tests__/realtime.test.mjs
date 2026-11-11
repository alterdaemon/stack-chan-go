import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { LiveSession } from '../../../../mods/examples/openai_live_webrtc/session.js'
import { summarizeWebSearchResponse } from '../web-search.js'

let source = readFileSync(new URL('../core.js', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)))
for (const [name, path] of Object.entries(manifest.modules))
  source = source.replaceAll(`'${name}'`, `'${new URL(`../${path}.js`, import.meta.url).href}'`)
const { default: Conversation } = await import(`data:text/javascript,${encodeURIComponent(source)}`)
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
function fixture(options = {}) {
  let callback,
    pendingSearch,
    pendingHangup,
    searchCancelled = 0,
    closed = 0,
    quiesced = false,
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
test('Mini accepts a complete initial configuration without an unnecessary update', async () => {
  const f = fixture()
  const connecting = f.c.connect()
  await f.signal()
  f.message({ type: 'session.created', session: { ...(await requestedSession(f)), id: 'sess_test' } })
  await connecting
  assert.equal(f.c.state, 'connected')
  assert.equal(f.mute, false)
  assert.deepEqual(f.sent, [])
  await f.c.close()
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
test('Mini uses multipart WebRTC, server VAD and only supported tool fields at either interruption setting', async () => {
  const thresholds = []
  for (const bargeIn of [false, true]) {
    const f = fixture({ bargeIn, model: 'ignored-other-model', voice: 'cedar', pitch: 2 })
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
    assert.equal(session.model, 'gpt-realtime-2.1-mini')
    assert.equal(session.instructions, 'Use Polish.')
    assert.equal(session.audio.output.voice, 'cedar')
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
  assert.ok(thresholds[1] < thresholds[0])
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
  assert.deepEqual(f.sent, [])
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
