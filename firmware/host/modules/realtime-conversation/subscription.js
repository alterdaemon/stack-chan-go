import fetch from 'realtimeConversation/http'
import { closingDNS, drainTLSSocket, guardSocketCallbacks } from 'realtimeConversation/http-core'
import { SubscriptionAuth } from 'realtimeConversation/subscription-auth'
import { SubscriptionLive, subscriptionUpgradeError } from 'realtimeConversation/subscription-live'
import store from 'realtimeConversation/subscription-store'
import Base64 from 'base64'
import Debug from 'device-debug'
import Modules from 'modules'
import RNG from 'rng'
import TextDecoder from 'text/decoder'
import Timer from 'timer'

const decoder = new TextDecoder('utf-8', { fatal: true })
const auth = new SubscriptionAuth({
  store,
  fetch,
  diagnose: (event, fields) => Debug.event('auth', event, fields),
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
export function openSubscriptionControl(callId, headers, onMessage, timeoutMs = 15000) {
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
      upgradeStatus,
      rejection = {},
      phase = network.dns?.io ? 'dns' : 'connect',
      firstMessage = true
    const diagnose = (event, fields) => Debug.event('subscription', event, fields)
    const statistics = Debug.enabled ? { socketReceived: 0, socketWritten: 0 } : undefined
    const DNS = network.dns?.io
    const CheckedDNS =
      typeof DNS === 'function'
        ? class extends closingDNS(DNS, () => closed) {
            resolve(request) {
              diagnose('control.dns.start')
              return super.resolve({
                ...request,
                onResolved(...args) {
                  phase = 'connect'
                  diagnose('control.dns.ready')
                  return request.onResolved?.apply(this, args)
                },
                onError(...args) {
                  diagnose('control.dns.failed')
                  return request.onError?.apply(this, args)
                },
              })
            }
          }
        : DNS
    const TCP = network.socket?.TCP?.io
    const CheckedTCP =
      typeof TCP === 'function'
        ? class extends guardSocketCallbacks(TCP, statistics) {
            constructor(options) {
              let ready = false
              super({
                ...options,
                onWritable(count) {
                  if (!ready && !closed) {
                    ready = true
                    phase = 'tls'
                    diagnose('control.tcp.ready')
                  }
                  return options.onWritable?.call(this, count)
                },
              })
            }
          }
        : TCP
    const Socket = network.socket?.io
    const ControlSocket =
      typeof Socket === 'function' && typeof TCP === 'function'
        ? drainTLSSocket(
            Socket,
            (callback, delay) => Timer.set(callback, delay),
            (timer) => Timer.clear(timer),
            () => diagnose('control.tls.drain'),
          )
        : Socket
    const CheckedSocket =
      typeof Socket === 'function'
        ? class extends guardSocketCallbacks(ControlSocket) {
            #statusLine = ''
            #readable = 0
            constructor(options) {
              let ready = false
              super({
                ...options,
                diagnosticStatistics: statistics,
                onReadable(count) {
                  this.#readable = count
                  return options.onReadable?.call(this, count)
                },
                onWritable(count) {
                  if (!ready && !closed) {
                    ready = true
                    phase = 'upgrade'
                    diagnose('control.tls.ready')
                  }
                  return options.onWritable?.call(this, count)
                },
                onError(error) {
                  if (!closed)
                    diagnose('control.socket.failed', () => ({
                      phase,
                      code: Number.isFinite(error?.code) ? error.code : undefined,
                    }))
                  return options.onError?.call(this, error)
                },
              })
            }
            read(data) {
              const value = data === undefined ? super.read() : super.read(data)
              if (typeof value === 'number' && this.#readable) this.#readable--
              if (this.#statusLine !== undefined && typeof value === 'number') {
                this.#statusLine += String.fromCharCode(value)
                if (this.#statusLine.length === 13) {
                  const match = /^HTTP\/1\.[01] ([1-5][0-9]{2}) $/.exec(this.#statusLine)
                  if (match) {
                    upgradeStatus = Number(match[1])
                    diagnose('control.http', () => ({ status: upgradeStatus }))
                  }
                }
                if (value === 10) {
                  this.#statusLine = undefined
                  if (upgradeStatus >= 400 && this.#readable > 0) {
                    const bytes = new Uint8Array(Math.min(this.#readable, 4096))
                    let size = 0
                    while (size < bytes.length) {
                      const byte = super.read()
                      if (typeof byte !== 'number') break
                      bytes[size++] = byte
                    }
                    this.#readable -= size
                    try {
                      rejection = subscriptionUpgradeError(decoder.decode(bytes.subarray(0, size)))
                    } catch {}
                    diagnose('control.rejection', () => ({ status: upgradeStatus, ...rejection }))
                  }
                } else if (this.#statusLine?.length > 256) this.#statusLine = undefined
              }
              return value
            }
          }
        : Socket
    const queue = []
    const fail = (timedOut = false) => {
      if (closed) return
      diagnose('control.failed', () => ({
        phase,
        status: upgradeStatus,
        reason: timedOut === true ? 'timeout' : 'socket',
      }))
      channel.close()
      if (!opened)
        reject(
          Object.assign(new Error('Subscription control connection failed'), {
            code: timedOut === true ? 'subscription_control_timeout' : 'subscription_control_failed',
            ...(upgradeStatus === undefined ? {} : { status: upgradeStatus }),
            ...rejection,
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
      statistics: () => (!closed && Debug.enabled && statistics ? { ...statistics } : undefined),
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
        if (statistics) diagnose('control.stats', () => ({ ...statistics }))
        closed = true
        diagnose('control.closed', () => ({ accepted: opened, phase }))
        Timer.clear(deadline)
        queue.length = 0
        incoming = []
        incomingSize = 0
        try {
          socket?.close()
        } catch {}
      },
    }
    const deadline = Timer.set(() => fail(true), timeoutMs)
    try {
      diagnose('control.start')
      socket = new Client({
        ...network,
        ...(typeof CheckedDNS === 'function' ? { dns: { ...network.dns, io: CheckedDNS } } : {}),
        ...(typeof CheckedSocket === 'function'
          ? {
              socket: {
                ...network.socket,
                io: CheckedSocket,
                ...(typeof CheckedTCP === 'function' ? { TCP: { ...network.socket.TCP, io: CheckedTCP } } : {}),
              },
            }
          : {}),
        host: 'api.openai.com',
        path: `/v1/live/${encodeURIComponent(callId)}`,
        port: 443,
        headers: new Map(Object.entries(headers)),
        onWritable(count) {
          writable = count
          if (!opened && count) {
            opened = true
            phase = 'control'
            diagnose('control.ready')
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
            if (firstMessage) {
              firstMessage = false
              diagnose('control.first_message', () => ({
                value: frame.byteLength,
                type:
                  /^(?:(?:session|delegation|conversation|rate_limits)\.[a-z_.]+|(?:input|output)_[a-z_.]+|error)$/.test(
                    message.type,
                  ) && message.type.length <= 64
                    ? message.type
                    : 'other',
              }))
            }
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
  if (typeof options.control?.send !== 'function' || typeof options.control?.close !== 'function')
    throw Object.assign(new Error('Subscription native control unavailable'), {
      code: 'subscription_control_unavailable',
    })
  return new SubscriptionLive({
    control: options.control,
    debug: Debug,
    createProbes: (hooks) =>
      Modules.importNow('device-debug/subscription-probes', true).createSubscriptionProbes(hooks),
    auth,
    fetch,
    openControl: openSubscriptionControl,
    wait: (delay) => new Promise((resolve) => Timer.set(resolve, delay)),
    diagnose: (event, fields) => Debug.event('subscription', event, fields),
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
