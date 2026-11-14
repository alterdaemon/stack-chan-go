// SPDX-License-Identifier: Apache-2.0
// Codex Responses over the existing WSS client, worker and bounded event reducer.
export function requestSubscriptionResponse(request, platform, setCancel = () => {}, progress) {
  return new Promise((resolve, reject) => {
    let socket,
      timer,
      closed = false,
      opened = false,
      offset = 0,
      received = 0,
      message = [],
      size = 0,
      phase = 'connect',
      upgradeStatus,
      closeCode
    const stream = platform.createSubscriptionStream(request.diagnostics)
    const value = JSON.parse(platform.decode(request.body))
    value.type = 'response.create'
    // ChatGPT Codex's ResponseCreateWsRequest retains stream:true.
    let body = platform.encode(JSON.stringify(value))
    const expected = body.byteLength
    function arm(ms) {
      platform.cancel(timer)
      timer = platform.schedule(() => finish(new Error('HTTPS request timed out')), ms)
    }
    function finish(error) {
      if (closed) return
      closed = true
      platform.cancel(timer)
      body = undefined
      message = []
      const failure =
        error &&
        Object.assign(error, {
          phase,
          status: opened ? 200 : upgradeStatus,
          received,
          written: offset,
          expected,
          ...(closeCode === undefined ? {} : { code: closeCode }),
          ...stream.observation,
        })
      platform.schedule(() => {
        try {
          socket?.close()
        } catch {}
        if (failure) reject(failure)
        else {
          try {
            resolve({ status: 200, received, body: stream.finish(), ...stream.observation })
          } catch (error) {
            reject(error)
          }
        }
      }, 0)
    }
    function activity() {
      arm(request.streamIdleTimeoutMs ?? 300000)
      progress?.({ streaming: true, phase, status: 200, received })
    }
    try {
      setCancel(() => finish(new Error('HTTPS request cancelled')))
      if (closed) return
      arm(Math.min(request.timeoutMs, 45000))
      const headers = new Map(request.headers)
      headers.delete('Content-Type')
      headers.delete('content-type')
      headers.delete('Accept')
      headers.delete('accept')
      headers.set('OpenAI-Beta', 'responses_websockets=2026-02-06')
      socket = platform.createWebSocket({
        host: request.host,
        port: request.port,
        path: request.path,
        headers,
        certificate: request.certificate,
        isClosed: () => closed,
        onStatus(status) {
          upgradeStatus = status
          phase = 'upgrade'
        },
        onWritable(count) {
          if (closed) return
          try {
            if (!opened) {
              opened = true
              phase = 'write'
              activity()
            }
            while (body && count > 0 && offset < body.byteLength) {
              const n = Math.min(count, body.byteLength - offset)
              count = this.write(new Uint8Array(body, offset, n), { binary: false, more: offset + n < body.byteLength })
              offset += n
            }
            if (body && offset === body.byteLength) {
              body = undefined
              phase = 'sent'
              progress?.({ phase, status: 200, received, written: offset, expected })
            }
          } catch {
            finish(new Error('HTTPS write failed'))
          }
        },
        onReadable(count, options) {
          if (closed) return
          phase = 'read'
          try {
            if (options.binary || received + count > 2097152 || size + count > 131072 || message.length >= 256)
              throw new Error('HTTPS response exceeds limit')
            const bytes = this.read(count)
            if (bytes.byteLength !== count) throw new Error('HTTPS short read')
            received += count
            size += count
            message.push(new Uint8Array(bytes))
            activity()
            if (options.more) return
            const complete = new Uint8Array(size)
            let at = 0
            for (const chunk of message) {
              complete.set(chunk, at)
              at += chunk.length
            }
            message = []
            size = 0
            stream.event(JSON.parse(platform.decode(complete)))
            progress?.({ phase, status: 200, received, ...stream.observation })
            if (stream.complete) finish()
          } catch (error) {
            finish(error)
          }
        },
        onClose() {
          finish(new Error('Subscription stream ended before completion'))
        },
        onControl(opcode, bytes) {
          if (opcode === 8 && bytes.byteLength >= 2) {
            const value = new DataView(bytes).getUint16(0)
            if (value >= 1000 && value <= 4999) closeCode = value
          }
        },
        onError() {
          finish(new Error('HTTPS connection failed'))
        },
      })
    } catch (error) {
      finish(error)
    }
  })
}
