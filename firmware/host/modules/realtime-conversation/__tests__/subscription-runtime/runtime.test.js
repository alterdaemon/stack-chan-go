import { createSubscription, openSubscriptionControl } from 'realtimeConversation/subscription'
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
} catch {}
lateDNS.onResolved('api.openai.com', '192.0.2.1')
equal(connected, 0, 'late DNS after cancellation cannot open a socket')
trace('@@STACKCHAN_TEST:PASS@@\n')
