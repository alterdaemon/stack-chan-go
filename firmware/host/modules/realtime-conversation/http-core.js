// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0
// Standard ECMA-419 HTTP callbacks, bounded response and deterministic close.
export function requestHttps(request, platform, setCancel = () => {}, progress) {
  return new Promise((resolve, reject) => {
    let client,
      timer,
      buffer,
      offset = 0,
      received = 0,
      status,
      location,
      responseHeaders,
      stream,
      phase = 'connect',
      finished = false
    let body = request.body
    function transportFailure(message, cause) {
      const error = new Error(message)
      // SDK exceptions have no stable class hierarchy. Export only recognized
      // local reasons and numeric transport codes, never their raw message.
      if (
        ['bad response', 'bad state', 'invalid protocol', 'date validation failed', 'too large'].includes(
          cause?.message,
        )
      )
        error.reason = cause.message.replace(/ /g, '_')
      const code = typeof cause === 'number' ? cause : cause?.code
      if (Number.isInteger(code) && Math.abs(code) <= 2147483647) error.code = code
      return error
    }
    function finish(error) {
      if (finished) return
      finished = true
      if (timer !== undefined) platform.cancel(timer)
      const connection = client
      client = undefined
      body = undefined
      const failure = (cause) =>
        Object.assign(cause, { phase, status, received, written: offset, expected: request.body.byteLength })
      // Leave the SDK callback before closing its current TLS/socket state.
      platform.schedule(() => {
        try {
          connection?.close()
        } catch {}
        if (error) {
          buffer = undefined
          reject(failure(error))
        } else {
          try {
            resolve({
              status,
              location,
              headers: responseHeaders,
              body: stream ? stream.finish() : buffer ? buffer.buffer.slice(0, received) : new ArrayBuffer(),
            })
          } catch (error) {
            phase = 'finish'
            reject(failure(error))
          }
        }
      }, 0)
    }
    try {
      setCancel(() => finish(new Error('HTTPS request cancelled')))
      if (finished) return
      const headers = new Map(request.headers)
      headers.set('content-length', String(body.byteLength))
      headers.set('connection', 'close')
      timer = platform.schedule(() => finish(new Error('HTTPS request timed out')), request.timeoutMs)
      client = platform.createClient({
        host: request.host,
        port: request.port,
        certificate: request.certificate,
        drainTLS: request.responseFormat === 'subscription-response',
        onError(error) {
          finish(transportFailure('HTTPS connection failed', error))
        },
      })
      client.request({
        method: 'POST',
        path: request.path,
        headers,
        onHeaders(code, incomingHeaders) {
          if (finished) return
          phase = 'headers'
          status = code
          const value = incomingHeaders.get('location')
          if (typeof value === 'string' && value.length <= 4096) location = value
          responseHeaders = {}
          for (const name of ['location', 'openai-session-id', 'content-type']) {
            const header = incomingHeaders.get(name)
            if (typeof header === 'string' && header.length <= 4096) responseHeaders[name] = header
          }
          progress?.({ phase, status, received })
          if (request.responseFormat === 'subscription-response' && code >= 200 && code < 300) {
            // Codex consumes the SSE body without requiring a Content-Type
            // header. Completion and answer validation remain authoritative.
            stream = platform.createSubscriptionStream()
          }
          if (Number(incomingHeaders.get('content-length')) > (stream ? 2097152 : 131072))
            finish(new Error('HTTPS response exceeds limit'))
        },
        onWritable(count) {
          if (finished || !count) return
          phase = 'write'
          try {
            count = Math.min(count, body.byteLength - offset)
            if (count) {
              const first = offset === 0
              this.write(new DataView(body, offset, count))
              offset += count
              if (first) progress?.({ phase, received, written: offset, expected: body.byteLength })
              if (offset === body.byteLength) {
                phase = 'sent'
                progress?.({ phase, received, written: offset, expected: body.byteLength })
              }
            }
          } catch {
            finish(new Error('HTTPS write failed'))
          }
        },
        onReadable(count) {
          if (finished || !count) return
          phase = 'read'
          try {
            const end = received + count
            if (stream) {
              if (end > 2097152) throw new Error('HTTPS response exceeds limit')
              const chunk = new Uint8Array(Math.min(count, 1024))
              while (count) {
                const view = chunk.subarray(0, Math.min(count, chunk.length))
                if (this.read(view) !== view.length) throw new Error('HTTPS short read')
                const first = received === 0
                received += view.length
                if (first) progress?.({ phase, status, received })
                stream.write(view)
                if (stream.complete) return finish()
                count -= view.length
              }
              return
            }
            if (end > 131072) throw new Error('HTTPS response exceeds limit')
            if (!buffer || end > buffer.length) {
              const next = new Uint8Array(Math.min(131072, Math.max(end, (buffer?.length ?? 512) * 2)))
              if (buffer) next.set(buffer.subarray(0, received))
              buffer = next
            }
            const read = this.read(buffer.subarray(received, end))
            if (read !== count) throw new Error('HTTPS short read')
            const first = received === 0
            received = end
            if (first) progress?.({ phase, status, received })
          } catch (error) {
            finish(error)
          }
        },
        onDone(error) {
          finish(error || !Number.isInteger(status) ? transportFailure('HTTPS request failed', error) : undefined)
        },
      })
    } catch (error) {
      finish(error)
    }
  })
}

// HTTPClient.close() does not cancel an outstanding SDK DNS lookup. Ignore its
// late callbacks so closing a timed-out request cannot create a new socket.
export function createClosingClient(Client, options) {
  let closed = false
  const client = new Client({ ...options, dns: { ...options.dns, io: closingDNS(options.dns.io, () => closed) } })
  return {
    request: (request) => client.request(request),
    close() {
      closed = true
      client.close()
    },
  }
}

export function closingDNS(DNS, isClosed) {
  return class extends DNS {
    resolve(request) {
      const guarded = { ...request }
      for (const name of ['onResolved', 'onError'])
        guarded[name] = function (...args) {
          if (!isClosed()) request[name]?.apply(this, args)
        }
      return super.resolve(guarded)
    }
  }
}

// TLS authentication failures must reach HTTP onError, not escape an I/O callback.
export function guardSocketCallbacks(Socket) {
  return class extends Socket {
    constructor(options) {
      const guarded = { ...options }
      for (const name of ['onReadable', 'onWritable'])
        guarded[name] = function (...args) {
          try {
            return options[name]?.apply(this, args)
          } catch (error) {
            options.onError?.call(this, error)
          }
        }
      super(guarded)
    }
  }
}

// Resume buffered TLS records only after progress; no polling or protocol change.
export function drainTLSSocket(Socket, schedule, cancel, onDrain = () => {}) {
  return class extends Socket {
    #state
    constructor(options) {
      const state = { pending: 0, closed: false, timer: undefined }
      function arm() {
        const tcp = state.tcp
        if (state.closed || state.pending || !tcp?.readable || state.timer !== undefined) return
        state.timer = schedule(() => {
          state.timer = undefined
          if (state.closed || state.pending || !tcp.readable) return
          try {
            onDrain()
            state.readable.call(tcp, tcp.readable)
          } catch (error) {
            state.onError?.call(tcp, error)
          }
        }, 0)
      }
      state.arm = arm
      const TCP = options.TCP.io
      class DrainingTCP extends TCP {
        constructor(tcpOptions) {
          function readable(count) {
            if (state.closed) return
            const result = tcpOptions.onReadable?.call(this, count)
            if (this.readable > 0 && this.readable < count) arm()
            return result
          }
          super({ ...tcpOptions, onReadable: readable })
          state.tcp = this
          state.readable = readable
          state.onError = tcpOptions.onError
        }
      }
      super({
        ...options,
        TCP: { ...options.TCP, io: DrainingTCP },
        onReadable(count) {
          state.pending = count
          return options.onReadable?.call(this, count)
        },
      })
      this.#state = state
    }
    read(count) {
      const result = count === undefined ? super.read() : super.read(count)
      if (result !== undefined) {
        this.#state.pending = Math.max(
          0,
          this.#state.pending -
            (this.format === 'number' ? 1 : typeof result === 'number' ? result : result.byteLength),
        )
        // The SDK's own deferred read may encounter an empty record too.
        // One pending guard covers that path without polling or changing order.
        this.#state.arm()
      }
      return result
    }
    close() {
      const state = this.#state
      if (state) {
        state.closed = true
        if (state.timer !== undefined) cancel(state.timer)
        state.timer = undefined
      }
      super.close()
    }
  }
}
