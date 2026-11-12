import { DebugRecorder } from 'device-debug/core'
import Timer from 'timer'

let now = 0,
  sequence = 0,
  sampling,
  constructed = false
const records = []
const recorder = new DebugRecorder({
  now: () => now,
  stamp: () => ({ ms: now, seq: ++sequence }),
  info: () => ({ firmware: 'test' }),
  change(enabled) {
    sampling = enabled
  },
  snapshot() {},
  async tune() {},
  write(line) {
    records.push(line)
    return true
  },
})
recorder.emit('device', 'disabled', () => {
  constructed = true
  return {}
})
if (constructed || sampling) throw new Error('Disabled diagnostics performed work')
recorder.parser.feed(new Uint8Array(ArrayBuffer.fromString('diag on\n')))
if (!recorder.enabled || !sampling) throw new Error('USB enable failed')
recorder.parser.feed(new Uint8Array(ArrayBuffer.fromString('diag set speaker 0\n')))
Timer.set(() => {
  if (!records.some((line) => line.includes('"phase":"applied"'))) throw new Error('RAM trial acknowledgement failed')
  recorder.emit('device', 'tick', { phase: 'ready', password: 'private' })
  now = 30001
  recorder.tick()
  if (recorder.enabled || sampling) throw new Error('Lease failed to stop sampling')
  if (records.join('').includes('private')) throw new Error('Private data escaped')
  recorder.parser.feed(new Uint8Array(ArrayBuffer.fromString('diag off\n')))
  trace('@@STACKCHAN_TEST:PASS@@\n')
}, 10)
