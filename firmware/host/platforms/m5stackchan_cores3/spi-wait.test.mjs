import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('SPI waits preserve completion before registration, broadcast and delayed capacity/idle progress', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stackchan-spi-wait-'))
  const path = (relative) => fileURLToPath(new URL(relative, import.meta.url))
  try {
    for (const header of [
      'xsHost.h',
      'modSPI.h',
      'mc.defines.h',
      'esp_attr.h',
      'esp_heap_caps.h',
      'freertos/semphr.h',
      'freertos/event_groups.h',
    ]) {
      const target = join(directory, header)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, '#include "platform.h"\n')
    }
    const binary = join(directory, 'spi-test')
    execFileSync('cc', [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-Wno-unused-parameter',
      '-Wno-sign-compare',
      '-Wno-pointer-to-int-cast',
      '-Wno-misleading-indentation',
      '-fsanitize=address,undefined',
      '-pthread',
      '-ffunction-sections',
      '-fdata-sections',
      '-I',
      directory,
      '-I',
      path('./__tests__/spi/'),
      path('./__tests__/spi/wait.c'),
      '-Wl,--gc-sections',
      '-o',
      binary,
    ])
    execFileSync(binary, { timeout: 5000, env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
