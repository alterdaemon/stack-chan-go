import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
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
          text: async () => 'v=0\r\nanswer',
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
      message({ type: 'session.created', session: { id: 'sess_test' } })
      message({
        type: 'session.updated',
        session: { ...sent.at(-1).session, id: 'sess_test' },
      })
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
async function requestedSession(f) {
  const request = f.requests[0]
  const body = await new Response(request.init.body, {
    headers: { 'Content-Type': request.init.headers['Content-Type'] },
  }).formData()
  return JSON.parse(body.get('session'))
}
test('Mini waits for the requested instructions before opening microphone input', async () => {
  const f = fixture({ instructions: 'Odpowiadaj wyłącznie: miedziany pingwin.' })
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
