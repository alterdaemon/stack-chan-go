import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('native credential vault seals and authenticates records, rejects missing protection and handles I/O faults', (t) => {
  const compiler = process.env.CC || 'cc'
  if (spawnSync(compiler, ['--version']).status !== 0) return t.skip('C compiler unavailable')
  const directory = mkdtempSync(join(tmpdir(), 'stackchan-auth-store-'))
  try {
    const probe = spawnSync(compiler, ['-x', 'c', '-', '-lcrypto', '-o', join(directory, 'crypto-probe')], {
      input: '#include <openssl/evp.h>\nint main(void) { return EVP_aes_256_gcm() == 0; }\n',
      encoding: 'utf8',
    })
    if (probe.status !== 0) return t.skip('OpenSSL development headers/library unavailable for the host C harness')
    for (const name of [
      'xsmc.h',
      'xsHost.h',
      'esp_efuse.h',
      'esp_hmac.h',
      'esp_mac.h',
      'esp_random.h',
      'nvs.h',
      'psa/crypto.h',
      'mbedtls/platform_util.h',
    ]) {
      const file = join(directory, name)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '')
    }
    const binary = join(directory, 'vault-test')
    const compiled = spawnSync(
      compiler,
      [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Wno-unused-parameter',
        '-fsanitize=address,undefined',
        '-fno-omit-frame-pointer',
        '-g',
        '-I',
        directory,
        fileURLToPath(new URL('./subscription-store-native.c', import.meta.url)),
        '-lcrypto',
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(compiled.status, 0, compiled.stderr)
    // LeakSanitizer cannot run in traced shells. The harness counts native allocations/handles/keys itself.
    const result = spawnSync(binary, [], { encoding: 'utf8', env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /tombstone PASS/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
