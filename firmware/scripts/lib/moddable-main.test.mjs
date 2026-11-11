import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { prepareModdableMain } from './moddable-main.mjs'

test('generated CoreS3 entry point preserves task arguments, pins realtime XS and restores the SDK default', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stackchan-main-'))
  const moddableDirectory = path.join(directory, 'sdk')
  const sdkMain = path.join(moddableDirectory, 'build/devices/esp32/lib/main/main.c')
  const mainDirectory = path.join(directory, 'project/main')
  const source = `
#include <assert.h>
#include <stddef.h>
#include <string.h>
static unsigned stackSize = 8192;
static int selectedCore;
static void loop_task(void *argument) { assert(!argument); }
static void xTaskCreatePinnedToCore(void (*body)(void *), const char *name,
    unsigned size, void *argument, unsigned priority, void *handle, int core) {
    assert(body == loop_task && !strcmp(name, "main") && size == stackSize);
    assert(!argument && !handle && priority == 4);
    selectedCore = core;
    body(argument);
}
static void xTaskCreate(void (*body)(void *), const char *name,
    unsigned size, void *argument, unsigned priority, void *handle) {
    xTaskCreatePinnedToCore(body, name, size, argument, priority, handle, -1);
}
void app_main(void) {
    xTaskCreate(loop_task, "main", stackSize, NULL, 4, NULL);
}
int main(void) {
    app_main();
    assert(selectedCore == EXPECTED_CORE);
    stackSize = 16384;
    app_main();
    assert(selectedCore == EXPECTED_CORE);
    return 0;
}
`
  try {
    mkdirSync(path.dirname(sdkMain), { recursive: true })
    writeFileSync(sdkMain, source)
    const makefile = path.join(directory, 'Makefile')
    writeFileSync(makefile, `${mainDirectory}/main.c: ${mainDirectory} ${sdkMain}\n\tcp ${sdkMain} $@\n`)
    for (const [index, realtime] of [true, true, false, true].entries()) {
      // New sibling files can make the SDK's directory prerequisite newer.
      mkdirSync(mainDirectory, { recursive: true })
      writeFileSync(path.join(mainDirectory, `sibling-${index}`), '')
      const generated = prepareModdableMain({ moddableDirectory, mainDirectory, realtime })
      execFileSync('make', ['--no-print-directory', '-f', makefile, generated])
      const binary = path.join(directory, 'main-test')
      execFileSync('cc', [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-Wno-unused-function',
        `-DEXPECTED_CORE=${realtime ? 0 : -1}`,
        generated,
        '-o',
        binary,
      ])
      execFileSync(binary, { timeout: 5000 })
      assert.equal(readFileSync(sdkMain, 'utf8'), source)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an unsupported SDK entry point fails before materializing a realtime main', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stackchan-main-unsupported-'))
  try {
    const sdkMain = path.join(directory, 'build/devices/esp32/lib/main/main.c')
    mkdirSync(path.dirname(sdkMain), { recursive: true })
    writeFileSync(sdkMain, 'void app_main(void) {}\n')
    assert.throws(
      () =>
        prepareModdableMain({
          moddableDirectory: directory,
          mainDirectory: path.join(directory, 'output'),
          realtime: true,
        }),
      /Unsupported Moddable main task/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
