import HTTPClient from 'sdk-http'
import Timer from 'timer'

const check = (value, message) => {
  if (!value) throw new Error(message)
}
const pause = () => new Promise((resolve) => Timer.set(resolve, 1))
async function replay(split, chunked) {
  let socket,
    status,
    done = false,
    output = '',
    error
  class DNS {
    resolve(request) {
      Timer.set(() => request.onResolved('fixture', '192.0.2.1'), 0)
    }
  }
  class Socket {
    constructor(options) {
      this.options = options
      this.format = 'buffer'
      socket = this
    }
    write() {
      return 65536
    }
    close() {
      this.closed = true
    }
    read(target) {
      check(this.offset < this.bytes.length, 'read beyond delivered bytes')
      if (this.format === 'number') return this.bytes[this.offset++]
      const count = Math.min(
        typeof target === 'object' ? target.byteLength : (target ?? Infinity),
        this.bytes.length - this.offset,
      )
      const bytes = this.bytes.subarray(this.offset, this.offset + count)
      this.offset += count
      if (typeof target === 'object') {
        target.set(bytes)
        return count
      }
      return bytes.slice().buffer
    }
    feed(bytes) {
      check(!this.bytes || this.offset === this.bytes.length, 'previous TLS record was not drained')
      this.bytes = bytes
      this.offset = 0
      this.options.onReadable(bytes.length)
    }
  }
  const client = new HTTPClient({
    host: 'fixture',
    dns: { io: DNS },
    socket: { io: Socket },
    onError(e) {
      error = e
    },
  })
  client.request({
    method: 'POST',
    path: '/responses',
    headers: new Map([['content-length', '0']]),
    onHeaders(code) {
      status = code
    },
    onReadable(count) {
      for (const byte of new Uint8Array(this.read(count))) output += String.fromCharCode(byte)
    },
    onDone(e) {
      done = true
      error = e
    },
  })
  try {
    for (let i = 0; !socket && i < 20; i++) await pause()
    check(socket, 'HTTP client did not connect')
    socket.options.onWritable(65536)
    const header =
      'HTTP/1.1 200 OK\r\nX-Fixture: ' +
      'x'.repeat(1400) +
      '\r\n' +
      (chunked ? 'Transfer-Encoding: chunked\r\n' : 'Content-Length: 2\r\n') +
      '\r\n'
    const body = chunked ? '2\r\nOK\r\n0\r\n\r\n' : 'OK'
    const bytes = new Uint8Array(ArrayBuffer.fromString(header + body))
    socket.feed(bytes.slice(0, split))
    await pause()
    socket.feed(bytes.slice(split))
    for (let i = 0; !done && !error && i < 20; i++) await pause()
    check(!error, 'SDK HTTP parser failed')
    check(status === 200, `headers incomplete at split ${split}`)
    check(done && output === 'OK', `response incomplete at split ${split}`)
  } finally {
    client.close()
  }
}
for (const chunked of [false, true])
  for (const split of [1, 7, 8, 9, 12, 13, 512, 1024, 1368, 1369, 1370, 1430]) await replay(split, chunked)
trace('@@STACKCHAN_TEST:PASS@@\n')
