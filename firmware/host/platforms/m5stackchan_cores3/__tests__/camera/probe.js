import Resource from 'Resource'
import Conversation from 'realtimeConversation/core'
import fetch from 'realtimeConversation/http'
import Transport from 'realtimeConversation/transport'
import Performance from 'io-performance'
import config from 'mc/config'
import { onContextCreated as installConversation } from 'openai-live-integrated'
import Preference from 'preference'
import Timer from 'timer'

const sample = native('xs_camera_probe_sample')
const syntheticMic = native('xs_live_probe_synthetic_mic')
const measure = native('xs_live_probe_measure')
const watchTasks = native('xs_live_probe_tasks')
const inject = native('xs_live_probe_input')
const wait = (ms) => new Promise((resolve) => Timer.set(resolve, ms))
const options = { width: 160, height: 120, imageType: 'rgb565be' }
function report(event) {
  const line = `[camera-probe] ${JSON.stringify(event)}\n`
  // The USB console can truncate a long trace. Large records are emitted
  // outside the active audio window and give the host time to drain chunks.
  for (let offset = 0; offset < line.length; offset += 128) {
    trace(line.slice(offset, offset + 128))
    Timer.delay(2)
  }
}

function assertIdle(phase) {
  const after = sample()
  report({ phase, ...after })
  if (after.worker || after.hal) throw new Error(`${phase}:camera_task_remains`)
}

async function captureCycles(robot) {
  for (let cycle = 0; cycle < 50; cycle++) {
    const before = sample()
    await robot.camera.start(options)
    const frame = await robot.camera.capture(options)
    const firstFrameUs = sample().atUs - before.atUs
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
    report({ phase: 'cycle', cycle, before, active, stopped, after, firstFrameUs, stopUs: stopped.atUs - closing.atUs })
    if (after.worker || after.hal) throw new Error('cycle:camera_task_remains')
  }
  await robot.camera.start(options)
  await robot.camera.stop()
  await robot.camera.stop()
  await wait(250)
  assertIdle('immediate-stop')
}

async function verifyPreview() {
  const began = Performance.now()
  application.delegate('cameraPreview')
  let cameraWasActive = false
  while (Performance.now() - began < 4500) {
    const state = sample()
    cameraWasActive ||= state.worker && state.hal
    if (cameraWasActive && !state.worker && !state.hal) {
      report({ phase: 'preview-on-screen', elapsedMs: Performance.now() - began, ...state })
      await wait(5500)
      assertIdle('preview-dismissed')
      return
    }
    await wait(25)
  }
  throw new Error(cameraWasActive ? 'preview:camera_task_remains' : 'preview:camera_task_missing')
}

async function singleCapture(robot) {
  const frames = await Promise.all([robot.camera.capture(options), robot.camera.capture(options)])
  if (frames.some((frame) => frame?.buffer.byteLength !== 38400)) throw new Error('single_capture_missing')
  await wait(250)
  assertIdle('single-capture')
  // Use the copied frames after both native tasks have exited.
  report({ phase: 'single-frames', bytes: frames.map((frame) => new Uint8Array(frame.buffer).length) })
}

async function measureDisplay(robot) {
  const heartbeat = Timer.repeat(() => Performance.mark(0), 20)
  const rows = []
  robot.ui.setFaceMotionEnabled?.(false)
  try {
    Performance.setLiveUI(true)
    for (let trial = -1; trial < 5; trial++) {
      Performance.reset()
      const before = sample()
      for (let frame = 0; frame < 40; frame++) {
        Performance.touch(frame >= 8 && frame < 24)
        robot.setMouthOpen?.((frame % 10) / 10, true)
        if (frame === 8) robot.ui.openDrawer()
        if (frame === 24) robot.ui.closeDrawer()
        await wait(50)
      }
      const after = sample()
      if (trial < 0) continue
      rows.push({
        phase: 'display',
        trial,
        elapsedUs: after.atUs - before.atUs,
        mainUs: (after.main - before.main) >>> 0,
        spiUs: (after.spiLoop - before.spiLoop) >>> 0,
        io: Performance.stats(),
      })
    }
  } finally {
    Timer.clear(heartbeat)
    Performance.touch(false)
    Performance.setLiveUI(false)
    robot.setMouthOpen?.(0, true)
    robot.ui.setFaceMotionEnabled?.(true)
  }
  for (const row of rows) report(row)
}

async function verifyConversation(robot) {
  const session = installConversation(robot)
  if (!session) throw new Error('conversation_unavailable')
  let conversation,
    greeting = 0
  class ProbeConversation extends Conversation {
    constructor(settings) {
      const observed = { userTranscripts: 0, speech: 0, clears: 0, search: 0, sources: 0, deviceSearchRequests: 0 }
      super(
        {
          ...settings,
          onTranscript(fragment) {
            if (fragment.role === 'user' && fragment.delta?.trim()) observed.userTranscripts++
            settings.onTranscript?.(fragment)
          },
          onEvent(event) {
            if (event.type === 'input_audio_buffer.speech_started') observed.speech++
            if (event.type === 'output_audio_buffer.cleared') observed.clears++
            const inner = event.event
            if (inner?.type === 'response.web_search_call.completed') observed.search++
            if (inner?.item?.type === 'web_search_call' && inner.item.status === 'completed') observed.search++
            if (inner?.annotation?.type === 'url_citation') observed.sources++
            settings.onEvent?.(event)
          },
          onError(error) {
            observed.error =
              typeof error.code === 'string' && /^[a-z0-9_:-]{1,80}$/i.test(error.code) ? error.code : 'provider_error'
            settings.onError?.(error)
          },
          onToolResult(result) {
            const output = typeof result.output === 'string' ? JSON.parse(result.output) : (result.output ?? {})
            observed.search++
            observed.sources += output.sources?.length ?? 0
            observed.searchError = !!(result.error ?? output.error)
            const code = result.error ?? output.error
            if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(code)) observed.searchErrorCode = code
            if (Number.isInteger(output.status)) observed.searchStatus = output.status
            settings.onToolResult?.(result)
          },
        },
        {
          createTransport: (callback) => (this.transport = new Transport(callback)),
          fetch(url, options) {
            if (url.endsWith('/v1/responses')) observed.deviceSearchRequests++
            return fetch(url, options)
          },
          setTimeout: (fn, ms) => Timer.set(fn, ms),
          clearTimeout: (timer) => Timer.clear(timer),
        },
      )
      this.observed = observed
      conversation = this
    }
    requestSearch(mode) {
      const text =
        'Search for the official Espressif ESP32-S3 datasheet. State the processor architecture briefly and cite the source.'
      this.transport.send(
        JSON.stringify({
          type: mode === 'live' ? 'response.item.create' : 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
        }),
      )
      this.transport.send(
        JSON.stringify({
          type: 'response.create',
          ...(mode === 'realtime' ? { response: { tool_choice: { type: 'function', name: 'search_web' } } } : {}),
        }),
      )
    }
    requestPlayback(mode) {
      const text = 'Count slowly from one to twenty in English, without an introduction.'
      if (mode === 'live') {
        this.transport.send(
          JSON.stringify({
            type: 'session.commentary.append',
            event_id: `camera_probe_greeting_${++greeting}`,
            delegation_id: null,
            content: text,
          }),
        )
      } else {
        this.transport.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
          }),
        )
        this.transport.send(JSON.stringify({ type: 'response.create' }))
      }
    }
  }
  session.Conversation = ProbeConversation
  const saved = session.settings
  const speechClip = config.cameraProbeSpeech ? new Resource('probe-input.pcm') : undefined
  syntheticMic(true)
  let failures = 0
  try {
    const cases = ['live', 'realtime'].flatMap((mode) => [true, false].map((bargeIn) => ({ mode, bargeIn })))
    for (const { mode, bargeIn } of cases) {
      session.settings = {
        ...saved,
        mode,
        model: mode === 'live' ? 'gpt-live-1' : 'gpt-realtime-2.1-mini',
        voice: 'marin',
        bargeIn,
        standbySeconds: 3600,
      }
      const startedAt = Performance.now()
      report({ phase: 'provider-start', mode, bargeIn })
      const records = []
      const record = (event) => {
        if (records.length === 128) throw new Error('provider_record_limit')
        records.push(event)
      }
      try {
        if (!(await session.start())) throw new Error('provider_startup')
        record({
          phase: 'connected',
          mode,
          bargeIn,
          pitch: session.settings.pitch ?? 0,
          startMs: Performance.now() - startedAt,
          stats: conversation.stats,
        })
        measure()
        watchTasks()
        const playbackAt = Performance.now()
        let progressAt = playbackAt
        conversation.requestPlayback(mode)
        while (!(conversation.stats.audibleMs >= 250)) {
          if (!session.active || Performance.now() - playbackAt >= 20000) throw new Error('provider_playback')
          await wait(100)
          const now = Performance.now()
          if (now - progressAt >= 5000) {
            record({
              phase: 'provider-wait',
              mode,
              bargeIn,
              elapsedMs: now - playbackAt,
              stats: conversation.stats,
              io: Performance.stats(),
              memory: sample(),
            })
            progressAt = now
          }
        }
        const playbackMs = Performance.now() - playbackAt
        if (playbackMs >= 20000) throw new Error('provider_playback')
        record({ phase: 'playback', mode, bargeIn, playbackMs })
        report({ phase: 'provider-playing', mode, bargeIn })
        // Capture is intentionally suspended during output when barge-in is off.
        while (!bargeIn && conversation.stats.outputIdleMs < 500) {
          if (!session.active || Performance.now() - playbackAt >= 40000) throw new Error('provider_playback')
          await wait(100)
        }
        if (bargeIn && speechClip) {
          const before = { ...conversation.observed }
          const injectedAt = Performance.now()
          inject(speechClip, true)
          const accepted = () =>
            mode === 'live'
              ? conversation.observed.userTranscripts > before.userTranscripts
              : conversation.observed.speech > before.speech && conversation.observed.clears > before.clears
          while (!accepted()) {
            if (!session.active || Performance.now() - injectedAt >= 20000) throw new Error('provider_input')
            await wait(100)
          }
          record({
            phase: 'input-accepted',
            mode,
            bargeIn,
            elapsedMs: Performance.now() - injectedAt,
            observed: { ...conversation.observed },
          })
        }
        if (bargeIn && config.cameraProbeSearch) {
          // The injected turn may still be answering. Use the existing
          // stop/start lifecycle so the forced search begins on a fresh turn.
          await session.stop()
          report({ phase: 'search-start', mode, bargeIn })
          if (!(await session.start())) throw new Error('provider_startup')
          measure()
          watchTasks()
          const before = conversation.stats
          const searchAt = Performance.now()
          conversation.requestSearch(mode)
          while (!(conversation.observed.search > 0 && conversation.observed.sources > 0)) {
            if (!session.active || conversation.observed.searchError || Performance.now() - searchAt >= 45000)
              throw new Error('provider_search')
            await wait(100)
          }
          const after = conversation.stats
          record({
            phase: 'search',
            mode,
            bargeIn,
            elapsedMs: Performance.now() - searchAt,
            captured: after.capturedSamples - before.capturedSamples,
            sent: after.sourceSamples - before.sourceSamples,
            overruns: after.overruns - before.overruns,
            observed: { ...conversation.observed },
          })
          if (
            !(after.capturedSamples > before.capturedSamples && after.sourceSamples > before.sourceSamples) ||
            after.overruns > before.overruns
          )
            throw new Error('provider_capture')
        }
        report({ phase: 'provider-measuring', mode, bargeIn })
        const duration = (config.cameraProbeSeconds ?? 12) * 1000
        const began = Performance.now()
        let before = conversation.stats
        let playbackRequest
        for (let elapsed = 0; elapsed < duration; elapsed += 10000) {
          if (elapsed > 0 && elapsed % 60000 === 0) {
            playbackRequest = { at: Performance.now(), audibleMs: before.audibleMs }
            conversation.requestPlayback(mode)
          }
          await wait(Math.min(10000, duration - elapsed))
          const after = conversation.stats
          if (playbackRequest) {
            if (after.audibleMs - playbackRequest.audibleMs >= 250) {
              record({ phase: 'repeated-playback', mode, bargeIn, elapsedMs: Performance.now() - began })
              playbackRequest = undefined
            } else if (Performance.now() - playbackRequest.at >= 20000) throw new Error('provider_playback')
          }
          const captured = after.capturedSamples - before.capturedSamples
          const sent = after.sourceSamples - before.sourceSamples
          const overruns = after.overruns - before.overruns
          const underruns = after.underruns - before.underruns
          record({
            phase: 'provider',
            mode,
            bargeIn,
            elapsedMs: Performance.now() - began,
            sent,
            captured,
            overruns,
            underruns,
            rendered: after.renderedSamples - before.renderedSamples,
            audibleMs: after.audibleMs - before.audibleMs,
            active: !!session.active,
            io: Performance.stats(),
            memory: sample(),
          })
          if (!session.active || !(sent > 0 && captured > 0) || overruns) throw new Error('provider_capture')
          before = after
          // Full serial records can block under duplex load. Emit only a small
          // liveness marker and flush the bounded records after audio stops.
          if (elapsed % 30000 === 20000)
            report({ phase: 'provider-progress', mode, bargeIn, elapsedMs: Performance.now() - began })
        }
      } catch (error) {
        failures++
        record({
          phase: 'provider-failure',
          mode,
          bargeIn,
          code: ['provider_capture', 'provider_playback', 'provider_input', 'provider_search'].includes(error.message)
            ? error.message
            : 'provider_startup',
          stats: conversation?.stats,
          observed: conversation && { ...conversation.observed },
          io: Performance.stats(),
          memory: sample(),
        })
      } finally {
        report({ phase: 'provider-stopping', mode, bargeIn })
        const stopAt = Performance.now()
        const beforeClose = Performance.stats()
        await session.stop()
        const stopMs = Performance.now() - stopAt
        const afterClose = Performance.stats()
        const closeAecCalls = afterClose.aecCalls - beforeClose.aecCalls
        const closeIoWrites = afterClose.ioWrites - beforeClose.ioWrites
        const memory = sample()
        for (const event of records) report(event)
        report({ phase: 'stopped', mode, bargeIn, stopMs, closeAecCalls, closeIoWrites, memory })
      }
    }
  } finally {
    syntheticMic(false)
    session.settings = saved
  }
  if (failures) throw new Error('provider_checks_failed')
}

export function onContextCreated(robot) {
  report({ phase: 'boot' })
  void (async () => {
    if (Preference.blockedWrites !== 0) throw new Error('preference_guard_unavailable')
    let blocked = false
    try {
      Preference.set('tts', 'volume', Preference.get('tts', 'volume'))
    } catch {
      blocked = true
    }
    if (!blocked || Preference.blockedWrites !== 1) throw new Error('preference_guard')
    await wait(1500)
    assertIdle('baseline')
    await measureDisplay(robot)
    await verifyPreview()
    await captureCycles(robot)
    await singleCapture(robot)
    await verifyConversation(robot)
    if (Preference.blockedWrites !== 1) throw new Error('unexpected_preference_write')
    report({ phase: 'done' })
  })().catch((error) => report({ phase: 'failed', code: error.message }))
}
