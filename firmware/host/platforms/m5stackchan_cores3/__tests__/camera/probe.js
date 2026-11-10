import Conversation from 'realtimeConversation'
import { onContextCreated as installConversation } from 'openai-live-integrated'
import Preference from 'preference'
import Timer from 'timer'

const sample = native('xs_camera_probe_sample')
const syntheticMic = native('xs_live_probe_synthetic_mic')
const wait = (ms) => new Promise((resolve) => Timer.set(resolve, ms))
const options = { width: 160, height: 120, imageType: 'rgb565be' }
const report = (event) => trace(`[camera-probe] ${JSON.stringify(event)}\n`)

function assertIdle(phase) {
  const after = sample()
  report({ phase, ...after })
  if (after.worker || after.hal) throw new Error(`${phase}:camera_task_remains`)
}

async function captureCycles(robot) {
  for (let cycle = 0; cycle < 8; cycle++) {
    const before = sample()
    await robot.camera.start(options)
    const frame = await robot.camera.capture(options)
    if (frame?.width !== 160 || frame.height !== 120 || frame.buffer.byteLength !== 38400)
      throw new Error('camera_frame_missing')
    const active = sample()
    if (!active.worker || !active.hal) throw new Error('camera_task_missing')
    // Also exercise stopping while a caller still owns a disposable buffer.
    if (cycle !== 3) frame.close?.()
    const closing = sample()
    await robot.camera.stop()
    const stopped = sample()
    frame.close?.()
    await wait(250)
    const after = sample()
    report({ phase: 'cycle', cycle, before, active, stopped, after, stopUs: stopped.atUs - closing.atUs })
    if (after.worker || after.hal) throw new Error('cycle:camera_task_remains')
  }
  await robot.camera.start(options)
  await robot.camera.stop()
  await robot.camera.stop()
  await wait(250)
  assertIdle('immediate-stop')
}

async function singleCapture(robot) {
  const frames = await Promise.all([robot.camera.capture(options), robot.camera.capture(options)])
  if (frames.some((frame) => frame?.buffer.byteLength !== 38400)) throw new Error('single_capture_missing')
  await wait(250)
  assertIdle('single-capture')
  // Use the copied frames after both native tasks have exited.
  report({ phase: 'single-frames', bytes: frames.map((frame) => new Uint8Array(frame.buffer).length) })
}

async function verifyConversation(robot) {
  const session = installConversation(robot)
  if (!session) throw new Error('conversation_unavailable')
  let conversation
  class ProbeConversation extends Conversation {
    constructor(settings) {
      super(settings)
      conversation = this
    }
  }
  session.Conversation = ProbeConversation
  const saved = session.settings
  syntheticMic(true)
  try {
    for (const mode of ['live', 'realtime']) {
      session.settings = {
        ...saved,
        mode,
        model: mode === 'live' ? 'gpt-live-1' : 'gpt-realtime-2.1-mini',
        voice: 'marin',
        bargeIn: true,
        standbySeconds: 60,
      }
      report({ phase: 'provider-start', mode })
      try {
        if (!(await session.start())) throw new Error('provider_startup')
        await wait(1000)
        const before = conversation.stats
        await wait(3000)
        const after = conversation.stats
        const sent = after.sourceSamples - before.sourceSamples
        const captured = after.capturedSamples - before.capturedSamples
        const overruns = after.overruns - before.overruns
        report({ phase: 'provider', mode, sent, captured, overruns, active: !!session.active, memory: sample() })
        if (!session.active || !(sent > 0 && captured > 0) || overruns) throw new Error('provider_capture')
      } catch (error) {
        report({ phase: 'provider-failure', mode, code: error.message === 'provider_capture' ? 'capture' : 'startup' })
      } finally {
        await session.stop()
      }
    }
  } finally {
    syntheticMic(false)
    session.settings = saved
  }
}

export function onContextCreated(robot) {
  report({ phase: 'boot' })
  void (async () => {
    let blocked = false
    try {
      Preference.set('tts', 'volume', Preference.get('tts', 'volume'))
    } catch {
      blocked = true
    }
    if (!blocked || Preference.blockedWrites !== 1) throw new Error('preference_guard')
    await wait(1500)
    assertIdle('baseline')
    application.delegate('cameraPreview')
    await wait(1100)
    assertIdle('preview-on-screen')
    await wait(5000)
    assertIdle('preview-dismissed')
    await captureCycles(robot)
    await singleCapture(robot)
    await verifyConversation(robot)
    if (Preference.blockedWrites !== 1) throw new Error('unexpected_preference_write')
    report({ phase: 'done' })
  })().catch((error) => report({ phase: 'failed', code: error.message }))
}
