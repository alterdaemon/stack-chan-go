import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('camera diagnostic reads saved preferences but blocks all writes without the retired profile', async () => {
  const manifestURL = new URL('../../app/manifest_openai_camera_probe.test.json', import.meta.url)
  const manifest = JSON.parse(readFileSync(manifestURL, 'utf8'))
  const preferenceURL = new URL(`${manifest.modules.preference}.js`, manifestURL)
  const saved = new Map([
    ['probe.language', 'English'],
    ['probe.label', 'Zażółć'],
  ])
  let blockedWrites = 0
  const bindings = {
    xs_preference_get: (domain, key) => saved.get(`${domain}.${key}`),
    xs_preference_keys: (domain) =>
      [...saved.keys()].filter((key) => key.startsWith(`${domain}.`)).map((key) => key.slice(domain.length + 1)),
    xs_camera_probe_block_preference() {
      blockedWrites++
      throw new Error('diagnostic_preference_write_blocked')
    },
    xs_camera_probe_blocked_preferences: () => blockedWrites,
  }
  const originalNative = globalThis.native
  globalThis.native = (name) => {
    assert.equal(typeof bindings[name], 'function', `Unexpected native dependency: ${name}`)
    return bindings[name]
  }
  try {
    const { default: preference } = await import(preferenceURL.href)
    assert.equal(preference.get('probe', 'label'), 'Zażółć')
    assert.deepEqual(preference.keys('probe'), ['language', 'label'])
    assert.throws(() => preference.set('probe', 'language', 'changed'), /diagnostic_preference_write_blocked/)
    assert.throws(() => preference.delete('probe', 'label'), /diagnostic_preference_write_blocked/)
    assert.equal(preference.blockedWrites, 2)
    assert.equal(preference.get('probe', 'language'), 'English')
    assert.equal(preference.get('probe', 'label'), 'Zażółć')
    assert.equal(Object.isFrozen(preference), true)

    // Native export names are the compiler-visible module binding contract.
    const nativeSource = readFileSync(new URL('./__tests__/camera/probe.c', import.meta.url), 'utf8')
    const exports = new Set([...nativeSource.matchAll(/\bvoid\s+(xs_\w+)\s*\(/g)].map((match) => match[1]))
    for (const name of Object.keys(bindings).filter((name) => name.startsWith('xs_camera_probe_'))) {
      assert.equal(exports.has(name), true, `Camera module does not export ${name}`)
    }
  } finally {
    if (originalNative === undefined) delete globalThis.native
    else globalThis.native = originalNative
  }
})
