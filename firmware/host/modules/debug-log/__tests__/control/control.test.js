import Debug from 'device-debug'
import { DebugRecorder } from 'device-debug/core'
import Timer from 'timer'

async function verifyLiveAPI() {
  // The production API owns only USB-started sessions. Ending diagnostics must
  // cancel an in-flight USB start without stopping a manually started session.
  let apiEnabled = false
  const apiRecorder = {
    get enabled() {
      return apiEnabled
    },
    emit() {},
  }
  Debug.install(apiRecorder)
  const owner = {}
  let finishStart,
    stopped = 0
  Debug.registerLive(owner, {
    start: () =>
      new Promise((resolve) => {
        finishStart = resolve
      }),
    stop: async () => {
      stopped++
      finishStart?.(false)
    },
  })
  try {
    await Debug.controlLive('start')
    throw new Error('Disabled LIVE was accepted')
  } catch (error) {
    if (error.code !== 'live_unavailable') throw error
  }
  apiEnabled = true
  const starting = Debug.controlLive('start').catch((error) => error)
  await Debug.stopControlledLive()
  if ((await starting)?.code !== 'live_start_failed') throw new Error('Cancelled LIVE was reported connected')
  if (stopped !== 1) throw new Error('USB start was not stopped exactly once')
  Debug.registerLive(owner, {
    start: () => undefined,
    stop: async () => {
      stopped++
    },
  })
  try {
    await Debug.controlLive('start')
  } catch (error) {
    if (error.code !== 'live_active') throw error
  }
  await Debug.stopControlledLive()
  if (stopped !== 1) throw new Error('A manual session gained USB ownership')
  Debug.registerLive(owner, {
    start: async () => true,
    stop: async () => {
      stopped++
    },
  })
  await Debug.controlLive('start')
  Debug.releaseLive(owner)
  await Debug.stopControlledLive()
  if (stopped !== 1) throw new Error('An ended USB session retained ownership of a later session')
  Debug.unregisterLive({})
  await Debug.controlLive('stop')
  if (stopped !== 2) throw new Error('Explicit Stop failed')
  Debug.unregisterLive(owner)
}
try {
  await verifyLiveAPI()
} catch (error) {
  trace(`LIVE API fixture: ${error.message} (${error.code})\n`)
  throw error
}

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
    if (line.includes('"phase":"applied"')) Timer.set(verifyAcknowledgement, 0)
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
const timeout = Timer.set(() => {
  throw new Error('RAM trial acknowledgement timed out')
}, 2000)
recorder.parser.feed(new Uint8Array(ArrayBuffer.fromString('diag set speaker 0\n')))
function verifyAcknowledgement() {
  Timer.clear(timeout)
  if (!records.some((line) => line.includes('"phase":"applied"'))) throw new Error('RAM trial acknowledgement failed')
  recorder.emit('device', 'tick', { phase: 'ready', password: 'private' })
  now = 30001
  recorder.tick()
  if (recorder.enabled || sampling) throw new Error('Lease failed to stop sampling')
  if (records.join('').includes('private')) throw new Error('Private data escaped')
  recorder.parser.feed(new Uint8Array(ArrayBuffer.fromString('diag off\n')))
  trace('@@STACKCHAN_TEST:PASS@@\n')
}
