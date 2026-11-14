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

test('panic diagnostics export only image-bound code addresses and always forward to the SDK handler', () => {
  const work = mkdtempSync(join(tmpdir(), 'stackchan-debug-panic-'))
  try {
    const headers = {
      'esp_attr.h': '#define RTC_NOINIT_ATTR\n#define IRAM_ATTR\n',
      'esp_system.h':
        '#include <stdint.h>\n#include <stdbool.h>\n#define ESP_RST_PANIC 4\nstatic int testReset;\nstatic int esp_reset_reason(void) { return testReset; }\n',
      'esp_private/panic_internal.h':
        'typedef struct { int core, exception; void *addr; const void *frame; } panic_info_t;\n',
      'xtensa_context.h': 'typedef struct { uint32_t pc, a1, a0; } XtExcFrame;\n',
      'esp_cpu_utils.h': 'static uint32_t esp_cpu_process_stack_pc(uint32_t pc) { return pc; }\n',
      'esp_debug_helpers.h': `typedef struct { uint32_t pc, sp, next_pc; const void *exc_frame; } esp_backtrace_frame_t;
        static bool esp_stack_ptr_is_sane(uint32_t sp) { return sp == 16; }
        static bool esp_backtrace_get_next_frame(esp_backtrace_frame_t *frame) {
            frame->pc = frame->next_pc;
            frame->next_pc = 0;
            return true;
        }\n`,
      'soc/soc.h':
        '#define SOC_IROM_LOW 0x42000000u\n#define SOC_IROM_HIGH 0x44000000u\n#define SOC_IRAM_LOW 0x40370000u\n#define SOC_IRAM_HIGH 0x403e0000u\n',
    }
    for (const [name, contents] of Object.entries(headers)) {
      mkdirSync(dirname(join(work, name)), { recursive: true })
      writeFileSync(join(work, name), contents)
    }
    const binary = join(work, 'panic')
    execFileSync('cc', [
      '-std=c11',
      '-fsanitize=address,undefined',
      '-I',
      work,
      fileURLToPath(new URL('./__tests__/native/panic.c', import.meta.url)),
      '-o',
      binary,
    ])
    execFileSync(binary, { timeout: 10000, env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
