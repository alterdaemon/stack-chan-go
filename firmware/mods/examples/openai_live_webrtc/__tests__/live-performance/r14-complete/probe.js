// Diagnostic-only grouped experiments. Saved preferences are read-only.

import Transport from 'realtimeConversation/transport'
import Performance from 'io-performance'
import config from 'mc/config'
import { Port } from 'piu/MC'
import Preference from 'preference'
import runOptions from 'r14-complete-options'
import remaining from 'r14-complete-remaining'
import Timer from 'timer'

const wait = (ms) => new Promise((resolve) => Timer.set(resolve, ms))
const bindings = {
  xs_r14_snapshot: native('xs_r14_snapshot'),
  xs_r14_counters: native('xs_r14_counters'),
  xs_r14_configure: native('xs_r14_configure'),
  xs_r14_counters_reset: native('xs_r14_counters_reset'),
  xs_r14_local_feed: native('xs_r14_local_feed'),
  xs_r14_local_packet: native('xs_r14_local_packet'),
  xs_r14_tail: native('xs_r14_tail'),
  xs_r14_local_close: native('xs_r14_local_close'),
  xs_r14_tasks: native('xs_r14_tasks'),
  xs_r14_meter_bench: native('xs_r14_meter_bench'),
}
const call = (name, ...args) => bindings[name](...args)
const report = (event) => trace(`[r14-complete] ${JSON.stringify(event)}\n`)
const snapshot = () => call('xs_r14_snapshot')
const counters = () => call('xs_r14_counters')
function configure({ rate = 48000, dma = 3, internal = false, meter = 1, priming = 0, stall = 0, every = 0 } = {}) {
  call('xs_r14_configure', rate, dma, internal, meter, priming, stall, every)
}
function cpu(before, after) {
  const result = { durationUs: after.atUs - before.atUs }
  for (const name of [
    'main',
    'spiLoop',
    'live_audio',
    'AUD_SRC',
    'aenc_0',
    'pc_send',
    'pc_task',
    'Adec',
    'ARender',
    'IDLE0',
    'IDLE1',
  ])
    if (before[name] !== undefined && after[name] !== undefined) result[name] = (after[name] - before[name]) >>> 0
  return result
}
async function local(robot, options, duration = 2500) {
  configure(options)
  const release = await robot.audio.acquireExclusive()
  globalThis.amp.sampleRate = options.rate ?? 48000
  Performance.setLiveUI(options.bargeIn ?? true)
  call('xs_r14_counters_reset')
  let failure
  const transport = new Transport((event) => {
    if (event.type === 'error') failure = `${event.stage ?? 'capture_transport'}:${event.code}`
  })
  transport.start({ captureOnly: true, bargeIn: options.bargeIn ?? true, pitch: options.pitch ?? 0, realtime: true })
  let feed, mouth
  let mouthCallbacks = 0,
    mouthChanges = 0,
    lastMouth = 0,
    sent = 0,
    lateMax = 0
  try {
    const began = Performance.now()
    while (!transport.stats.capturedSamples) {
      if (failure || Performance.now() - began > 12000) throw new Error(failure ?? 'capture_start_timeout')
      await wait(50)
    }
    const feedSafely = (action) => {
      try {
        action()
      } catch (error) {
        failure = error.message
        if (feed !== undefined) Timer.clear(feed)
        feed = undefined
      }
    }
    if (options.holdPriming) {
      // Leave a real PCM block below the threshold without a tail marker.
      call('xs_r14_local_feed')
      sent = 1
    } else if (options.arrivals) {
      const at = Performance.now()
      feed = Timer.repeat(
        () =>
          feedSafely(() => {
            const elapsed = Performance.now() - at
            while (sent < options.arrivals.length && elapsed >= options.arrivals[sent]) {
              lateMax = Math.max(lateMax, elapsed - options.arrivals[sent])
              const packet = options.packets?.[sent]
              if (packet) call('xs_r14_local_packet', options.resource, packet.offset, packet.size, sent * 20)
              else call('xs_r14_local_feed')
              sent++
            }
            if (sent === options.arrivals.length) {
              call('xs_r14_tail', true)
              Timer.clear(feed)
              feed = undefined
            }
          }),
        2,
      )
    } else feed = Timer.repeat(() => feedSafely(() => call('xs_r14_local_feed')), 10)
    if (options.mouth !== false) {
      mouth = Timer.repeat(() => {
        mouthCallbacks++
        const value = Math.min(10, Math.round((Performance.levels().playbackLevel ?? 0) / 200)) / 10
        if (value !== lastMouth) {
          mouthChanges++
          lastMouth = value
          robot.setMouthOpen?.(value, true)
        }
      }, options.mouth ?? 100)
    }
    await wait(options.warmup ?? 400)
    mouthCallbacks = mouthChanges = 0
    const before = snapshot(),
      beforeCounters = counters()
    const work = options.work?.()
    await wait(duration)
    const workResult = await work
    if (failure) throw new Error(failure)
    return {
      cpu: cpu(before, snapshot()),
      snapshotBefore: before,
      before: beforeCounters,
      after: counters(),
      media: transport.stats,
      memory: snapshot(),
      mouthCallbacks,
      mouthChanges,
      sent,
      lateMax,
      workResult,
    }
  } finally {
    for (const timer of [feed, mouth]) if (timer !== undefined) Timer.clear(timer)
    await transport.close()
    Performance.setLiveUI(false)
    robot.setMouthOpen?.(0, true)
    globalThis.amp.sampleRate = 24000
    await release()
    await wait(200)
  }
}
export function onContextCreated(robot) {
  report({ phase: 'boot', identity: 'r14-complete-v1', preferenceGuard: true })
  void (async () => {
    await wait(2000)
    robot.ui.setFaceMotionEnabled?.(false)
    // Prove that attempted writes cannot reach the native NVS setter.
    const value = Preference.get('tts', 'volume')
    let blocked = false
    try {
      Preference.set('tts', 'volume', value)
    } catch {
      blocked = true
    }
    if (!blocked || Preference.get('tts', 'volume') !== value) throw new Error('preference_guard')
    report({ phase: 'guard', passed: true, blockedWrites: Preference.blockedWrites })
    report({ phase: 'tasks', scenario: 'fresh', tasks: call('xs_r14_tasks'), memory: snapshot() })
    const helpers = {
      local,
      configure,
      snapshot,
      counters,
      cpu,
      wait,
      report,
      reset: () => call('xs_r14_counters_reset'),
      tasks: () => call('xs_r14_tasks'),
    }
    if (!runOptions.only) {
      // P04: benchmark actual captureStats, including its accounting and mute branch.
      for (let pair = 0; pair < (config.r14SkipMeter ? 0 : 5); pair++) {
        for (const every of pair % 2 ? [10, 4, 2, 1] : [1, 2, 4, 10]) {
          configure()
          const result = call('xs_r14_meter_bench', every)
          report({ phase: 'P04', pair, every, frames: 4000, chunk: 512, ...result })
          await wait(50)
        }
      }
      // P02/P03: the same real I2S, rate conversion, reference delay, AEC and UI.
      for (const proposal of ['P02', 'P03']) {
        let failedCandidate = false
        for (let pair = 0; pair < 5; pair++) {
          for (const candidate of pair % 2 ? [true, false] : [false, true]) {
            if (candidate && failedCandidate) continue
            const options = proposal === 'P02' ? { rate: candidate ? 24000 : 48000 } : { internal: candidate }
            report({ phase: 'start', proposal, pair, candidate })
            try {
              const result = await local(robot, options)
              report({ phase: proposal, pair, candidate, options, ...result })
            } catch (error) {
              report({ phase: `${proposal}-failure`, pair, candidate, options, code: error.message })
              if (!candidate) throw error
              failedCandidate = true
            }
          }
        }
      }
      // Every supported pitch value at each hardware rate.
      for (const rate of [48000, 24000]) {
        for (let pitch = -6; pitch <= 6; pitch++) {
          report({ phase: 'start', proposal: 'P02-pitch', rate, pitch })
          try {
            const result = await local(robot, { rate, pitch }, 800)
            report({ phase: 'P02-pitch', rate, pitch, ...result })
          } catch (error) {
            report({ phase: 'P02-pitch-failure', rate, pitch, code: error.message })
            if (rate === 48000) throw error
            break
          }
        }
      }
      // P05: same real callback and quantized change suppression; no touch injection.
      for (let pair = 0; pair < 3; pair++) {
        for (const mouth of pair % 2 ? [200, 180, 150, 100] : [100, 150, 180, 200]) {
          report({ phase: 'start', proposal: 'P05', pair, mouth })
          report({ phase: 'P05', pair, mouth, ...(await local(robot, { mouth }, 4000)) })
        }
      }
      // P06: force a full invalidation only in the control, preserving the animation.
      configure()
      const invalidator = new Port(null, { left: 0, right: 0, top: 0, bottom: 0, active: false })
      robot.ui.addEffect(invalidator, 'r14-redraw-control')
      for (let pair = 0; pair < 3; pair++) {
        for (const full of pair % 2 ? [true, false] : [false, true]) {
          call('xs_r14_counters_reset')
          const before = snapshot()
          for (let frame = 0; frame < 60; frame++) {
            robot.setMouthOpen?.((frame % 10) / 10, true)
            if (full) invalidator.invalidate()
            await wait(50)
          }
          report({ phase: 'P06', pair, full, cpu: cpu(before, snapshot()), counters: counters() })
        }
      }
      robot.ui.removeEffect(invalidator)
      // P09: hardware overflow callbacks distinguish RX DMA loss from software FIFO loss.
      for (const stall of [0, 25000, 45000]) {
        for (let pair = 0; pair < 3; pair++) {
          for (const dma of pair % 2 ? [6, 4, 3] : [3, 4, 6]) {
            report({ phase: 'start', proposal: 'P09', pair, dma, stall })
            try {
              report({ phase: 'P09', pair, dma, stall, ...(await local(robot, { dma, stall, every: stall ? 40 : 0 })) })
            } catch (error) {
              report({ phase: 'P09-failure', pair, dma, stall, code: error.message })
            }
          }
        }
      }
      // P11: capture without publishing or retaining an image; explicit stop/close.
      for (const scenario of [
        'before-camera',
        'camera-active',
        'camera-stopped',
        'camera-restarted',
        'camera-closed',
      ]) {
        if (scenario === 'camera-active' || scenario === 'camera-restarted') {
          const frame = await robot.camera.capture()
          if (!frame?.buffer?.byteLength) throw new Error('camera_frame_missing')
          frame.close?.()
        }
        if (scenario === 'camera-stopped') await robot.camera.stop()
        if (scenario === 'camera-closed') await robot.camera.close?.()
        const before = snapshot(),
          tasks = call('xs_r14_tasks')
        await wait(3000)
        report({
          phase: 'P11',
          scenario,
          cpu: cpu(before, snapshot()),
          tasksBefore: tasks,
          tasksAfter: call('xs_r14_tasks'),
          memory: snapshot(),
        })
        try {
          report({ phase: 'P11-media', scenario, ...(await local(robot, {}, 1800)) })
        } catch (error) {
          report({ phase: 'P11-media-failure', scenario, code: error.message })
        }
      }
    }
    await remaining(robot, helpers, runOptions.only)
    robot.ui.setFaceMotionEnabled?.(true)
    if (Preference.get('tts', 'volume') !== value || Preference.blockedWrites !== 1)
      throw new Error('preferences_changed_or_write_attempted')
    report({ phase: 'done', blockedWrites: Preference.blockedWrites })
  })().catch((error) => {
    try {
      call('xs_r14_local_close')
    } catch {}
    robot.ui.setFaceMotionEnabled?.(true)
    report({ phase: 'failed', code: error.name, message: error.message })
  })
}
