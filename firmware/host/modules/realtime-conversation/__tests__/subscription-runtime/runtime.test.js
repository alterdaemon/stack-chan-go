import RealtimeConversation from 'realtimeConversation'
import { drainTLSSocket, requestHttps } from 'realtimeConversation/http-core'
import { createSubscription, openSubscriptionControl } from 'realtimeConversation/subscription'
import { SubscriptionAuth } from 'realtimeConversation/subscription-auth'
import { SubscriptionLive } from 'realtimeConversation/subscription-live'
import { createSubscriptionStream } from 'realtimeConversation/subscription-stream'
import Debug from 'device-debug'
import Modules from 'modules'
import { assert, equal } from 'testing/assert'
import TextDecoder from 'text/decoder'
import Timer from 'timer'

const probeMessages = []
const probes = Modules.importNow('device-debug/subscription-probes', true).createSubscriptionProbes({
  send: (message) => probeMessages.push(message),
})
await probes.run('probe', 'english')
equal(probeMessages[0].type, 'session.context.append', 'the lazy USB probe loads through the XS namespace')
equal(probeMessages[0].channel, 'speakable')
probes.reset()

let socket
class Socket {
  static close = 8
  constructor(options) {
    socket = this
    this.options = options
    this.writes = []
    this.closed = false
  }
  write(bytes, options) {
    this.writes.push({ bytes, options })
    return 0
  }
  read() {
    return this.readable
  }
  close() {
    this.closed = true
  }
  readableFrame(bytes, more) {
    this.readable = bytes
    this.options.onReadable(bytes.byteLength, { binary: false, more })
  }
}
globalThis.device = { network: { wss: { io: Socket }, ws: { io: Socket } } }
let signInRequired = false
try {
  createSubscription({})
} catch (error) {
  signInRequired = error.code === 'subscription_sign_in_required'
}
assert(signInRequired, 'missing subscription grant fails before opening a peer or control socket')
let lazySignInRequired = false
try {
  new RealtimeConversation({ auth: 'chatgpt' })
} catch (error) {
  lazySignInRequired = error.code === 'subscription_sign_in_required'
}
assert(lazySignInRequired, 'the host constructor loads the named factory through the actual XS namespace')
let answered = false
const ordering = new SubscriptionLive({
  auth: {
    credentials: async () => ({ accessToken: 'fixture', accountId: 'fixture' }),
    onLogout: () => () => {},
  },
  uuid: () => 'id',
  fetch: async () => ({
    ok: true,
    headers: { location: '/v1/live/rtc_ordering' },
    text: async () => 'v=0 answer',
  }),
  openControl: async () => {
    assert(answered, 'ICE activation must not wait for the sideband join')
    await new Promise((resolve) => Timer.set(resolve, 1))
    return { send() {}, close() {} }
  },
})
await ordering.create(
  'v=0 offer',
  {},
  () => {},
  () => true,
  (answer) => {
    equal(answer.callId, 'rtc_ordering')
    answered = true
  },
)
ordering.dispose()
const messages = []
const pending = openSubscriptionControl('rtc_fixture', { Authorization: 'Bearer synthetic' }, (message) =>
  messages.push(message),
)
socket.options.onWritable(4096)
const channel = await pending
equal(socket.options.host, 'api.openai.com')
equal(socket.options.path, '/v1/live/rtc_fixture')
equal(socket.options.headers.get('Authorization'), 'Bearer synthetic')
const text = '{"type":"session.input_transcript.delta","delta":"Cześć 🌍"}'
const frame = ArrayBuffer.fromString(text)
const decoder = new TextDecoder()
// Every byte is a separate SDK read, including the middle of multibyte characters.
for (let index = 0; index < frame.byteLength; index++)
  socket.readableFrame(frame.slice(index, index + 1), index + 1 < frame.byteLength)
equal(messages.length, 1)
equal(messages[0].delta, 'Cześć 🌍')
channel.send({ type: 'session.close' })
equal(JSON.parse(decoder.decode(socket.writes[0].bytes)).type, 'session.close')
channel.close()
assert(socket.closed)
let rejected = false
try {
  channel.send({ type: 'session.close' })
} catch {
  rejected = true
}
assert(rejected)
// The SDK hides upgrade failures. Observe only the bounded first status line;
// subsequent headers/body must neither change the code nor enter the error.
class TLS {
  constructor(options) {
    this.options = options
  }
  read(value) {
    return value === undefined ? this.byte : value
  }
}
class TCP {
  constructor(options) {
    this.options = options
  }
  write() {
    return 1024
  }
}
let dnsRequest
class ObservedDNS {
  resolve(request) {
    dnsRequest = request
  }
}
const networkEvents = []
Debug.install({
  enabled: true,
  emit(_scope, event, fields) {
    networkEvents.push({ event, ...(typeof fields === 'function' ? fields() : fields) })
  },
})
globalThis.device.network.wss = { io: Socket, dns: { io: ObservedDNS }, socket: { io: TLS, TCP: { io: TCP } } }
const observed = openSubscriptionControl('rtc_observed', {}, () => {})
new socket.options.dns.io().resolve({ onResolved() {} })
dnsRequest.onResolved('api.openai.com', '192.0.2.42')
let writableCount = 0
const tcp = new socket.options.socket.TCP.io({
  onWritable(count) {
    writableCount += count
  },
})
tcp.options.onWritable(100)
tcp.options.onWritable(100)
equal(writableCount, 200)
const tls = new socket.options.socket.io({
  TCP: socket.options.socket.TCP,
  onWritable(count) {
    writableCount += count
  },
})
tls.options.onWritable(100)
tls.options.onWritable(100)
for (const character of 'HTTP/1.1 101 Switching Protocols\r\nprivate-header: synthetic-secret\r\n') {
  tls.byte = character.charCodeAt(0)
  tls.read()
}
socket.options.onWritable(4096)
const observedChannel = await observed
equal(tcp.write(Uint8Array.of(1, 2, 3)), 1024)
equal(observedChannel.statistics().socketWritten, 3)
equal(observedChannel.statistics().socketPending, -1)
assert(tls.options.diagnosticStatistics, 'the TLS observer shares the same gated numeric counters')
socket.readableFrame(ArrayBuffer.fromString('{"type":"session.started"}'), false)
observedChannel.close()
equal(observedChannel.statistics(), undefined, 'closed control cannot inspect a released native socket')
const closedEvents = networkEvents.length
tls.options.onError(Object.assign(new Error('synthetic-sensitive-close'), { code: -3 }))
equal(networkEvents.length, closedEvents, 'intentional close cannot become a new transport failure')
for (const event of [
  'control.dns.start',
  'control.dns.ready',
  'control.tcp.ready',
  'control.tls.ready',
  'control.http',
  'control.ready',
  'control.first_message',
  'control.closed',
])
  equal(networkEvents.filter((entry) => entry.event === event).length, 1)
equal(networkEvents.find((entry) => entry.event === 'control.http').status, 101)
equal(networkEvents.find((entry) => entry.event === 'control.first_message').type, 'session.started')
assert(!JSON.stringify(networkEvents).includes('synthetic-secret'))
assert(!JSON.stringify(networkEvents).includes('192.0.2.42'))
globalThis.device.network.wss = { io: Socket, socket: { io: TLS } }
for (const [line, status] of [
  ['HTTP/1.1 403 Forbidden\r\n', 403],
  ['HTTP/1.0 404 Not Found\r\n', 404],
  ['invalid\r\n', undefined],
  [`${'x'.repeat(40)}\r\n`, undefined],
]) {
  const denied = openSubscriptionControl('rtc_denied', {}, () => {})
  const transport = new socket.options.socket.io({})
  for (const character of `${line}HTTP/1.1 401 synthetic-sensitive-header\r\n`) {
    transport.byte = character.charCodeAt(0)
    equal(transport.read(), transport.byte)
  }
  const buffer = new ArrayBuffer(1)
  equal(transport.read(buffer), buffer, 'the observer preserves buffered reads')
  socket.options.onError()
  let failure
  try {
    await denied
  } catch (error) {
    failure = error
  }
  equal(failure.code, 'subscription_control_failed')
  equal(failure.status, status)
  equal(failure.message, 'Subscription control connection failed')
}
class ErrorTLS extends TLS {
  read(value) {
    return value === undefined ? this.bytes.shift() : value
  }
}
globalThis.device.network.wss = { io: Socket, socket: { io: ErrorTLS } }
const deniedBody = JSON.stringify({
  error: { code: 'call_id_not_found', message: 'synthetic-private-rejection', param: 'session.model' },
})
const rejectedUpgrade = openSubscriptionControl('rtc_structured', {}, () => {})
const rejectedTransport = new socket.options.socket.io({
  onReadable() {
    for (const _character of 'HTTP/1.1 404 Not Found\r\n') this.read()
    socket.options.onError()
  },
})
rejectedTransport.bytes = Array.from(
  new Uint8Array(
    ArrayBuffer.fromString(
      `HTTP/1.1 404 Not Found\r\nContent-Length: ${deniedBody.length}\r\nContent-Type: application/json\r\n\r\n${deniedBody}`,
    ),
  ),
)
rejectedTransport.options.onReadable.call(rejectedTransport, rejectedTransport.bytes.length)
try {
  await rejectedUpgrade
  assert(false, 'denied upgrade connected')
} catch (error) {
  equal(error.status, 404)
  equal(error.providerCode, 'call_id_not_found')
  equal(error.param, 'session.model')
}
assert(!JSON.stringify(networkEvents).includes('synthetic-private-rejection'), 'error bodies never enter diagnostics')
globalThis.device.network.wss = undefined
try {
  await openSubscriptionControl('rtc_unavailable', {}, () => {})
  assert(false, 'missing WSS must reject')
} catch (error) {
  equal(error.code, 'subscription_control_unavailable')
}
const stream = createSubscriptionStream(
  (bytes) => decoder.decode(bytes),
  (text) => ArrayBuffer.fromString(text),
)
const event = ArrayBuffer.fromString(
  'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Żółw 🌍"}]}]}}\n\n',
)
for (let index = 0; index < event.byteLength; index++) stream.write(new Uint8Array(event.slice(index, index + 1)))
equal(JSON.parse(decoder.decode(stream.finish())).answer, 'Żółw 🌍')
const codexStream = createSubscriptionStream(
  (bytes) => decoder.decode(bytes),
  (text) => ArrayBuffer.fromString(text),
)
const codexEvents = [
  {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Żółw 🌍' }],
    },
  },
  { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [] } },
]
for (const value of codexEvents) {
  const bytes = ArrayBuffer.fromString(`data: ${JSON.stringify(value)}\n\n`)
  for (let index = 0; index < bytes.byteLength; index++)
    codexStream.write(new Uint8Array(bytes.slice(index, index + 1)))
}
equal(JSON.parse(decoder.decode(codexStream.finish())).answer, 'Żółw 🌍')
async function verifyTerminalAndTLS() {
  let terminalCallbacks,
    terminalCloses = 0
  const terminalRequest = requestHttps(
    {
      headers: [],
      body: new ArrayBuffer(0),
      timeoutMs: 1000,
      responseFormat: 'subscription-response',
    },
    {
      createClient: () => ({
        request: (value) => {
          terminalCallbacks = value
        },
        close: () => terminalCloses++,
      }),
      createSubscriptionStream: () =>
        createSubscriptionStream(
          (bytes) => decoder.decode(bytes),
          (text) => ArrayBuffer.fromString(text),
        ),
      schedule: (callback, delay) => Timer.set(callback, delay),
      cancel: (timer) => Timer.clear(timer),
    },
  )
  terminalCallbacks.onHeaders(200, new Map())
  const terminalBytes = new Uint8Array(
    ArrayBuffer.fromString(codexEvents.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('')),
  )
  terminalCallbacks.onReadable.call(
    {
      read(view) {
        view.set(terminalBytes)
        return terminalBytes.length
      },
    },
    terminalBytes.length,
  )
  const terminalResponse = await terminalRequest
  equal(JSON.parse(decoder.decode(terminalResponse.body)).answer, 'Żółw 🌍')
  equal(terminalCloses, 1, 'terminal completion closes HTTP without waiting for EOF')
  let rawTLS,
    tlsReads = 0,
    tlsDelivered = 0
  class RawTLS {
    constructor(options) {
      rawTLS = this
      this.options = options
    }
  }
  class BufferedTLS {
    constructor(options) {
      this.format = 'number'
      const owner = this
      new options.TCP.io({
        onReadable(count) {
          tlsReads++
          this.readable = count - 1
          if (count === 1) options.onReadable.call(owner, 1)
          return 'read_result'
        },
      })
    }
    read() {
      return 42
    }
    close() {}
  }
  const DrainingTLS = drainTLSSocket(
    BufferedTLS,
    (callback, delay) => Timer.set(callback, delay),
    (timer) => Timer.clear(timer),
  )
  const tlsStatistics = {}
  let observations = 0
  let drainingTLS = new DrainingTLS({
    diagnosticStatistics: tlsStatistics,
    diagnosticObservation() {
      observations++
      equal(tlsStatistics.tlsRead, 1)
      equal(tlsStatistics.tlsBuffered, 0)
    },
    TCP: { io: RawTLS },
    onReadable() {
      equal(this, drainingTLS)
      equal(this.read(), 42)
      tlsDelivered++
    },
  })
  equal(rawTLS.options.onReadable.call(rawTLS, 3), 'read_result')
  await new Promise((resolve) => Timer.set(resolve, 10))
  equal(tlsReads, 3)
  equal(tlsDelivered, 1)
  equal(tlsStatistics.tlsReceived, 1)
  equal(tlsStatistics.tlsRead, 1)
  equal(tlsStatistics.tlsBuffered, 0)
  equal(observations, 1, 'first decoded boundary is retained without a polling timer')
  rawTLS.options.onReadable.call(rawTLS, 1)
  equal(observations, 1, 'later records do not duplicate the first-boundary observation')
  drainingTLS.close()
  tlsReads = tlsDelivered = 0
  drainingTLS = new DrainingTLS({
    TCP: { io: RawTLS },
    onReadable() {
      tlsDelivered++
    },
  })
  rawTLS.options.onReadable.call(rawTLS, 3)
  drainingTLS.close()
  await new Promise((resolve) => Timer.set(resolve, 10))
  equal(tlsReads, 1, 'close cancels queued TLS draining')
  equal(tlsDelivered, 0)
  const previousNetwork = device.network.wss
  device.network.wss = { io: Socket, socket: { io: BufferedTLS, TCP: { io: RawTLS } } }
  const joining = openSubscriptionControl('rtc_drain_fixture', {}, () => {})
  const webSocket = socket
  tlsReads = tlsDelivered = 0
  const controlTLS = new webSocket.options.socket.io({
    TCP: webSocket.options.socket.TCP,
    onReadable() {
      equal(this.read(), 42)
      tlsDelivered++
    },
  })
  rawTLS.options.onReadable.call(rawTLS, 3)
  await new Promise((resolve) => Timer.set(resolve, 10))
  equal(tlsReads, 3, 'actual WSS socket composition drains empty TLS records')
  equal(tlsDelivered, 1)
  webSocket.options.onWritable(4096)
  const control = await joining
  control.close()
  controlTLS.close()
  device.network.wss = previousNetwork
}
await verifyTerminalAndTLS()
async function verifySDKErrorOrder() {
  for (const detailed of [true, false]) {
    let callbacks,
      clientCallbacks,
      closes = 0
    const request = requestHttps(
      { headers: [], body: new ArrayBuffer(0), timeoutMs: 1000 },
      {
        createClient(options) {
          clientCallbacks = options
          return {
            request(value) {
              callbacks = value
            },
            close() {
              closes++
            },
          }
        },
        schedule: (callback, delay) => Timer.set(callback, delay),
        cancel: (timer) => Timer.clear(timer),
      },
    )
    callbacks.onDone(new Error())
    if (detailed) clientCallbacks.onError(new Error('recordProtocol: auth failed'))
    let failure
    try {
      await request
    } catch (error) {
      failure = error
    }
    assert(failure)
    equal(failure.reason, detailed ? 'tls_record_auth' : undefined)
    await new Promise((resolve) => Timer.set(resolve, 5))
    equal(closes, 1, 'generic fallback and detailed socket failure close once')
  }
}
await verifySDKErrorOrder()
await new Promise((resolve) => Timer.set(resolve, 1))
let lateDNS,
  connected = 0
class DNS {
  resolve(request) {
    lateDNS = request
  }
}
class DelayedSocket extends Socket {
  constructor(options) {
    super(options)
    new options.dns.io().resolve({
      onResolved() {
        connected++
      },
    })
  }
}
globalThis.device.network.wss = { io: DelayedSocket, dns: { io: DNS } }
const cancelled = openSubscriptionControl('rtc_cancelled', {}, () => {})
socket.options.onError()
try {
  await cancelled
} catch (error) {
  equal(error.code, 'subscription_control_failed')
}
lateDNS.onResolved('api.openai.com', '192.0.2.1')
equal(connected, 0, 'late DNS after cancellation cannot open a socket')
// Actual XS/Timer authorization, persisted identity, independent reboot renewal and deletion.
let saved,
  exchanges = 0
const store = {
  available: () => true,
  read: () => saved,
  write: (value) => {
    saved = value
  },
  clear: () => {
    saved = undefined
  },
}
const options = {
  store,
  schedule: (callback, delay) => Timer.set(callback, delay),
  cancel: (timer) => Timer.clear(timer),
  now: () => 1000000,
  decodeClaims: () => ({
    iss: 'https://auth.openai.com',
    sub: 'fixture',
    exp: 2000,
    'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' },
  }),
  fetch: async (url) => {
    let value
    if (url.endsWith('/usercode')) value = { device_auth_id: 'fixture-device', user_code: 'TEST', interval: 1 }
    else if (url.endsWith('/deviceauth/token'))
      value = { authorization_code: 'fixture-code', code_verifier: 'fixture-verifier' }
    else {
      exchanges++
      value = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 1000 }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(value) }
  },
}
const firstBoot = new SubscriptionAuth(options)
await firstBoot.start()
await new Promise((resolve) => Timer.set(resolve, 1100))
assert(firstBoot.status().signedIn && !firstBoot.status().volatile)
assert(saved.refreshToken && !saved.accessToken)
const nextBoot = new SubscriptionAuth(options)
await nextBoot.credentials()
equal(exchanges, 2, 'reboot renews independently rather than using an old access token')
nextBoot.logout()
assert(!new SubscriptionAuth(options).status().signedIn, 'logout survives restart')
trace('@@STACKCHAN_TEST:PASS@@\n')
