import assert from 'node:assert/strict'
import test from 'node:test'
import { requestSubscriptionResponse as request } from '../subscription-response-socket.js'
import { createSubscriptionStream } from '../subscription-stream.js'

const enc = new TextEncoder(),
  dec = new TextDecoder('utf-8', { fatal: true }),
  ab = (t) => enc.encode(t).buffer
function trial(immediateCancel = false) {
  let options,
    close = 0,
    cancel
  const writes = [],
    timers = new Map()
  let next = 0,
    body
  const platform = {
    encode: ab,
    decode: (b) => dec.decode(b),
    createSubscriptionStream: (observe) => createSubscriptionStream((b) => dec.decode(b), ab, observe),
    schedule(fn, ms) {
      const id = ++next
      timers.set(id, { fn, ms })
      return id
    },
    cancel(id) {
      timers.delete(id)
    },
    createWebSocket(o) {
      options = o
      return {
        close() {
          close++
        },
        write(bytes, o) {
          assert(bytes instanceof Uint8Array)
          writes.push({ bytes: bytes.slice(), ...o })
          return 0
        },
        read() {
          return body
        },
      }
    },
  }
  const progress = []
  const promise = request(
    {
      host: 'chatgpt.com',
      port: 443,
      path: '/backend-api/codex/responses',
      headers: [
        ['Authorization', 'test-only'],
        ['Content-Type', 'application/json'],
      ],
      body: ab(JSON.stringify({ model: 'test-model', stream: true, store: false })),
      timeoutMs: 45000,
      streamIdleTimeoutMs: 300000,
      diagnostics: true,
    },
    platform,
    (fn) => {
      cancel = fn
      if (immediateCancel) fn()
    },
    (p) => progress.push(p),
  )
  const drain = () => {
    for (const [id, t] of [...timers])
      if (t.ms === 0) {
        timers.delete(id)
        t.fn()
      }
  }
  return {
    promise,
    writes,
    timers,
    progress,
    get options() {
      return options
    },
    get closes() {
      return close
    },
    cancel: () => cancel(),
    drain,
    writable(n) {
      options.onWritable.call({ write: platform.createWebSocket(options).write }, n)
    },
    read(text, more = false, binary = false) {
      body = ab(text)
      options.onReadable.call({ read: () => body }, body.byteLength, { more, binary })
    },
  }
}
test('subscription socket preserves request fields, fragments UTF-8 and reduces one final result', async () => {
  const t = trial()
  assert.equal(t.options.headers.get('OpenAI-Beta'), 'responses_websockets=2026-02-06')
  assert(!t.options.headers.has('Content-Type'))
  assert.equal([...t.timers.values()][0].ms, 45000)
  while (!t.progress.some((p) => p.phase === 'sent')) t.writable(7)
  const bytes = Buffer.concat(t.writes.map((d) => Buffer.from(d.bytes))),
    value = JSON.parse(bytes.toString())
  assert.equal(value.type, 'response.create')
  assert.equal(value.stream, true)
  assert.equal(value.store, false)
  assert.equal(value.model, 'test-model')
  assert(t.writes.at(-1).more === false)
  t.read('{"type":"response.in_pro', true)
  t.read('gress"}')
  assert.equal([...t.timers.values()][0].ms, 300000)
  t.read(
    JSON.stringify(
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'hello' }],
            },
          ],
        },
      },
      null,
      2,
    ),
  )
  t.drain()
  const r = await t.promise
  assert.equal(JSON.parse(dec.decode(r.body)).answer, 'hello')
  assert.equal(r.status, 200)
  assert.equal(t.closes, 1)
  assert.equal(t.timers.size, 0)
})
for (const kind of ['cancel', 'socket', 'close', 'timeout', 'binary', 'size', 'invalid'])
  test(`subscription socket closes once after ${kind}`, async () => {
    const t = trial()
    const rejected = t.promise.then(
      () => {
        throw Error('expected failure')
      },
      (e) => e,
    )
    t.writable(500)
    if (kind === 'cancel') t.cancel()
    if (kind === 'socket') t.options.onError()
    if (kind === 'close') t.options.onClose()
    if (kind === 'timeout') [...t.timers.values()][0].fn()
    if (kind === 'binary') t.read('{}', false, true)
    if (kind === 'size') t.read('x'.repeat(131073))
    if (kind === 'invalid') t.read('bad json')
    t.drain()
    const e = await rejected
    assert(e instanceof Error)
    assert.equal(t.closes, 1)
    assert.equal(t.timers.size, 0)
    const closes = t.closes
    t.options.onClose()
    t.cancel()
    t.drain()
    assert.equal(t.closes, closes)
    assert(t.options.isClosed())
  })

test('subscription socket retains a rejected HTTP upgrade status', async () => {
  const t = trial()
  const failure = t.promise.catch((e) => e)
  t.options.onStatus(401)
  t.options.onError()
  t.drain()
  const error = await failure
  assert.equal(error.status, 401)
  assert.equal(error.phase, 'upgrade')
  assert.equal(t.closes, 1)
})
test('subscription socket deadline follows stream inactivity beyond the connection budget', async () => {
  const t = trial()
  const failure = t.promise.catch((e) => e)
  t.writable(500)
  for (let i = 0; i < 8; i++) {
    t.read('{"type":"response.in_progress"}')
    assert.equal([...t.timers.values()][0].ms, 300000)
  }
  t.cancel()
  t.drain()
  await failure
  assert.equal(t.closes, 1)
})

test('subscription socket cancellation before opening creates no connection', async () => {
  const t = trial(true)
  const failure = t.promise.catch((e) => e)
  assert.equal(t.options, undefined)
  t.drain()
  assert.match((await failure).message, /cancelled/)
  assert.equal(t.closes, 0)
})
test('subscription socket retains only the numeric WebSocket close code', async () => {
  const t = trial()
  const failure = t.promise.catch((e) => e)
  t.writable(500)
  t.options.onControl(8, Uint8Array.of(3, 243, 112, 114, 105, 118, 97, 116, 101).buffer)
  t.options.onClose()
  t.drain()
  const error = await failure
  assert.equal(error.code, 1011)
  assert.equal(error.message, 'Subscription stream ended before completion')
  assert.equal(t.closes, 1)
})
