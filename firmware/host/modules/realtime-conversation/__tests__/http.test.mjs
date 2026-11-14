import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createClosingClient,
  guardSocketCallbacks,
  httpResponseObservation,
  requestHttps,
  tlsRecordObservation,
} from '../http-core.js'
import { httpFailureMetadata, normalizeRequest } from '../http-options.js'
import { createHttpProxy } from '../http-proxy.js'
import { createHttpQueue } from '../http-queue.js'
import { createSubscriptionStream } from '../subscription-stream.js'

const encode = (text) => new TextEncoder().encode(text).buffer
const decode = (buffer) => new TextDecoder().decode(buffer)

test('TLS record observation identifies an incomplete record without keeping ciphertext', () => {
  const statistics = {},
    observe = tlsRecordObservation(statistics)
  const record = Uint8Array.of(23, 3, 3, 0, 7, 11, 12, 13, 14, 15, 16, 17)
  observe(record.subarray(0, 3))
  assert.equal(statistics.tlsRecordExpected, 0)
  observe(record.subarray(3, 8))
  assert.equal(statistics.tlsRecordExpected, 12)
  assert.equal(statistics.tlsRecordRead, 8)
  assert.equal(statistics.tlsRecords, undefined)
  observe(record.subarray(8))
  assert.equal(statistics.tlsRecords, 1)
  assert.equal(statistics.tlsRecordRead, 12)
  observe(record)
  assert.equal(statistics.tlsRecords, 2)
  assert.deepEqual(Object.keys(statistics).sort(), [
    'tlsRecordExpected',
    'tlsRecordRead',
    'tlsRecordType',
    'tlsRecords',
  ])
})

test('HTTP observation retains only validated status and bounded header byte boundaries', () => {
  const statistics = {},
    observe = httpResponseObservation(statistics)
  const header = 'HTTP/1.1 200 OK\r\nSet-Cookie: sensitive-private\r\n\r\n'
  for (const byte of new TextEncoder().encode(header)) observe(byte)
  assert.equal(statistics.httpStatus, 200)
  assert.equal(statistics.httpPrefix, 'http1')
  assert.equal(statistics.httpHeaderBytes, header.length)
  assert.equal(statistics.httpHeaderLfBytes, header.length)
  for (let index = 0; index < 20000; index++) observe(65)
  assert.equal(statistics.httpHeaderScan, header.length)
  assert.ok(!JSON.stringify(statistics).includes('private'))
  const invalid = {},
    input = httpResponseObservation(invalid)
  for (let index = 0; index < 20000; index++) input(65)
  assert.equal(invalid.httpPrefix, 'other')
  assert.equal(invalid.httpStatus, undefined)
  assert.equal(invalid.httpHeaderScan, 8192)
  const lf = {},
    lfOnly = httpResponseObservation(lf)
  for (const byte of new TextEncoder().encode('HTTP/1.1 200 OK\nX-Fixture: value\n\n')) lfOnly(byte)
  assert.equal(lf.httpStatus, 200)
  assert.equal(lf.httpHeaderBytes, undefined)
  assert.equal(lf.httpLfCount, 3)
  assert.ok(lf.httpHeaderLfBytes > 0)
})
const normalize = (url, options) => normalizeRequest(url, options, encode, (pem) => encode(pem))
const post = (options = {}) => normalize('https://service.test:8443/path?x=1', { method: 'POST', ...options })

test('HTTPS request bounds and header validation happen before IPC', () => {
  for (const url of [
    'http://host/a',
    'https://u:p@host/a',
    'https://host:0/a',
    'https://host:65536/a',
    'https://host/a#b',
  ])
    assert.throws(() => normalize(url, { method: 'POST' }), URIError)
  for (const headers of [{ 'bad:name': 'x' }, { x: 'bad\r\n' }, { x: 'bad\0' }])
    assert.throws(() => post({ headers }), TypeError)
  for (const options of [{ body: '日'.repeat(50000) }, { certificate: new ArrayBuffer(16385) }, { timeoutMs: NaN }])
    assert.throws(() => post(options), RangeError)
  const request = post({ body: '質問', headers: { Authorization: 'Bearer test', Connection: 'keep-alive' } })
  assert.equal(decode(request.body), '質問')
  assert.equal(request.port, 8443)
  assert.equal(request.path, '/path?x=1')
  assert.deepEqual(request.headers, [['authorization', 'Bearer test']])
})

test('only subscription response streams accept a bounded five-minute job deadline', async () => {
  assert.equal(post({ timeoutMs: 300000 }).timeoutMs, 45000)
  assert.equal(post({ timeoutMs: 300000, responseFormat: 'web-search' }).timeoutMs, 45000)
  assert.equal(post({ timeoutMs: 900000, responseFormat: 'subscription-response' }).timeoutMs, 300000)
  let callbacks, stop
  const timers = []
  const request = requestHttps(
    post({ timeoutMs: 300000, responseFormat: 'subscription-response' }),
    {
      createClient: () => ({
        request: (value) => {
          callbacks = value
        },
        close() {},
      }),
      createSubscriptionStream: () => ({}),
      schedule: (callback, ms) => {
        if (!ms) {
          queueMicrotask(callback)
          return -1
        }
        const timer = { callback, ms }
        timers.push(timer)
        return timer
      },
      cancel: (timer) => {
        if (timer !== -1) timer.cancelled = true
      },
    },
    (cancel) => {
      stop = cancel
    },
  )
  assert.equal(timers[0].ms, 45000, 'initial connection/header wait stays bounded')
  callbacks.onHeaders(200, new Map())
  assert.equal(timers[0].cancelled, true)
  assert.equal(timers[1].ms, 300000, 'accepted SSE may finish after the old total deadline')
  stop()
  await assert.rejects(request, /cancelled/)
  assert.equal(timers[1].cancelled, true)
})

test('stream observations export only fixed event categories while preserving completion', () => {
  const stream = createSubscriptionStream(decode, encode, true)
  for (const [type, category] of [
    ['response.created', 'response.created'],
    ['response.private-secret', 'other'],
    [123, 'other'],
    ['response.output_text.delta', 'text'],
  ]) {
    stream.write(new Uint8Array(encode(`data: ${JSON.stringify({ type })}\n\n`)))
    assert.equal(stream.observation.sseEvent, category)
  }
  assert.equal(stream.observation.sseEvents, 4)
  const sensitive = JSON.stringify({ type: 'response.output_item.added', item: { type: 'private-secret' } })
  stream.write(new Uint8Array(encode(`data: ${sensitive}\n\n`)))
  assert.equal(stream.observation.sseItem, 'other')
  stream.write(new Uint8Array(encode('data: {"type":"response.completed","private":"sensitive')))
  assert.ok(stream.observation.streamPending > 0)
  assert.equal(stream.observation.streamAnswerBytes, 0)
  assert.equal(createSubscriptionStream(decode, encode).observation, undefined)
  assert.ok(!JSON.stringify(stream.observation).includes('private'))
})
function fixture() {
  let callbacks,
    connection,
    expired,
    closes = 0,
    cancels = 0
  const context = {
    write() {},
    read(view) {
      return view.byteLength
    },
  }
  const platform = {
    createClient(options) {
      connection = options
      return {
        request(options) {
          callbacks = options
        },
        close() {
          closes++
        },
      }
    },
    schedule(fn, ms) {
      if (ms === 0) {
        queueMicrotask(fn)
        return -1
      }
      expired = fn
      return 0
    },
    cancel() {
      cancels++
    },
  }
  const promise = requestHttps(post({ body: 'abc' }), platform)
  return {
    promise,
    context,
    get cb() {
      return callbacks
    },
    get connection() {
      return connection
    },
    get closes() {
      return closes
    },
    get cancels() {
      return cancels
    },
    expire() {
      expired()
    },
  }
}
test('partial writes preserve the body and HTTP error statuses never trigger retries', async () => {
  const f = fixture(),
    pieces = []
  f.context.write = (view) => {
    if (view) pieces.push(...new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
  }
  f.cb.onWritable.call(f.context, 1)
  f.cb.onWritable.call(f.context, 9)
  f.cb.onWritable.call(f.context, 9)
  assert.equal(String.fromCharCode(...pieces), 'abc')
  f.cb.onHeaders(429, new Map())
  f.cb.onReadable.call(f.context, 2)
  f.cb.onDone()
  const r = await f.promise
  assert.equal(r.status, 429)
  assert.equal(r.body.byteLength, 2)
  f.connection.onError()
  f.expire()
  f.cb.onDone()
  assert.equal(f.closes, 1)
  assert.equal(f.cancels, 1)
})
test('zero writable capacity never terminates a content-length request body', async () => {
  const f = fixture(),
    pieces = []
  f.context.write = (view) => {
    assert.ok(view, 'fixed-length requests never use the chunked body terminator')
    pieces.push(...new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
  }
  f.cb.onWritable.call(f.context, 0)
  f.cb.onWritable.call(f.context, 1)
  f.cb.onWritable.call(f.context, 0)
  f.cb.onWritable.call(f.context, 2)
  f.cb.onWritable.call(f.context, 0)
  f.cb.onHeaders(201, new Map())
  f.cb.onDone()
  assert.equal((await f.promise).status, 201)
  assert.equal(String.fromCharCode(...pieces), 'abc')
})

test('closing a client suppresses late DNS results without affecting the next client', () => {
  const lookups = [],
    sockets = [],
    errors = []
  let closes = 0
  class DNS {
    resolve(request) {
      lookups.push(request)
    }
  }
  class Client {
    constructor(options) {
      new options.dns.io(options.dns).resolve({
        host: options.host,
        onResolved: (host, address) => sockets.push({ host, address }),
        onError: options.onError,
      })
    }
    request(options) {
      return options
    }
    close() {
      closes++
    }
  }
  const options = { host: 'service.test', dns: { io: DNS }, onError: (error) => errors.push(error) }
  const first = createClosingClient(Client, options)
  assert.equal(first.request('request'), 'request')
  first.close()
  const second = createClosingClient(Client, options)
  lookups[0].onResolved('service.test', '192.0.2.1')
  lookups[0].onError(new Error('late DNS'))
  assert.deepEqual(sockets, [])
  assert.deepEqual(errors, [])
  lookups[1].onResolved('service.test', '192.0.2.2')
  assert.deepEqual(sockets, [{ host: 'service.test', address: '192.0.2.2' }])
  second.close()
  assert.equal(closes, 2)
})
test('every failure closes the SDK socket and settles the bounded request once', async () => {
  for (const fail of [
    (f) => f.expire(),
    (f) => f.connection.onError(),
    (f) => f.cb.onDone(),
    (f) => f.cb.onDone(new Error('socket')),
    (f) => f.cb.onHeaders(200, new Map([['content-length', '131073']])),
    (f) => {
      f.cb.onHeaders(200, new Map())
      f.cb.onReadable.call(f.context, 131073)
    },
  ]) {
    const f = fixture()
    fail(f)
    await assert.rejects(f.promise)
    f.cb.onHeaders(200, new Map())
    f.cb.onReadable.call(f.context, 1)
    f.cb.onDone()
    assert.equal(f.closes, 1)
    assert.equal(f.cancels, 1)
  }
})
function proxyFixture() {
  const timers = [],
    sent = []
  let workers = 0
  const worker = {
    postMessage(message) {
      sent.push(message)
    },
  }
  const fetch = createHttpProxy({
    createWorker() {
      workers++
      return worker
    },
    normalize,
    decode,
    now: () => 10,
    schedule(callback, ms) {
      const timer = { callback, ms }
      timers.push(timer)
      return timer
    },
    cancel(timer) {
      timer.cancelled = true
    },
  })
  return {
    fetch,
    timers,
    sent,
    worker,
    get workers() {
      return workers
    },
    post: (options = {}) => fetch('https://service/path', { method: 'POST', ...options }),
  }
}
test('the HTTP Worker is reused and independent responses retain their request identity', async () => {
  const f = proxyFixture(),
    a = f.post(),
    b = f.post()
  assert.equal(f.workers, 1)
  f.worker.onmessage({ id: f.sent[1].id, status: 201, body: encode('second') })
  f.worker.onmessage({ id: f.sent[0].id, status: 429, body: encode('first') })
  assert.equal(await (await b).text(), 'second')
  assert.equal((await a).ok, false)
  assert.equal(await (await a).text(), 'first')
  assert.ok(f.timers.every((t) => t.cancelled))
})
test('caller deadlines include Worker delivery/queue time; late replies cannot settle another request', async () => {
  const f = proxyFixture(),
    a = f.post({ timeoutMs: 1000 })
  assert.equal(f.sent[0].started, 10)
  f.timers[0].callback()
  await assert.rejects(a, (error) => error.errorCode === 'https_timeout' && /timed out/.test(error.message))
  const b = f.post()
  f.worker.onmessage({ id: f.sent[0].id, status: 200, body: encode('late') })
  f.worker.onmessage({ id: f.sent.at(-1).id, error: 'socket failed' })
  await assert.rejects(b, /socket failed/)
})
test('IPC and request capacity failures reject without creating an unbounded queue', async () => {
  const f = proxyFixture(),
    requests = Array.from({ length: 8 }, () => f.post())
  await assert.rejects(f.post(), /capacity/)
  for (const m of f.sent) f.worker.onmessage({ id: m.id, status: 200, body: encode('') })
  await Promise.all(requests)
  f.worker.postMessage = () => {
    throw new Error('queue full')
  }
  await assert.rejects(f.post(), /queue full/)
  assert.ok(f.timers.at(-1).cancelled)
  const g = proxyFixture()
  await assert.rejects(g.fetch('http://insecure/a', { method: 'POST' }), URIError)
  assert.equal(g.sent.length, 0)
})

test('the HTTP proxy releases its VM after actual request cleanup on success, failure, and caller timeout', async () => {
  for (const outcome of ['success', 'failure', 'timeout']) {
    const order = [],
      diagnostics = [],
      callerTimers = new Set(),
      deferredClose = []
    let callbacks, clientOptions
    const worker = {}
    const queue = createHttpQueue({
      execute: (request) =>
        requestHttps(request, {
          createClient(options) {
            clientOptions = options
            return {
              request(options) {
                callbacks = options
              },
              close() {
                order.push('socket closed')
              },
            }
          },
          schedule(callback, ms) {
            if (ms === 0) deferredClose.push(callback)
            return callback
          },
          cancel() {},
        }),
      post: (message) => queueMicrotask(() => worker.onmessage(message)),
      onIdle(id) {
        order.push('worker idle')
        queueMicrotask(() => worker.onmessage({ idle: id }))
      },
      schedule: () => assert.fail('no IPC retries expected'),
      elapsed: () => 0,
    })
    worker.postMessage = (message) => queueMicrotask(() => queue(message))
    const fetch = createHttpProxy({
      diagnose: (event, fields) => diagnostics.push({ event, ...(typeof fields === 'function' ? fields() : fields) }),
      createWorker: () => worker,
      releaseWorker() {
        order.push('VM released')
      },
      normalize,
      decode,
      now: () => 0,
      schedule(callback) {
        callerTimers.add(callback)
        return callback
      },
      cancel: (timer) => callerTimers.delete(timer),
    })
    const request = fetch('https://service.test/path', { method: 'POST' })
    const result = outcome === 'success' ? request : assert.rejects(request, /failed|timed out/)
    await new Promise(setImmediate)
    assert.equal(diagnostics[0].event, 'worker.created')
    assert.ok(diagnostics.some((e) => e.event === 'job.posted' && e.request === 1))
    if (outcome === 'timeout') {
      const timer = [...callerTimers][0]
      callerTimers.delete(timer)
      timer()
      await result
      assert.deepEqual(order, [], 'the caller deadline cannot free an active TLS VM')
    }
    if (outcome === 'failure') clientOptions.onError()
    else {
      callbacks.onHeaders(200, new Map())
      callbacks.onDone()
    }
    assert.deepEqual(order, [], 'SDK socket close is deferred outside its callback')
    deferredClose.shift()()
    await result
    await new Promise(setImmediate)
    assert.equal(diagnostics.at(-1).event, 'worker.released')
    assert.ok(diagnostics.some((e) => e.event === 'worker.idle'))
    assert.ok(!JSON.stringify(diagnostics).includes('service.test'))
    assert.deepEqual(order, ['socket closed', 'worker idle', 'VM released'])
    assert.equal(callerTimers.size, 0)
  }
})

test('TLS callback exceptions become socket errors without escaping the I/O task', () => {
  class Socket {
    constructor(options) {
      this.options = options
    }
  }
  const errors = [],
    failure = new Error('certificate authentication failed')
  const Checked = guardSocketCallbacks(Socket)
  const socket = new Checked({
    format: 'buffer',
    onReadable(count) {
      assert.equal(this, socket)
      return count
    },
    onWritable() {
      throw failure
    },
    onError(error) {
      assert.equal(this, socket)
      errors.push(error)
    },
  })
  assert.equal(socket.options.format, 'buffer')
  assert.equal(socket.options.onReadable.call(socket, 42), 42)
  assert.doesNotThrow(() => socket.options.onWritable.call(socket, 1))
  assert.deepEqual(errors, [failure])
})

test('socket observations count accepted bytes and expose the current buffered count without changing I/O', () => {
  class Socket {
    readable = 9
    format = 'buffer'
    constructor(options) {
      this.options = options
    }
    read(value) {
      return value === undefined ? new ArrayBuffer(3) : value.byteLength
    }
    write() {
      return 17
    }
  }
  const statistics = { socketReceived: 0, socketWritten: 0 }
  const Observed = guardSocketCallbacks(Socket, statistics)
  const socket = new Observed({})
  assert.equal(socket.read().byteLength, 3)
  assert.equal(socket.read(new Uint8Array(2)), 2)
  assert.equal(socket.write(new ArrayBuffer(7)), 17)
  assert.deepEqual([statistics.socketReceived, statistics.socketWritten, statistics.socketBuffered], [5, 7, 9])
  socket.readable = 0
  assert.equal(statistics.socketBuffered, 0)
})

test('diagnostic native queue observation consumes no bytes and distinguishes stale readable counts', () => {
  class Socket {
    format = 'buffer'
    queued = 0
    consumed = 0
    read(count) {
      if (!this.queued) return
      if (count <= 0) throw new Error('invalid')
      this.consumed += count
      this.queued -= count
      return new ArrayBuffer(count)
    }
  }
  const statistics = { socketReceived: 0, socketWritten: 0 }
  const Observed = guardSocketCallbacks(Socket, statistics)
  const socket = new Observed({})
  assert.equal(statistics.socketPending, 0)
  socket.queued = 42
  socket.readable = 0
  assert.equal(statistics.socketPending, 1)
  assert.equal(socket.consumed, 0)
  assert.equal(statistics.socketReceived, 0)
  assert.equal(socket.queued, 42)
  assert.equal(httpFailureMetadata(statistics).socketPending, 1)
  socket.format = 'number'
  assert.equal(statistics.socketPending, -1)
  assert.equal(socket.consumed, 0)
  socket.format = 'buffer'
  Socket.prototype.read = () => {
    throw new Error('closed')
  }
  assert.equal(statistics.socketPending, -1)
  Object.defineProperty(socket, 'format', {
    get() {
      throw new Error('invalid host data')
    },
  })
  assert.equal(statistics.socketPending, -1)
  assert.equal(JSON.parse(JSON.stringify(statistics)).socketPending, -1)
})

test('fragmented responses preserve every byte up to the response limit', async () => {
  const f = fixture()
  let offset = 0
  f.context.read = (view) => {
    for (let i = 0; i < view.length; i++) view[i] = (offset + i) % 251
    offset += view.length
    return view.length
  }
  f.cb.onHeaders(200, new Map())
  for (let i = 0; i < 128; i++) f.cb.onReadable.call(f.context, 1024)
  f.cb.onDone()
  const bytes = new Uint8Array((await f.promise).body)
  assert.equal(bytes.length, 131072)
  assert.ok(bytes.every((value, i) => value === i % 251))
  assert.equal(f.closes, 1)
})

test('streamed overflow rejects after earlier fragments were accepted', async () => {
  const f = fixture()
  f.cb.onHeaders(200, new Map())
  f.cb.onReadable.call(f.context, 131072)
  f.cb.onReadable.call(f.context, 1)
  await assert.rejects(f.promise, /limit/)
  assert.equal(f.closes, 1)
})

test('cancellation reaches the worker and a late response cannot settle the next job', async () => {
  const f = proxyFixture()
  const first = f.post()
  first.cancel()
  await assert.rejects(first, /cancelled/)
  assert.deepEqual(f.sent[1], { id: f.sent[0].id, cancel: true })
  const second = f.post()
  f.worker.onmessage({ id: f.sent[0].id, status: 201, body: encode('late') })
  f.worker.onmessage({
    id: f.sent.at(-1).id,
    status: 201,
    location: '/v1/realtime/calls/rtc_test',
    body: encode('sdp'),
  })
  assert.equal((await second).location, '/v1/realtime/calls/rtc_test')
  assert.equal(await (await second).text(), 'sdp')
})

test('canceling an active HTTPS request closes its socket exactly once', async () => {
  let stop
  let closes = 0
  const request = requestHttps(
    post(),
    {
      createClient: () => ({
        request() {},
        close() {
          closes++
        },
      }),
      schedule: (fn, ms) => {
        if (!ms) queueMicrotask(fn)
        return 1
      },
      cancel() {},
    },
    (cancel) => {
      stop = cancel
    },
  )
  stop()
  stop()
  await assert.rejects(request, /cancelled/)
  assert.equal(closes, 1)
})

test('HTTP worker reduces incremental SSE and returns only bounded answer plus call headers', async () => {
  let callbacks,
    closes = 0,
    offset = 0
  const bytes = new TextEncoder().encode(
    'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Cześć 🌍"}]}]}}\n\n',
  )
  const platform = {
    createSubscriptionStream: () => createSubscriptionStream(decode, encode),
    createClient: () => ({
      request: (options) => {
        callbacks = options
      },
      close: () => {
        closes++
      },
    }),
    schedule: (fn, ms) => (ms === 0 ? queueMicrotask(fn) : 1),
    cancel() {},
  }
  const request = requestHttps(post({ responseFormat: 'subscription-response' }), platform)
  callbacks.onHeaders(
    200,
    new Map([
      ['content-type', 'text/event-stream; charset=utf-8'],
      ['openai-session-id', 'rtc_fixture'],
      ['set-cookie', 'must-not-cross-ipc'],
    ]),
  )
  const context = {
    read(view) {
      view.set(bytes.subarray(offset, offset + view.length))
      offset += view.length
      return view.length
    },
  }
  for (let index = 0; index < bytes.length; index++) callbacks.onReadable.call(context, 1)
  callbacks.onDone()
  const response = await request
  assert.equal(JSON.parse(decode(response.body)).answer, 'Cześć 🌍')
  assert.deepEqual(response.headers, {
    'openai-session-id': 'rtc_fixture',
    'content-type': 'text/event-stream; charset=utf-8',
  })
  assert.equal(closes, 1)
  const oversized = requestHttps(post({ responseFormat: 'subscription-response' }), platform)
  callbacks.onHeaders(
    200,
    new Map([
      ['content-type', 'text/event-stream'],
      ['content-length', '2097153'],
    ]),
  )
  await assert.rejects(oversized, /exceeds limit/)
  assert.equal(closes, 2)
  let cancel
  const cancelled = requestHttps(post({ responseFormat: 'subscription-response' }), platform, (value) => {
    cancel = value
  })
  callbacks.onHeaders(200, new Map([['content-type', 'text/event-stream']]))
  cancel()
  await assert.rejects(cancelled, /cancelled/)
  assert.equal(closes, 3)
})

test('HTTP stream failures preserve safe categories and progress across the worker boundary', async () => {
  for (const [text, expected, done] of [
    ['data: private-secret-not-json\n\n', 'subscription_event_json', false],
    ['data: {"type":"response.created"}\n\n', 'subscription_stream_incomplete', true],
    ['data: ' + 'x'.repeat(32769), 'subscription_event_limit', false],
  ]) {
    let callbacks, reply
    const diagnostics = [],
      timers = new Set()
    const worker = {}
    const queue = createHttpQueue({
      execute: (request) =>
        requestHttps(request, {
          createClient: () => ({
            request: (value) => {
              callbacks = value
            },
            close() {},
          }),
          createSubscriptionStream: () => createSubscriptionStream(decode, encode),
          schedule: (callback, ms) => (ms ? 1 : queueMicrotask(callback)),
          cancel() {},
        }),
      post: (message) => {
        reply = message
        worker.onmessage(message)
      },
      schedule: () => assert.fail('IPC retry not expected'),
      elapsed: () => 0,
    })
    worker.postMessage = (message) => {
      void queue(message)
    }
    const fetch = createHttpProxy({
      createWorker: () => worker,
      normalize,
      decode,
      now: () => 0,
      schedule: (callback) => {
        timers.add(callback)
        return callback
      },
      cancel: (callback) => timers.delete(callback),
      diagnose: (event, data) => diagnostics.push({ event, ...data?.() }),
    })
    const request = fetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      responseFormat: 'subscription-response',
    })
    const rejected = assert.rejects(request, (error) => {
      assert.equal(error.errorCode, expected)
      assert.equal(error.status, 200)
      assert.equal(error.phase, done ? 'finish' : 'read')
      assert.equal(error.received, encode(text).byteLength)
      return true
    })
    await new Promise(setImmediate)
    callbacks.onHeaders(200, new Map([['content-type', 'text/event-stream']]))
    let offset = 0
    const bytes = new Uint8Array(encode(text))
    callbacks.onReadable.call(
      {
        read(view) {
          view.set(bytes.subarray(offset, offset + view.length))
          offset += view.length
          return view.length
        },
      },
      bytes.length,
    )
    if (done) callbacks.onDone()
    await rejected
    assert.equal(reply.errorCode, expected)
    assert.equal(timers.size, 0)
    assert.equal(diagnostics.find((d) => d.event === 'job.failed').errorCode, expected)
    assert.ok(!JSON.stringify(diagnostics).includes('private-secret'))
  }
})

test('Codex SSE completion is validated even when the response media type is absent', async () => {
  for (const mediaType of [undefined, 'application/octet-stream', 'text/event-stream']) {
    let callbacks
    const request = requestHttps(post({ responseFormat: 'subscription-response' }), {
      createClient: () => ({
        request: (value) => {
          callbacks = value
        },
        close() {},
      }),
      createSubscriptionStream: () => createSubscriptionStream(decode, encode),
      schedule: (callback, ms) => (ms ? 1 : queueMicrotask(callback)),
      cancel() {},
    })
    callbacks.onHeaders(200, new Map(mediaType ? [['content-type', mediaType]] : []))
    const bytes = new Uint8Array(
      encode(
        'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"323"}]}]}}\n\n',
      ),
    )
    callbacks.onReadable.call(
      {
        read(view) {
          view.set(bytes)
          return bytes.length
        },
      },
      bytes.length,
    )
    callbacks.onDone()
    assert.equal(JSON.parse(decode((await request).body)).answer, '323')
  }
})

test('SDK transport failures retain only recognized reasons and numeric codes', async () => {
  for (const cause of [new Error('bad response'), Object.assign(new Error('synthetic-private'), { code: -42 }), -23]) {
    const f = fixture()
    f.cb.onDone(cause)
    await assert.rejects(f.promise, (error) => {
      assert.ok(!error.message.includes('synthetic-private'))
      assert.equal(error.reason, cause?.message === 'bad response' ? 'bad_response' : undefined)
      assert.equal(error.code, typeof cause === 'number' ? cause : cause.code)
      return true
    })
  }
})

test('the SDK generic onDone cannot hide its following TLS error', async () => {
  for (const [message, reason, code] of [
    ['recordProtocol: auth failed', 'tls_record_auth', undefined],
    ['recordProtocol auth failed', 'tls_record_auth', undefined],
    ['alert: 2, 20', 'tls_alert', 532],
    ['synthetic-private-TLS-message', undefined, undefined],
  ]) {
    const f = fixture()
    f.cb.onWritable.call(f.context, 3)
    f.cb.onDone(new Error())
    f.connection.onError(new Error(message))
    await assert.rejects(f.promise, (error) => {
      const metadata = httpFailureMetadata(error)
      assert.equal(metadata.errorCode, 'https_connection')
      assert.equal(metadata.phase, 'sent')
      assert.equal(metadata.written, 3)
      assert.equal(metadata.expected, 3)
      assert.equal(metadata.reason, reason)
      assert.equal(metadata.code, code)
      assert.ok(!JSON.stringify(metadata).includes('private'))
      return true
    })
    assert.equal(f.closes, 1)
  }
})

test('Codex terminal events settle and close HTTPS without waiting for HTTP EOF', async () => {
  for (const event of [
    {
      type: 'response.completed',
      response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '323' }] }] },
    },
    { type: 'response.failed', response: { error: { code: 'unsupported_value', param: 'reasoning.effort' } } },
  ]) {
    let callbacks,
      connection,
      closes = 0,
      cancelled = 0
    const request = requestHttps(post({ responseFormat: 'subscription-response' }), {
      createClient: (options) => {
        connection = options
        return {
          request: (value) => {
            callbacks = value
          },
          close: () => closes++,
        }
      },
      createSubscriptionStream: () => createSubscriptionStream(decode, encode),
      schedule: (callback, ms) => (ms ? 1 : queueMicrotask(callback)),
      cancel: () => cancelled++,
    })
    callbacks.onHeaders(200, new Map())
    const bytes = new Uint8Array(encode(`data: ${JSON.stringify(event)}\n\ndata: trailing-without-EOF`))
    callbacks.onReadable.call(
      {
        read(view) {
          view.set(bytes)
          return bytes.length
        },
      },
      bytes.length,
    )
    // No onDone: the server may keep its HTTP stream open after the terminal event.
    let timeout
    try {
      const response = await Promise.race([
        request,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('terminal response waited for EOF')), 100)
        }),
      ])
      const result = JSON.parse(decode(response.body))
      assert.equal(
        result.answer ?? result.providerCode,
        event.type === 'response.completed' ? '323' : 'unsupported_value',
      )
      assert.equal(closes, 1)
      assert.equal(cancelled, 1)
      callbacks.onDone(new Error('late close'))
      connection.onError(new Error('late socket'))
      assert.equal(closes, 1)
    } finally {
      clearTimeout(timeout)
    }
  }
})

test('HTTP progress is bounded metadata and caller deadlines retain the last observation', async () => {
  const f = proxyFixture(),
    pending = f.post()
  f.worker.onmessage({ id: f.sent[0].id, progress: { phase: 'headers', status: 200, received: 0 } })
  f.worker.onmessage({ id: f.sent[0].id, progress: { phase: 'read', status: 200, received: 1024 } })
  assert.equal(f.timers[0].cancelled, undefined, 'progress cannot settle the request')
  f.timers[0].callback()
  await assert.rejects(
    pending,
    (error) =>
      error.errorCode === 'https_timeout' && error.status === 200 && error.phase === 'read' && error.received === 1024,
  )
})

test('HTTP milestones distinguish a partial request from a fully sent body without exposing data', async () => {
  let callbacks
  const milestones = []
  const request = requestHttps(
    post({ body: 'synthetic-private-request' }),
    {
      createClient: () => ({
        request: (value) => {
          callbacks = value
        },
        close() {},
      }),
      schedule: (callback, ms) => (ms ? 1 : queueMicrotask(callback)),
      cancel() {},
    },
    undefined,
    (fields) => milestones.push(fields),
  )
  const context = {
    write() {},
    read(view) {
      view.fill(42)
      return view.length
    },
  }
  callbacks.onWritable.call(context, 2)
  callbacks.onWritable.call(context, 100)
  callbacks.onHeaders(200, new Map())
  callbacks.onReadable.call(context, 2)
  callbacks.onReadable.call(context, 1)
  callbacks.onDone()
  await request
  assert.deepEqual(milestones, [
    { phase: 'write', received: 0, written: 2, expected: 25 },
    { phase: 'sent', received: 0, written: 25, expected: 25 },
    { phase: 'headers', status: 200, received: 0 },
    { phase: 'read', status: 200, received: 2 },
  ])
  assert.ok(!JSON.stringify(milestones).includes('synthetic-private'))
})
