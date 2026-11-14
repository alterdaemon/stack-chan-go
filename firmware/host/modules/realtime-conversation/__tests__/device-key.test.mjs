import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('production device key bindings preserve existing keys and bound all setup mutations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stackchan-device-key-'))
  try {
    for (const name of [
      'xsmc.h',
      'xsHost.h',
      'esp_efuse.h',
      'esp_efuse_table.h',
      'esp_hmac.h',
      'esp_random.h',
      'esp_wifi.h',
      'psa/crypto.h',
      'mbedtls/platform_util.h',
    ]) {
      const file = join(directory, name)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '')
    }
    const binary = join(directory, 'test')
    const compile = spawnSync(
      process.env.CC || 'cc',
      [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Wno-unused-parameter',
        '-Wno-misleading-indentation',
        '-fsanitize=address,undefined',
        '-fno-omit-frame-pointer',
        '-g',
        '-I',
        directory,
        fileURLToPath(new URL('./device-key-native.c', import.meta.url)),
        '-lcrypto',
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(compile.status, 0, compile.stderr)
    const run = spawnSync(binary, [], { encoding: 'utf8', env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /device key native PASS/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
