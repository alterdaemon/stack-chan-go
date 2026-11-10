// Diagnostic-only: reads use the SDK backend; writes cannot reach NVS.
const Preference = Object.freeze({
  get: native('xs_preference_get'),
  keys: native('xs_preference_keys'),
  set: native('xs_r14_block_preference'),
  delete: native('xs_r14_block_preference'),
  get blockedWrites() {
    return native('xs_r14_blocked_preferences')()
  },
})
export default Preference
