import fetch from 'realtimeConversation/http'
import { closingDNS, guardSocketCallbacks } from 'realtimeConversation/http-core'
import { SubscriptionAuth } from 'realtimeConversation/subscription-auth'
import { SubscriptionLive } from 'realtimeConversation/subscription-live'
import store from 'realtimeConversation/subscription-store'
import Base64 from 'base64'
import RNG from 'rng'
import TextDecoder from 'text/decoder'
import Timer from 'timer'

const decoder = new TextDecoder('utf-8', { fatal: true })
const auth = new SubscriptionAuth({
  store,
  fetch,
  schedule: (callback, delay) => Timer.set(callback, delay),
  cancel: (timer) => Timer.clear(timer),
  decodeClaims(token) {
    const parts = token.split('.')
    if (parts.length !== 3 || parts[1].length > 16384) throw new Error('Invalid authorization claims')
    let value = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (value.length % 4) value += '='
    return JSON.parse(decoder.decode(Base64.decode(value)))
  },
})

// ECMA-419 WSS control only: no media, extra Worker, or idle polling loop.
export function openSubscriptionControl(callId, headers, onMessage) {
  return new Promise((resolve, reject) => {
    const network = device.network.wss
    const Client = network?.io ?? device.network.ws?.io
    if (!network || typeof Client !== 'function')
      throw Object.assign(new Error('Subscription control unavailable'), { code: 'subscription_control_unavailable' })
    let socket,
      opened = false,
      closed = false,
      writable = 0,
      queued = 0,
      incoming = [],
      incomingSize = 0,
      upgradeStatus
    const Socket = network.socket?.io
    const CheckedSocket =
      typeof Socket === 'function'
        ? class extends guardSocketCallbacks(Socket) {
            #statusLine = ''
            read(data) {
              const value = data === undefined ? super.read() : super.read(data)
              if (this.#statusLine !== undefined && typeof value === 'number') {
                if (value === 10) {
                  const match = /^HTTP\/1\.[01] ([1-5][0-9]{2}) /.exec(this.#statusLine)
                  if (match) upgradeStatus = Number(match[1])
                  this.#statusLine = undefined
                } else if (this.#statusLine.length < 32) this.#statusLine += String.fromCharCode(value)
                else this.#statusLine = undefined
              }
              return value
            }
          }
        : Socket
    const queue = []
    const fail = (timedOut = false) => {
      channel.close()
      if (!opened)
        reject(
          Object.assign(new Error('Subscription control connection failed'), {
            code: timedOut === true ? 'subscription_control_timeout' : 'subscription_control_failed',
            ...(upgradeStatus === undefined ? {} : { status: upgradeStatus }),
          }),
        )
      else onMessage({ type: 'error', error: { code: 'subscription_control_lost' } })
    }
    const flush = () => {
      while (queue.length && writable > 0 && !closed) {
        const item = queue[0]
        const count = Math.min(writable, item.byteLength)
        writable = socket.write(item.slice(0, count), { binary: false, more: count < item.byteLength })
        queued -= count
        if (count === item.byteLength) queue.shift()
        else queue[0] = item.slice(count)
      }
    }
    const channel = {
      send(message) {
        if (closed) throw new Error('Subscription control is closed')
        const data = ArrayBuffer.fromString(JSON.stringify(message))
        if (data.byteLength > 8192 || queued + data.byteLength > 16384 || queue.length >= 24)
          throw new Error('Subscription control backpressure')
        queue.push(data)
        queued += data.byteLength
        flush()
      },
      close() {
        if (closed) return
        closed = true
        Timer.clear(deadline)
        queue.length = 0
        incoming = []
        incomingSize = 0
        try {
          socket?.close()
        } catch {}
      },
    }
    const deadline = Timer.set(() => fail(true), 15000)
    try {
      socket = new Client({
        ...network,
        ...(network.dns?.io ? { dns: { ...network.dns, io: closingDNS(network.dns.io, () => closed) } } : {}),
        ...(typeof CheckedSocket === 'function' ? { socket: { ...network.socket, io: CheckedSocket } } : {}),
        host: 'api.openai.com',
        path: `/v1/live/${encodeURIComponent(callId)}`,
        port: 443,
        headers: new Map(Object.entries(headers)),
        onWritable(count) {
          writable = count
          if (!opened && count) {
            opened = true
            Timer.clear(deadline)
            resolve(channel)
          }
          try {
            flush()
          } catch {
            fail()
          }
        },
        onReadable(count, options) {
          try {
            const bytes = socket.read(count)
            // Control messages are UTF-8 JSON; keep complete frames bounded.
            incomingSize += bytes.byteLength
            if (incomingSize > 16384 || incoming.length >= 64 || options.binary)
              throw new Error('Invalid subscription control frame')
            incoming.push(new Uint8Array(bytes))
            if (options.more) return
            const frame = new Uint8Array(incomingSize)
            let offset = 0
            for (const chunk of incoming) {
              frame.set(chunk, offset)
              offset += chunk.length
            }
            const message = JSON.parse(decoder.decode(frame))
            incoming = []
            incomingSize = 0
            if (!message || typeof message.type !== 'string') throw new Error('Invalid subscription event')
            onMessage(message)
          } catch {
            fail()
          }
        },
        onControl(opcode) {
          if (opcode === Client.close) fail()
        },
        onClose() {
          if (!closed) fail()
        },
        onError: fail,
      })
    } catch {
      fail()
    }
  })
}

export function createSubscription(options) {
  if (!auth.status().signedIn)
    throw Object.assign(new Error('Subscription sign-in required'), { code: 'subscription_sign_in_required' })
  return new SubscriptionLive({
    auth,
    fetch,
    openControl: openSubscriptionControl,
    uuid: () => {
      const bytes = new Uint8Array(RNG.get(16))
      bytes[6] = (bytes[6] & 15) | 64
      bytes[8] = (bytes[8] & 63) | 128
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    },
    onLogout: options.onLogout,
  })
}

export default auth
