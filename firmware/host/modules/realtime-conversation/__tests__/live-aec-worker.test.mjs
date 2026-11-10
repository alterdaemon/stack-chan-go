import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('AEC runs in a UI-preemptible worker while the audio clock queues without blocking', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stackchan-live-aec-'))
  const path = (relative) => fileURLToPath(new URL(relative, import.meta.url))
  try {
    const binary = join(directory, 'worker-test')
    execFileSync('cc', [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-fsanitize=address,undefined',
      '-pthread',
      '-I',
      path('./live-aec-worker/'),
      '-I',
      path('../esp32/'),
      path('./live-aec-worker/worker.c'),
      path('../esp32/liveAecWorker.c'),
      '-o',
      binary,
    ])
    execFileSync(binary, { timeout: 10000, env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
