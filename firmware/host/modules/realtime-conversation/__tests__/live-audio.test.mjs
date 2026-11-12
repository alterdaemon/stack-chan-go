import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

for (const [fixture, title] of [
  ['levels.c', 'lightweight meter exposes existing audible progress and every output suppression state'],
  [
    'capture.c',
    'delayed capture AEC preserves microphone frames while independent I2S keeps playing; Off is unchanged',
  ],
  [
    'interruption.c',
    'blocking renderer flush discards queues on the audio owner, preserves capture and resumes a fresh turn',
  ],
])
  test(title, () => {
    const directory = mkdtempSync(join(tmpdir(), 'stackchan-live-audio-'))
    const path = (relative) => fileURLToPath(new URL(relative, import.meta.url))
    try {
      // Only hardware/RTOS boundaries are replaced. Compile the actual audio task.
      for (const header of [
        'xsHost.h',
        'mc.defines.h',
        'xsmc.h',
        'esp_timer.h',
        'esp_webrtc.h',
        'driver/i2s_std.h',
        'driver/i2c_master.h',
        'esp_heap_caps.h',
        'esp_ae_rate_cvt.h',
        'audio_render.h',
        'esp_aec.h',
        'freertos/FreeRTOS.h',
        'freertos/task.h',
        'freertos/stream_buffer.h',
      ]) {
        const destination = join(directory, header)
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, '#include "platform.h"\n')
      }
      const binary = join(directory, 'audio-test')
      execFileSync('cc', [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-Wno-unused-parameter',
        '-Wno-unused-but-set-variable',
        '-Wno-missing-field-initializers',
        '-Wno-sign-compare',
        '-fsanitize=address,undefined',
        '-pthread',
        '-ffunction-sections',
        '-fdata-sections',
        '-I',
        directory,
        '-I',
        path('./live-audio/'),
        '-I',
        path('../../../platforms/m5stackchan_cores3/'),
        path(`./live-audio/${fixture}`),
        '-Wl,--gc-sections',
        '-o',
        binary,
      ])
      execFileSync(binary, { timeout: 10000, env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
