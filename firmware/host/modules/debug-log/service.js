// Copyright (c) 2026 Stack-chan Community contributors
// SPDX-License-Identifier: Apache-2.0

import Debug from 'device-debug'
import { DebugRecorder } from 'device-debug/core'
import USBSerial from 'stackchan-usb-serial'
import { isUSBSerialOutputFullError } from 'stackchan-usb-serial-types'
import Timer from 'timer'

const now = native('xs_device_debug_now')
const available = native('xs_device_debug_available')
const stamp = native('xs_device_debug_stamp')
const enable = native('xs_device_debug_enable')
const readNative = native('xs_device_debug_read')
const info = native('xs_device_debug_info')
const tune = native('xs_device_debug_tune')
const nativeEvents = [
  'unknown',
  'interrupt.request',
  'flush.begin',
  'flush.end',
  'output.resume',
  'audio.stop',
  'output.recover',
  'peer.event',
  'transport.failure',
]
let serial,
  recorder,
  timer,
  nextSnapshot = 0

function snapshot() {
  recorder.emit('device', 'snapshot', { firmware: '2.1.0-R3', ...info(), ...Debug.snapshot() })
}
function poll() {
  recorder.tick(serial.connected)
  if (!recorder.enabled) return
  for (let i = 0; i < 32; i++) {
    const entry = readNative()
    if (!entry) break
    recorder.emit(
      'audio',
      nativeEvents[entry.code] ?? 'unknown',
      { request: entry.request, value: entry.value, result: entry.result },
      { ms: entry.ms, seq: entry.seq },
    )
  }
  if (now() >= nextSnapshot) {
    nextSnapshot = now() + 5000
    snapshot()
  }
}
export default function start() {
  if (!available()) return
  if (serial) return
  const buffer = new Uint8Array(256)
  recorder = new DebugRecorder({
    now,
    stamp,
    info: () => ({ firmware: '2.1.0-R3', ...info(), ...Debug.tuningSnapshot() }),
    async tune(parameter, value) {
      if (parameter === 'reset') {
        tune(0, 0)
        await Debug.resetTuning()
      } else if (parameter === 'speaker') tune(1, Math.round(value * 1024))
      else if (parameter === 'capture') tune(2, Math.round(1024 * 10 ** (value / 20)))
      else if (parameter === 'nlp') tune(3, value)
      else await Debug.tune(parameter, value)
    },
    snapshot,
    change(value) {
      enable(value)
      if (!value) void Debug.resetTuning().catch(() => {})
      if (timer !== undefined) {
        Timer.clear(timer)
        timer = undefined
      }
      if (value) {
        nextSnapshot = now() + 5000
        timer = Timer.repeat(poll, 100)
      }
    },
    write(line) {
      try {
        serial.write(new Uint8Array(ArrayBuffer.fromString(line)))
        return true
      } catch (error) {
        if (!isUSBSerialOutputFullError(error)) recorder.disable('usb_write')
        return false
      }
    },
  })
  serial = new USBSerial({
    receiveBufferBytes: 512,
    transmitBufferBytes: 4096,
    onReadable() {
      try {
        for (let i = 0; i < 8; i++) {
          const bytes = serial.read(buffer)
          if (!bytes) break
          recorder.parser.feed(buffer.subarray(0, bytes))
        }
      } catch {
        recorder.disable('usb_read')
      }
    },
    onWritable() {
      recorder.pump()
    },
    onError() {
      recorder.disable('usb_error')
    },
  })
  Debug.install(recorder)
}
