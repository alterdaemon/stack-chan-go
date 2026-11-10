import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('native pitch streaming preserves samples, drains pauses, isolates sessions and bounds DSP failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stackchan-live-pitch-'))
  const path = (relative) => fileURLToPath(new URL(relative, import.meta.url))
  try {
    const binary = join(directory, 'stream-test')
    execFileSync('cc', [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-fsanitize=address,undefined',
      '-I',
      path('./live-pitch/'),
      '-I',
      path('../esp32/'),
      path('./live-pitch/stream.c'),
      path('../esp32/livePitch.c'),
      '-lm',
      '-o',
      binary,
    ])
    // LeakSanitizer cannot inspect threads under ptrace. The C fixture also
    // checks balanced DSP ownership, while ASan/UBSan check memory accesses.
    execFileSync(binary, { env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
