// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0
// Standard ECMA-419 HTTP callbacks, bounded response and deterministic close.
export function requestHttps(request, platform, setCancel = () => {}) {
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
      finished = false
    let body = request.body
    function finish(error) {
      if (finished) return
      finished = true
      if (timer !== undefined) platform.cancel(timer)
      const connection = client
      client = undefined
      body = undefined
      // Leave the SDK callback before closing its current TLS/socket state.
      platform.schedule(() => {
        try {
          connection?.close()
        } catch {}
        if (error) {
          buffer = undefined
          reject(error)
        } else {
          try {
            resolve({
              status,
              location,
              headers: responseHeaders,
              body: stream ? stream.finish() : buffer ? buffer.buffer.slice(0, received) : new ArrayBuffer(),
            })
          } catch {
            reject(new Error('Invalid subscription response stream'))
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
        onError() {
          finish(new Error('HTTPS connection failed'))
        },
      })
      client.request({
        method: 'POST',
        path: request.path,
        headers,
        onHeaders(code, incomingHeaders) {
          if (finished) return
          status = code
          const value = incomingHeaders.get('location')
          if (typeof value === 'string' && value.length <= 4096) location = value
          responseHeaders = {}
          for (const name of ['location', 'openai-session-id', 'content-type']) {
            const header = incomingHeaders.get(name)
            if (typeof header === 'string' && header.length <= 4096) responseHeaders[name] = header
          }
          if (request.responseFormat === 'subscription-response' && code >= 200 && code < 300) {
            if (!/^text\/event-stream(?:;|$)/i.test(responseHeaders['content-type'] ?? ''))
              return finish(new Error('Expected subscription event stream'))
            stream = platform.createSubscriptionStream()
          }
          if (Number(incomingHeaders.get('content-length')) > (stream ? 2097152 : 131072))
            finish(new Error('HTTPS response exceeds limit'))
        },
        onWritable(count) {
          if (finished || !count) return
          try {
            count = Math.min(count, body.byteLength - offset)
            if (count) {
              this.write(new DataView(body, offset, count))
              offset += count
            }
          } catch {
            finish(new Error('HTTPS write failed'))
          }
        },
        onReadable(count) {
          if (finished || !count) return
          try {
            const end = received + count
            if (stream) {
              if (end > 2097152) throw new Error()
              const chunk = new Uint8Array(Math.min(count, 1024))
              while (count) {
                const view = chunk.subarray(0, Math.min(count, chunk.length))
                if (this.read(view) !== view.length) throw new Error()
                stream.write(view)
                count -= view.length
              }
              received = end
              return
            }
            if (end > 131072) throw new Error()
            if (!buffer || end > buffer.length) {
              const next = new Uint8Array(Math.min(131072, Math.max(end, (buffer?.length ?? 512) * 2)))
              if (buffer) next.set(buffer.subarray(0, received))
              buffer = next
            }
            const read = this.read(buffer.subarray(received, end))
            if (read !== count) throw new Error()
            received = end
          } catch {
            finish(new Error('HTTPS response exceeds limit or read failed'))
          }
        },
        onDone(error) {
          finish(error || !Number.isInteger(status) ? new Error('HTTPS request failed') : undefined)
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
