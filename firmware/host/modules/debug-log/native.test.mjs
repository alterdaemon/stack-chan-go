import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('native recorder stays Off, bounds concurrent producers, counts loss and clears on disable', () => {
  const work = mkdtempSync(join(tmpdir(), 'stackchan-debug-native-'))
  const source = (name) => fileURLToPath(new URL(name, import.meta.url))
  try {
    for (const name of [
      'xsmc.h',
      'xsHost.h',
      'esp_timer.h',
      'esp_app_desc.h',
      'esp_system.h',
      'esp_heap_caps.h',
      'freertos/FreeRTOS.h',
    ]) {
      const path = join(work, name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '#include "platform.h"\n')
    }
    const binary = join(work, 'queue')
    execFileSync('cc', [
      '-std=c11',
      '-pthread',
      '-fsanitize=address,undefined',
      '-I',
      work,
      '-I',
      source('./__tests__/native/'),
      source('./__tests__/native/queue.c'),
      '-o',
      binary,
    ])
    execFileSync(binary, { timeout: 10000, env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
