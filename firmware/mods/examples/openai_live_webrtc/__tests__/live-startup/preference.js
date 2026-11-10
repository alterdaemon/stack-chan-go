export default {
  get(domain, key) {
    if (domain === 'ai' && key === 'token') return 'test-key'
  },
}
