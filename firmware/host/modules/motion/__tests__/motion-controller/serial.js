export let port
export default class Serial {
  constructor(options) {
    this.options = options
    this.packets = []
    this.failWrites = 0
    port = this
  }
  write(bytes) {
    if (this.failWrites > 0) {
      this.failWrites--
      throw new Error('serial busy')
    }
    this.packets.push(Array.from(bytes))
  }
  read() {
    return this.incoming.shift()
  }
  reply(payload = []) {
    const id = this.packets[this.packets.length - 1][2]
    const bytes = [255, 255, id, payload.length + 2, 0, ...payload]
    let sum = 0
    for (let i = 2; i < bytes.length; i++) sum += bytes[i]
    bytes.push(~sum & 255)
    this.incoming = bytes
    this.options.onReadable.call(this, bytes.length)
  }
}
