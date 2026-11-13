import RealtimeConversation from 'realtimeConversation'
import { createSubscription, openSubscriptionControl } from 'realtimeConversation/subscription'
import { SubscriptionAuth } from 'realtimeConversation/subscription-auth'
import { createSubscriptionStream } from 'realtimeConversation/subscription-stream'
import { assert, equal } from 'testing/assert'
import TextDecoder from 'text/decoder'
import Timer from 'timer'

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
const stream = createSubscriptionStream(
  (bytes) => decoder.decode(bytes),
  (text) => ArrayBuffer.fromString(text),
)
const event = ArrayBuffer.fromString(
  'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Żółw 🌍"}]}]}}\n\n',
)
for (let index = 0; index < event.byteLength; index++) stream.write(new Uint8Array(event.slice(index, index + 1)))
equal(JSON.parse(decoder.decode(stream.finish())).answer, 'Żółw 🌍')
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
