import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('native poll watchdog tolerates a concurrent heartbeat and tick wrap while detecting a stalled VM', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stackchan-poll-watchdog-'))
  try {
    mkdirSync(join(directory, 'freertos'))
    writeFileSync(
      join(directory, 'freertos/FreeRTOS.h'),
      '#pragma once\n#include <stdint.h>\ntypedef uint32_t TickType_t;\n',
    )
    writeFileSync(join(directory, 'freertos/task.h'), '#pragma once\nTickType_t xTaskGetTickCount(void);\n')
    const binary = join(directory, 'watchdog')
    execFileSync(
      'cc',
      [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-fsanitize=address,undefined',
        '-I',
        directory,
        '-I',
        fileURLToPath(new URL('../esp32/', import.meta.url)),
        '-x',
        'c',
        '-',
        '-o',
        binary,
      ],
      {
        input: `
#include <assert.h>
#include "poll-watchdog.h"
static atomic_uint heartbeat;
static TickType_t clockTick;
static bool preempt;
TickType_t xTaskGetTickCount(void) {
    TickType_t sampled = clockTick;
    // Model XS polling after the clock read, before native code resumes.
    if (preempt) atomic_store(&heartbeat, clockTick + 1);
    return sampled;
}
int main(void) {
    atomic_store(&heartbeat, 1000);
    clockTick = 1001;
    preempt = true;
    assert(!livePollTimedOut(&heartbeat, 10000));
    assert(atomic_load(&heartbeat) == 1002);
    preempt = false;
    clockTick = 11002;
    assert(!livePollTimedOut(&heartbeat, 10000));
    clockTick++;
    assert(livePollTimedOut(&heartbeat, 10000));
    atomic_store(&heartbeat, UINT32_MAX - 9999);
    clockTick = 0;
    assert(!livePollTimedOut(&heartbeat, 10000));
    clockTick = 1;
    assert(livePollTimedOut(&heartbeat, 10000));
    return 0;
}
`,
      },
    )
    execFileSync(binary, { timeout: 5000, env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
