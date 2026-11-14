const read = native('xs_device_key_status')
const provision = native('xs_device_key_setup')
const reasons = [
  'setup-required',
  'slot-occupied',
  'protection-locked',
  'coding-error',
  'hmac-error',
  'setup-failed',
  'entropy-unavailable',
]
function status(value) {
  if (Number.isInteger(value) && value >= 0 && value < 6) return { state: 'ready', slot: value }
  const reason = reasons[-value - 1] ?? 'unknown'
  return { state: reason === 'setup-required' ? 'setup-required' : 'blocked', slot: 5, reason }
}
export default {
  status() {
    return status(read())
  },
  setup() {
    return status(provision(5))
  },
}
