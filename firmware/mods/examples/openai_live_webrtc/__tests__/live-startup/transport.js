export const transports = []

export default class Transport {
  constructor(callback) {
    this.callback = callback
    this.sent = []
    transports.push(this)
  }
  setVolume() {}
  start(options) {
    this.options = options
    this.callback({ type: 'offer', sdp: 'v=0\r\noffer' })
  }
  acceptAnswer() {
    this.message({ type: 'session.started', session: { id: 'live_test' } })
  }
  message(message) {
    this.callback({ type: 'message', data: JSON.stringify(message) })
  }
  send(text) {
    this.sent.push(JSON.parse(text))
    if (JSON.parse(text).type === 'session.close') this.message({ type: 'session.closed', reason: 'client_request' })
  }
  async close() {}
}
