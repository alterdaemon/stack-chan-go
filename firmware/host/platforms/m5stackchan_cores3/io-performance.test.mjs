import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('native UI windows expire without JS, coalesce delays and leave Off unchanged', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stackchan-ui-budget-'))
  try {
    const platform = `
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <assert.h>
typedef struct {} xsMachine;
int testArgument(void);
#define xsArg(index) testArgument()
#define xsmcToInteger(value) (value)
#define xsmcToBoolean(value) ((value) != 0)
#define xsRangeError(message) assert(!message)
#define xsUnknownError(message) assert(!message)
typedef void *TaskHandle_t;
typedef unsigned UBaseType_t;
TaskHandle_t xTaskGetCurrentTaskHandle(void);
TaskHandle_t xTaskGetHandle(const char *);
UBaseType_t uxTaskPriorityGet(TaskHandle_t);
const char *pcTaskGetName(TaskHandle_t);
void vTaskPrioritySet(TaskHandle_t, UBaseType_t);
#define pdMS_TO_TICKS(value) (value)
#define ESP_OK 0
typedef struct Timer *esp_timer_handle_t;
typedef struct { void (*callback)(void *); const char *name; } esp_timer_create_args_t;
int64_t esp_timer_get_time(void);
int esp_timer_create(const esp_timer_create_args_t *, esp_timer_handle_t *);
int esp_timer_start_once(esp_timer_handle_t, uint64_t);
int esp_timer_stop(esp_timer_handle_t);
int esp_timer_stop_blocking(esp_timer_handle_t, unsigned);
int esp_timer_delete(esp_timer_handle_t);
`
    writeFileSync(join(directory, 'platform.h'), platform)
    writeFileSync(join(directory, 'mc.defines.h'), '')
    for (const header of ['xsHost.h', 'xsmc.h', 'esp_timer.h', 'freertos/FreeRTOS.h', 'freertos/task.h']) {
      const target = join(directory, header)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, '#include "platform.h"\n')
    }
    const binary = join(directory, 'ui-budget')
    execFileSync('cc', [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-Wno-unused-parameter',
      '-fsanitize=address,undefined',
      '-I',
      directory,
      fileURLToPath(new URL('./__tests__/ui-budget.c', import.meta.url)),
      '-o',
      binary,
    ])
    execFileSync(binary, { timeout: 5000, env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
