import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('session microphone gain restores both codec registers after success and partial failures', () => {
  const temp = mkdtempSync(join(tmpdir(), 'stackchan-live-codec-'))
  const path = (name) => fileURLToPath(new URL(name, import.meta.url))
  try {
    const binary = join(temp, 'restore')
    execFileSync('cc', [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-fsanitize=address,undefined',
      '-I',
      path('./live-codec/'),
      path('./live-codec/restore.c'),
      path('../esp32/liveCodec.c'),
      '-lm',
      '-o',
      binary,
    ])
    execFileSync(binary, { env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } })
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
