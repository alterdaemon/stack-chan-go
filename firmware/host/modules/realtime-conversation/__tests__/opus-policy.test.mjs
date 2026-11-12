import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('chat decoder rate ends with its lease and leaves non-chat requests unchanged', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stackchan-opus-policy-'))
  const path = (name) => fileURLToPath(new URL(name, import.meta.url))
  try {
    for (const header of ['esp_audio_enc_reg.h', 'esp_audio_dec_reg.h', 'esp_opus_enc.h', 'esp_opus_dec.h'])
      writeFileSync(join(directory, header), '#include "platform.h"\n')
    const binary = join(directory, 'lease')
    execFileSync('cc', [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-fsanitize=address,undefined',
      '-I',
      directory,
      '-I',
      path('./opus-policy/'),
      path('./opus-policy/lease.c'),
      path('../../../platforms/m5stackchan_cores3/opus-policy.c'),
      '-o',
      binary,
    ])
    execFileSync(binary, { timeout: 10000, env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
