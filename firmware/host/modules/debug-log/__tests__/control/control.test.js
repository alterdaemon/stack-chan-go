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
    stopped = 0,
    warmed = 0
  Debug.registerLive(owner, {
    start: () =>
      new Promise((resolve) => {
        finishStart = resolve
      }),
    stop: async () => {
      stopped++
      finishStart?.(false)
    },
    warmup: async () => {
      warmed++
    },
  })
  try {
    await Debug.controlLive('start')
    throw new Error('Disabled LIVE was accepted')
  } catch (error) {
    if (error.code !== 'live_unavailable') throw error
  }
  apiEnabled = true
  await Debug.controlLive('warmup')
  if (warmed !== 1 || stopped || finishStart) throw new Error('Warmup changed the LIVE session')
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
  let active = false,
    observed
  Debug.registerLive(owner, {
    isActive: () => active,
    start: async (interruption, standard, voice, parameters) => {
      active = true
      observed = { interruption, standard, voice, parameters }
      return true
    },
    stop: async () => {
      active = false
    },
  })
  Debug.setLiveTrial('model', 'gpt-6-luna')
  Debug.setLiveTrial('effort', 'low')
  Debug.setLiveTrial('pitch', -6)
  Debug.setLiveTrial('style', 'expressive')
  Debug.setLiveTrial('volume', 0)
  Debug.setLiveTrial('prompt', 'long')
  Debug.setLiveTrial('standby', 1)
  Debug.setVoiceTrial('juniper')
  Debug.setInterruptionTrial('off')
  await Debug.controlLive('start')
  if (observed.interruption !== false || observed.standard !== 4) throw new Error('Off override lost')
  if (
    observed.voice !== 'juniper' ||
    observed.parameters.model !== 'gpt-6-luna' ||
    observed.parameters.effort !== 'low' ||
    observed.parameters.pitch !== -6 ||
    observed.parameters.volume !== 0 ||
    observed.parameters.style !== 'expressive' ||
    observed.parameters.prompt !== 'long' ||
    observed.parameters.standby !== 1
  )
    throw new Error('Parameter trial lost')
  try {
    Debug.setVoiceTrial('cove')
    throw new Error('Active voice accepted')
  } catch (error) {
    if (error.code !== 'live_active') throw error
  }
  try {
    Debug.setInterruptionTrial('on')
    throw new Error('Active trial accepted')
  } catch (error) {
    if (error.code !== 'live_active') throw error
  }
  await Debug.controlLive('stop')
  try {
    Debug.setVoiceTrial('unknown')
    throw new Error('Unknown voice accepted')
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
  }
  Debug.setInterruptionTrial('on')
  await Debug.controlLive('standard')
  if (observed.interruption !== true || observed.standard !== 0) throw new Error('Standard trial lost')
  await Debug.controlLive('stop')
  for (const [name, value] of [
    ['pitch', 7],
    ['volume', -1],
    ['style', 'arbitrary'],
    ['prompt', 'private text'],
    ['standby', 0],
    ['apiKey', 'secret'],
  ]) {
    try {
      Debug.setLiveTrial(name, value)
      throw new Error('Invalid parameter accepted')
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
    }
  }
  await Debug.resetTuning()
  if (Debug.tuningSnapshot().interruptionTrial !== 'saved' || Debug.tuningSnapshot().voiceTrial !== 'saved')
    throw new Error('Trial reset lost')
  await Debug.controlLive('standard')
  if (observed.interruption !== false || observed.standard !== 0 || observed.parameters !== undefined)
    throw new Error('Baseline defaults lost')
  await Debug.controlLive('stop')
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
