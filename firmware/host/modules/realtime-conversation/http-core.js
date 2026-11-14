// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0
// Standard ECMA-419 HTTP callbacks, bounded response and deterministic close.
export function requestHttps(request, platform, setCancel = () => {}, progress) {
  return new Promise((resolve, reject) => {
    let client,
      timer,
      completionErrorTimer,
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
    const statistics = request.diagnostics ? { socketReceived: 0, socketWritten: 0 } : undefined
    function transportFailure(message, cause) {
      const error = new Error(message)
      const tlsReasons = {
        'recordProtocol: bad data': 'tls_record_data',
        'recordProtocol: auth failed': 'tls_record_auth',
        'recordProtocol auth failed': 'tls_record_auth',
        'finished: auth err': 'tls_finished_auth',
        'certificate: auth err': 'tls_certificate_auth',
        'serverKeyExchange: failed to verify signature': 'tls_signature',
        'handshake: unsuppoorted cipher': 'tls_cipher',
        'handshake: unsupported compression': 'tls_compression',
      }
      // SDK exceptions have no stable class hierarchy. Export only recognized
      // local reasons and numeric transport codes, never their raw message.
      if (
        ['bad response', 'bad state', 'invalid protocol', 'date validation failed', 'too large'].includes(
          cause?.message,
        )
      )
        error.reason = cause.message.replace(/ /g, '_')
      else if (Object.hasOwn(tlsReasons, cause?.message)) error.reason = tlsReasons[cause.message]
      const alert = /^alert: ([0-9]{1,3}), ([0-9]{1,3})$/.exec(cause?.message ?? '')
      if (alert && +alert[1] <= 255 && +alert[2] <= 255) {
        error.reason = 'tls_alert'
        error.code = (+alert[1] << 8) | +alert[2]
      }
      const code = typeof cause === 'number' ? cause : cause?.code
      if (Number.isInteger(code) && Math.abs(code) <= 2147483647) error.code = code
      return error
    }
    function finish(error) {
      if (finished) return
      finished = true
      if (timer !== undefined) platform.cancel(timer)
      if (completionErrorTimer !== undefined) platform.cancel(completionErrorTimer)
      const connection = client
      const observation = statistics ? { ...statistics, ...stream?.observation } : undefined
      client = undefined
      body = undefined
      const failure = (cause) =>
        Object.assign(cause, {
          phase,
          status,
          received,
          written: offset,
          expected: request.body.byteLength,
          ...observation,
        })
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
              received,
              ...observation,
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
      timer = platform.schedule(() => finish(new Error('HTTPS request timed out')), Math.min(request.timeoutMs, 45000))
      client = platform.createClient({
        host: request.host,
        port: request.port,
        certificate: request.certificate,
        drainTLS: request.responseFormat === 'subscription-response',
        statistics,
        onObservation: statistics ? () => progress?.({ phase, status, received, ...statistics }) : undefined,
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
            stream = platform.createSubscriptionStream(request.diagnostics)
            // Codex permits five minutes of stream inactivity. The caller
            // still bounds this entire job; connection/header wait stays 45s.
            if (request.timeoutMs > 45000) {
              platform.cancel(timer)
              timer = platform.schedule(() => finish(new Error('HTTPS request timed out')), request.timeoutMs)
            }
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
          if (finished) return
          // The SDK reports onDone(new Error) before client.onError(cause).
          // Leave this callback before accepting the generic fallback so the
          // actual TLS/socket cause wins, without exposing exception text.
          if (error) {
            completionErrorTimer ??= platform.schedule(() => {
              completionErrorTimer = undefined
              finish(transportFailure('HTTPS request failed', error))
            }, 0)
          } else finish(!Number.isInteger(status) ? transportFailure('HTTPS request failed') : undefined)
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
export function guardSocketCallbacks(Socket, statistics) {
  const Guarded = class extends Socket {
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
  if (!statistics) return Guarded
  let socket
  const observe = tlsRecordObservation(statistics)
  Object.defineProperty(statistics, 'socketBuffered', { enumerable: true, get: () => socket?.readable ?? 0 })
  Object.defineProperty(statistics, 'socketPending', {
    enumerable: true,
    get() {
      // Matching SDK lwIP xs_tcp_read returns undefined for an empty queue,
      // or rejects zero before copying/consuming when bytes are queued. Bypass
      // the observer so this diagnostic does not affect byte counts or TLS.
      try {
        if (socket?.format !== 'buffer') return -1
        return Socket.prototype.read.call(socket, 0) === undefined ? 0 : -1
      } catch (error) {
        return error?.message === 'invalid' ? 1 : -1
      }
    },
  })
  return class extends Guarded {
    constructor(options) {
      super(options)
      socket = this
    }
    read(value) {
      const result = value === undefined ? super.read() : super.read(value)
      if (result !== undefined)
        statistics.socketReceived +=
          typeof result === 'number' ? (this.format === 'number' ? 1 : result) : result.byteLength
      if (result !== undefined) {
        if (this.format === 'number') observe(Uint8Array.of(result))
        else if (typeof result !== 'number') observe(new Uint8Array(result))
        else if (ArrayBuffer.isView(value)) observe(new Uint8Array(value.buffer, value.byteOffset, result))
        else observe(new Uint8Array(value, 0, result))
      }
      return result
    }
    write(value, options) {
      const result = super.write(value, options)
      statistics.socketWritten += value.byteLength
      return result
    }
  }
}

// TLS framing metadata only. Skip ciphertext in blocks; retain no byte values.
export function tlsRecordObservation(statistics) {
  let at = 0,
    length = 0,
    disabled = false
  return (bytes) => {
    for (let offset = 0; offset < bytes.length && !disabled; ) {
      if (at < 5) {
        const byte = bytes[offset++]
        if (!at) {
          statistics.tlsRecordType = byte >= 20 && byte <= 24 ? byte : 0
          statistics.tlsRecordExpected = 0
          length = 0
        }
        if (at === 3) length = byte << 8
        else if (at === 4) {
          length |= byte
          if (!statistics.tlsRecordType || length > 32768) disabled = true
          else statistics.tlsRecordExpected = length + 5
        }
        at++
      } else {
        const count = Math.min(bytes.length - offset, length + 5 - at)
        offset += count
        at += count
      }
      statistics.tlsRecordRead = at
      if (at === length + 5) {
        statistics.tlsRecords = (statistics.tlsRecords ?? 0) + 1
        at = 0
      }
    }
  }
}

// Observe only validated status and byte boundaries, never header/body values.
export function httpResponseObservation(statistics) {
  let count = 0,
    valid = true,
    status = 0,
    delimiter = 0,
    lineFeed = false
  const prefix = 'HTTP/1.'
  return (byte) => {
    if (statistics.httpHeaderLfBytes || count >= 8192) return
    if (count < 7) valid &&= byte === prefix.charCodeAt(count)
    else if (count === 7) valid &&= byte === 48 || byte === 49
    else if (count === 8 || count === 12) valid &&= byte === 32
    else if (count < 12) {
      valid &&= byte >= 48 && byte <= 57
      status = status * 10 + byte - 48
    }
    count++
    statistics.httpHeaderScan = count
    if (byte === 13) statistics.httpCrCount = (statistics.httpCrCount ?? 0) + 1
    if (byte === 10) {
      statistics.httpLfCount = (statistics.httpLfCount ?? 0) + 1
      if (lineFeed) statistics.httpHeaderLfBytes = count
      lineFeed = true
    } else if (byte !== 13) lineFeed = false
    if (count === 13) {
      statistics.httpPrefix = valid ? 'http1' : 'other'
      if (valid && status >= 100 && status <= 599) statistics.httpStatus = status
    }
    const expected = delimiter % 2 ? 10 : 13
    delimiter = byte === expected ? delimiter + 1 : byte === 13 ? 1 : 0
    if (delimiter === 4) statistics.httpHeaderBytes = count
  }
}

// Resume buffered TLS records only after progress; no polling or protocol change.
export function drainTLSSocket(Socket, schedule, cancel, onDrain = () => {}) {
  return class extends Socket {
    #state
    constructor(options) {
      const state = { pending: 0, closed: false, timer: undefined, statistics: options.diagnosticStatistics }
      state.observe = state.statistics ? httpResponseObservation(state.statistics) : undefined
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
          if (state.statistics) {
            state.statistics.tlsReceived = (state.statistics.tlsReceived ?? 0) + count
            state.statistics.tlsBuffered = count
          }
          const result = options.onReadable?.call(this, count)
          // Keep the first decoded HTTP boundary even if a later native
          // failure prevents the worker's final idle observation. One event,
          // no sampling timer, and no header/body values cross the boundary.
          if (!state.observed && state.statistics?.tlsRead > 0) {
            state.observed = true
            options.diagnosticObservation?.()
          }
          return result
        },
      })
      this.#state = state
    }
    read(count) {
      const result = count === undefined ? super.read() : super.read(count)
      if (result !== undefined) {
        if (this.#state.observe) {
          if (this.format === 'number') this.#state.observe(result)
          else {
            const bytes =
              typeof result === 'number'
                ? ArrayBuffer.isView(count)
                  ? new Uint8Array(count.buffer, count.byteOffset, result)
                  : new Uint8Array(count, 0, result)
                : new Uint8Array(result)
            for (const byte of bytes) this.#state.observe(byte)
          }
          if (this.#state.statistics.httpHeaderLfBytes || this.#state.statistics.httpHeaderScan >= 8192)
            this.#state.observe = undefined
        }
        const consumed = this.format === 'number' ? 1 : typeof result === 'number' ? result : result.byteLength
        this.#state.pending = Math.max(0, this.#state.pending - consumed)
        if (this.#state.statistics) {
          this.#state.statistics.tlsRead = (this.#state.statistics.tlsRead ?? 0) + consumed
          this.#state.statistics.tlsBuffered = this.#state.pending
        }
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
