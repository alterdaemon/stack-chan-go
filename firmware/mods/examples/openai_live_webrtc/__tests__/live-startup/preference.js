const saved = new Map()

export default {
  get(domain, key) {
    if (saved.has(`${domain}.${key}`)) return saved.get(`${domain}.${key}`)
    if (domain === 'ai' && key === 'token') return 'test-key'
  },
  set(domain, key, value) {
    saved.set(`${domain}.${key}`, value)
  },
}
