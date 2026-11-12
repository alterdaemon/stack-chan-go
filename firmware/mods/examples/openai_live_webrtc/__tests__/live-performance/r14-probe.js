// One bounded, paired device series. All overrides stay in RAM.

import Resource from 'Resource'
import Conversation from 'realtimeConversation/core'
import fetch from 'realtimeConversation/http'
import Transport from 'realtimeConversation/transport'
import Performance from 'io-performance'
import config from 'mc/config'
import { onContextCreated as installLive } from 'openai-live-integrated'
import Preference from 'preference'
import Timer from 'timer'

const wait = (ms) => new Promise((resolve) => Timer.set(resolve, ms))
const report = (event) => trace(`[r14-probe] ${JSON.stringify(event)}\n`)
const snapshot = () => native('xs_r14_snapshot')()
const spi = (enabled) => native('xs_r14_spi_mode')(enabled)
function difference(before, after) {
  const result = { durationUs: after.atUs - before.atUs }
  for (const name of ['main', 'spiLoop', 'IDLE0', 'IDLE1']) result[name] = (after[name] - before[name]) >>> 0
  return result
}
export function onContextCreated(robot) {
  const savedVolume = Preference.get('tts', 'volume')
  report({ phase: 'boot', identity: 'r14-optimization-v1' })
  let heartbeat
  void (async () => {
    await wait(3000)
    robot.ui.setFaceMotionEnabled?.(false)
    heartbeat = Timer.repeat(() => Performance.mark(0), 20)
    const results = []
    // Same mouth/drawer sequence and UI budget for both implementations.
    for (let pair = 0; pair < (config.r14Pairs ?? 5); pair++) {
      for (const blocking of pair % 2 ? [true, false] : [false, true]) {
        spi(blocking)
        Performance.setLiveUI(true)
        Performance.reset()
        const before = snapshot()
        for (let frame = 0; frame < 40; frame++) {
          Performance.touch(frame >= 8 && frame < 24)
          robot.setMouthOpen?.((frame % 10) / 10, true)
          if (frame === 8) robot.ui.openDrawer()
          if (frame === 24) robot.ui.closeDrawer()
          await wait(50)
        }
        const after = snapshot()
        const result = { phase: 'spi', pair, blocking, ...difference(before, after), io: Performance.stats() }
        results.push(result)
      }
      report({ phase: 'progress', pair })
    }
    Timer.clear(heartbeat)
    Performance.touch(false)
    Performance.setLiveUI(false)
    spi(true)
    robot.setMouthOpen?.(0, true)
    for (const result of results) report(result)
    for (let pair = 0; pair < (config.r14MediaOnly ? 0 : 5); pair++) {
      for (const internal of pair % 2 ? [true, false] : [false, true]) {
        const result = native('xs_r14_aec_bench')(internal)
        report({ phase: 'aec', pair, ...result })
        await wait(100)
      }
    }
    report({ phase: 'memory', ...snapshot() })
    const clip = new Resource('probe-input.pcm')
    native('xs_live_probe_synthetic_mic')(true)
    const session = installLive(robot)
    let current
    class ProbeConversation extends Conversation {
      constructor(options) {
        const observed = { user: 0, assistant: 0, clears: 0 }
        super(
          {
            ...options,
            onTranscript(fragment) {
              if (fragment.delta?.trim()) observed[fragment.role] = (observed[fragment.role] ?? 0) + 1
              options.onTranscript?.(fragment)
            },
            onEvent(event) {
              if (event.type === 'input_audio_buffer.speech_started') observed.speech = (observed.speech ?? 0) + 1
              if (event.type === 'output_audio_buffer.started') observed.playing = true
              if (event.type === 'output_audio_buffer.stopped') observed.playing = false
              if (event.type === 'output_audio_buffer.cleared') {
                observed.clears++
                observed.playing = false
              }
              options.onEvent?.(event)
            },
          },
          {
            createTransport: (callback) => (this.transport = new Transport(callback)),
            fetch,
            setTimeout: (fn, ms) => Timer.set(fn, ms),
            clearTimeout: (timer) => Timer.clear(timer),
          },
        )
        this.observed = observed
        current = this
      }
      greet(mode) {
        const text = 'Count slowly from one to thirty in English, without an introduction.'
        if (mode === 'live')
          this.transport.send(
            JSON.stringify({
              type: 'session.commentary.append',
              event_id: 'r14_greeting',
              delegation_id: null,
              content: text,
            }),
          )
        else {
          this.transport.send(
            JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text }],
              },
            }),
          )
          this.transport.send(JSON.stringify({ type: 'response.create' }))
        }
      }
    }
    session.Conversation = ProbeConversation
    try {
      const cases = config.r14Followup
        ? [false, true].map((blocking) => ({ mode: 'realtime', bargeIn: true, blocking }))
        : ['live', 'realtime'].flatMap((mode) => [false, true].map((bargeIn) => ({ mode, bargeIn, blocking: true })))
      for (const { mode, bargeIn, blocking } of cases) {
        spi(blocking)
        try {
          session.settings = {
            ...session.settings,
            mode,
            bargeIn,
            standbySeconds: 60,
            model: mode === 'live' ? 'gpt-live-1' : 'gpt-realtime-2.1-mini',
            voice: 'marin',
            pitch: 0,
            instructions:
              'You are a voice test assistant. Follow counting requests exactly. Reply briefly to other requests.',
          }
          report({ phase: 'media_start', mode, bargeIn, blocking })
          if (!(await session.start())) throw new Error('media_startup')
          heartbeat = Timer.repeat(() => Performance.mark(0), 20)
          Performance.reset()
          const before = snapshot()
          current.greet(mode)
          if (config.r14MediaOnly) {
            const until = async (predicate, timeout, code) => {
              const at = Performance.now()
              while (!predicate()) {
                if (!session.active || Performance.now() - at > timeout) throw new Error(code)
                await wait(100)
              }
            }
            await until(() => current.observed.playing && current.stats.audibleMs > 500, 20000, 'playback_missing')
            robot.ui.openDrawer()
            Performance.touch(true)
            await wait(500)
            robot.ui.closeDrawer()
            Performance.touch(false)
            const speeches = current.observed.speech ?? 0,
              clears = current.observed.clears
            native('xs_live_probe_input')(clip, true)
            await until(
              () => (current.observed.speech ?? 0) > speeches && current.observed.clears > clears,
              15000,
              'barge_missing',
            )
            const result = {
              phase: 'media',
              mode,
              bargeIn,
              blocking,
              media: { ...current.stats },
              observed: { ...current.observed },
              io: Performance.stats(),
              memory: snapshot(),
            }
            await session.stop()
            Timer.clear(heartbeat)
            report(result)
            await wait(500)
            continue
          }
          for (let tick = 0; tick < 100; tick++) {
            if (!session.active) throw new Error('media_disconnected')
            if (tick === 20) robot.ui.openDrawer()
            if (tick === 55) robot.ui.closeDrawer()
            Performance.touch(tick >= 20 && tick < 55)
            await wait(100)
          }
          const media = { ...current.stats }
          const after = snapshot()
          if (!media.audibleMs || !media.capturedSamples || media.overruns || !Performance.stats().ioWrites)
            throw new Error('media_progress')
          if (bargeIn) {
            const users = current.observed.user ?? 0
            native('xs_live_probe_input')(clip, true)
            const at = Performance.now()
            while ((current.observed.user ?? 0) <= users) {
              if (!session.active || Performance.now() - at > 20000) throw new Error('input_missing')
              await wait(100)
            }
          }
          const result = {
            phase: 'media',
            mode,
            bargeIn,
            blocking,
            media,
            observed: current.observed,
            cpu: difference(before, after),
            io: Performance.stats(),
            memory: after,
          }
          // STOP is deliberately allowed during playback; cleanup must complete.
          await session.stop()
          Timer.clear(heartbeat)
          report(result)
          if (session.active) throw new Error('media_cleanup')
          await wait(500)
        } catch (error) {
          report({
            phase: 'media_failed',
            mode,
            bargeIn,
            blocking,
            code: error.message,
            media: current?.stats,
            observed: current?.observed,
            io: Performance.stats(),
            memory: snapshot(),
          })
          await session.stop()
          if (heartbeat !== undefined) Timer.clear(heartbeat)
          robot.ui.closeDrawer()
          if (!config.r14Followup) throw error
        }
      }
    } finally {
      if (heartbeat !== undefined) Timer.clear(heartbeat)
      await session.stop()
    }
    robot.ui.setFaceMotionEnabled?.(true)
    // Production UI controls can persist changes independently of probe overrides.
    // Detect them; never silently report preservation or write a replacement.
    if (Preference.get('tts', 'volume') !== savedVolume) throw new Error('volume_preference_changed')
    report({ phase: 'done' })
  })().catch((error) => {
    if (heartbeat !== undefined) Timer.clear(heartbeat)
    Performance.setLiveUI(false)
    spi(true)
    robot.ui.closeDrawer()
    robot.ui.setFaceMotionEnabled?.(true)
    report({ phase: 'failed', code: error.name, message: error.message })
  })
}
