export const requests = []
export default async function fetch(url, init) {
  requests.push({ url, init })
  return {
    status: 201,
    async text() {
      return JSON.stringify({ session: { id: 'live_test' }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer' } })
    },
  }
}
