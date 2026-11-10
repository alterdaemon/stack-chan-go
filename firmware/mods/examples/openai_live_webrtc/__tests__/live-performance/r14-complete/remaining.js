import Resource from 'Resource'
import Conversation from 'realtimeConversation/core'
import fetch from 'realtimeConversation/http'
import Transport from 'realtimeConversation/transport'
import { createWebSearchTool } from 'realtimeConversation/web-search'
import Performance from 'io-performance'
import config from 'mc/config'
import { onContextCreated as installLive } from 'openai-live-integrated'
import runOptions from 'r14-complete-options'
import Timer from 'timer'

const decode = native('xs_r14_decoder_bench')
const synth = native('xs_live_probe_synthetic_mic')
const inject = native('xs_live_probe_input')
const safe = (value) => (typeof value === 'string' && /^[a-z0-9_:-]{1,80}$/i.test(value) ? value : 'diagnostic_error')
const question =
  'Search for the official Espressif ESP32-S3 datasheet. State the processor architecture briefly and cite the source.'

function opusFixture() {
  const resource = new Resource('probe-opus.dat')
  const bytes = new Uint8Array(resource)
  const frames = []
  for (let offset = 0; offset < bytes.length; ) {
    const size = bytes[offset] | (bytes[offset + 1] << 8)
    offset += 2
    if (size <= 0 || offset + size > bytes.length) throw new Error('packet_fixture_bounds')
    frames.push({ offset, size })
    offset += size
  }
  if (frames.length < 30 || frames.length > 256) throw new Error('packet_fixture_length')
  return { resource, frames }
}

async function packetBatch({ configure, reset, counters, report, wait }) {
  const { resource, frames } = opusFixture()
  configure()
  let reference
  for (let pair = 0; pair < 5; pair++) {
    for (const batch of pair % 2 ? [3, 1] : [1, 3]) {
      reset()
      const result = decode(resource, batch, 0)
      const counts = counters()
      reference ??= result
      if (result.packets !== frames.length || result.hash !== reference.hash || result.samples !== reference.samples)
        throw new Error('decoder_payload_mismatch')
      report({
        phase: 'P07',
        pair,
        batch,
        ...result,
        allocations: counts.allocations,
        allocatedBytes: counts.allocatedBytes,
      })
      await wait(60)
    }
  }
  const cancelled = [1, 3].map((batch) => ({ batch, ...decode(resource, batch, 17) }))
  if (cancelled.some((r) => !r.cancelled || r.packets !== 17) || cancelled[0].hash !== cancelled[1].hash)
    throw new Error('decoder_cancellation_mismatch')
  report({ phase: 'P07-cancel', cancelled })
}

async function playbackPriming(robot, { local, report }) {
  const patterns = {
    smooth: Array.from({ length: 80 }, (_, i) => i * 10),
    burst: Array.from({ length: 80 }, (_, i) => Math.floor(i / 6) * 60),
    gaps: Array.from({ length: 80 }, (_, i) => Math.max(i * 10, Math.floor(i / 20) * 200 + (i % 20 >= 10 ? 140 : 0))),
    tail: [0, 10, 20],
  }
  for (const [pattern, arrivals] of Object.entries(patterns)) {
    for (let pair = 0; pair < 3; pair++) {
      let expected
      for (const priming of pair % 2 ? [60, 40, 20, 0] : [0, 20, 40, 60]) {
        const r = await local(robot, { priming, arrivals, warmup: 0, mouth: false }, arrivals.at(-1) + 250)
        expected ??= r.after.outputHash
        if (
          r.sent !== arrivals.length ||
          r.after.receivedBytes !== arrivals.length * 960 ||
          r.after.outputHash !== expected
        )
          throw new Error('priming_payload_mismatch')
        report({ phase: 'P08', pattern, pair, priming, ...r })
      }
    }
  }
}

async function cancelPriming(robot, { local, report }) {
  const cancelledPriming = await local(robot, { priming: 60, holdPriming: true, warmup: 0, mouth: false }, 200)
  const queued = cancelledPriming.after.maxQueueBytes
  report({ phase: 'P08-hold', queued, dequeued: cancelledPriming.after.receivedBytes })
  if (cancelledPriming.sent !== 1 || queued !== 960 || cancelledPriming.after.receivedBytes !== 0)
    throw new Error('priming_stop_precondition')
  const options = { arrivals: [0, 10, 20], warmup: 0, mouth: false }
  const reference = await local(robot, options, 270)
  const next = await local(robot, { ...options, priming: 60 }, 270)
  if (next.after.receivedBytes !== 3 * 960 || next.after.outputHash !== reference.after.outputHash)
    throw new Error('priming_replacement_payload')
  report({
    phase: 'P08-cancel',
    cancelled: cancelledPriming,
    referenceHash: reference.after.outputHash,
    replacement: next,
  })
}

async function allocationReplay(robot, { local, counters, report }) {
  const { resource, frames } = opusFixture()
  const arrivals = frames.map((_, i) => i * 20)
  for (const rate of [48000, 24000]) {
    for (let pair = 0; pair < 3; pair++) {
      try {
        const result = await local(robot, { rate, resource, packets: frames, arrivals }, arrivals.at(-1) + 250)
        if (result.sent !== frames.length || !result.media.renderedSamples || !result.media.encodedFrames)
          throw new Error('opus_progress')
        report({ phase: 'P02-opus', rate, pair, ...result })
        report({
          phase: 'P10',
          rate,
          pair,
          startupAllocations: result.before.allocations,
          steadyAllocations: result.after.allocations - result.before.allocations,
          steadyAllocatedBytes: result.after.allocatedBytes - result.before.allocatedBytes,
          steadyFrees: result.after.frees - result.before.frees,
          pcmDequeuedBytes: result.after.receivedBytes,
          afterTeardown: counters(),
        })
      } catch (error) {
        report({ phase: 'P02-opus-failure', rate, pair, code: safe(error.message) })
        if (rate === 48000) throw error
        break
      }
    }
  }
}

async function delayedSearch(robot, { local, wait, report, tasks }) {
  const workerReplay = runOptions.workerReplay
  const fixture = workerReplay
    ? { url: 'https://r14-fixture.invalid/slow' }
    : JSON.parse(String.fromArrayBuffer(new Resource('https-fixture.dat')))
  for (const cancel of [false, true]) {
    let requests = 0
    const tool = createWebSearchTool({
      model: 'diagnostic',
      apiKey: 'fixture-not-a-secret',
      fetch(_url, options) {
        requests++
        return fetch(fixture.url, {
          ...options,
          headers: { 'Content-Type': 'application/json' },
          certificate: fixture.certificate,
        })
      },
    })
    const work = async () => {
      const start = Performance.now(),
        tasksBefore = tasks()
      let cancelled = false,
        listener
      const context = {
        isCancelled: () => cancelled,
        onCancel(callback) {
          listener = callback
          return () => {
            listener = undefined
          }
        },
      }
      let timer
      if (cancel)
        timer = Timer.set(() => {
          cancelled = true
          listener?.()
        }, 350)
      try {
        const result = await tool.execute({ query: question }, context)
        return {
          sources: result.sources?.length ?? 0,
          error: result.error ? safe(result.error) : undefined,
          elapsedMs: Performance.now() - start,
          tasksBefore,
          tasksAfter: tasks(),
          requests,
        }
      } catch (error) {
        const cancelledAt = Performance.now()
        let followingRequestMs
        if (workerReplay && cancelled) {
          const following = await fetch('https://r14-fixture.invalid/fast', {
            method: 'POST',
            body: '{}',
            responseFormat: 'web-search',
            timeoutMs: 4000,
          })
          if (!following.ok) throw new Error('fixture_following_request')
          followingRequestMs = Performance.now() - cancelledAt
        }
        return {
          cancelled,
          code: cancelled
            ? 'cancelled'
            : /timed out/.test(error.message)
              ? 'request_timeout'
              : safe(error.code ?? error.name),
          elapsedMs: cancelledAt - start,
          followingRequestMs,
          tasksBefore,
          tasksAfter: tasks(),
          requests,
        }
      } finally {
        if (timer !== undefined) Timer.clear(timer)
      }
    }
    const result = await local(robot, { work }, 3500)
    report({ phase: 'P12-delay', fixture: workerReplay ? 'worker-replay' : 'tls', cancel, ...result })
    await wait(300)
  }
}

async function providerTests(robot, { configure, snapshot, counters, reset, cpu, wait, report }) {
  const session = installLive(robot),
    saved = session.settings
  const clip = new Resource('probe-input.pcm')
  let current,
    greeting = 0
  class ProbeConversation extends Conversation {
    constructor(options) {
      const observed = {
        speech: 0,
        clears: 0,
        transcripts: 0,
        userTranscripts: 0,
        completed: 0,
        search: 0,
        sources: 0,
        deviceSearchRequests: 0,
      }
      super(
        {
          ...options,
          onTranscript(fragment) {
            observed.transcripts++
            if (fragment.role === 'user' && fragment.delta?.trim()) observed.userTranscripts++
            options.onTranscript?.(fragment)
          },
          onEvent(event) {
            if (event.type === 'input_audio_buffer.speech_started') observed.speech++
            if (event.type === 'output_audio_buffer.cleared') observed.clears++
            if (event.type === 'output_audio_buffer.started') observed.playing = true
            if (event.type === 'output_audio_buffer.stopped') observed.playing = false
            if (event.type === 'response.done') observed.completed++
            const inner = event.event
            if (inner?.type === 'response.web_search_call.completed') observed.search++
            if (inner?.item?.type === 'web_search_call' && inner.item.status === 'completed') observed.search++
            if (inner?.type === 'response.completed') observed.completed++
            if (inner?.annotation?.type === 'url_citation') observed.sources++
            if (event.type === 'error') observed.error = safe(event.error?.code)
            options.onEvent?.(event)
          },
          onToolResult(result) {
            const output = typeof result.output === 'string' ? JSON.parse(result.output) : (result.output ?? {})
            observed.search++
            observed.sources += output.sources?.length ?? 0
            if (result.error ?? output.error) observed.toolError = safe(result.error ?? output.error)
            options.onToolResult?.(result)
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
      current = this
    }
    greet(mode) {
      const text = 'Count slowly from one to thirty in English, without an introduction.'
      if (mode === 'live')
        this.transport.send(
          JSON.stringify({
            type: 'session.commentary.append',
            event_id: `r14_greet_${++greeting}`,
            delegation_id: null,
            content: text,
          }),
        )
      else this.ask(text, false)
    }
    ask(text, forceSearch) {
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
      this.transport.send(
        JSON.stringify({
          type: 'response.create',
          ...(forceSearch ? { response: { tool_choice: { type: 'function', name: 'search_web' } } } : {}),
        }),
      )
    }
    hostedSearch() {
      this.transport.send(
        JSON.stringify({
          type: 'response.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: question }],
          },
        }),
      )
      this.transport.send(JSON.stringify({ type: 'response.create' }))
    }
  }
  session.Conversation = ProbeConversation
  synth(true)
  const until = async (predicate, timeout, code) => {
    const at = Performance.now()
    while (!predicate()) {
      if (!session.active || Performance.now() - at > timeout) throw new Error(code)
      await wait(100)
    }
  }
  async function run(mode, opts, body) {
    configure(opts)
    current = undefined
    reset()
    session.settings = {
      ...saved,
      mode,
      model: mode === 'live' ? 'gpt-live-1' : 'gpt-realtime-2.1-mini',
      voice: 'marin',
      volume: 0.5,
      pitch: opts.pitch ?? 0,
      standbySeconds: opts.standby ?? 120,
      bargeIn: opts.bargeIn ?? false,
      instructions:
        'Follow the user request accurately. Count slowly if asked to count. Use web search when asked for current sourced information.',
    }
    const at = Performance.now()
    try {
      if (!(await session.start())) throw new Error('provider_startup')
      return await body(Performance.now() - at)
    } finally {
      await session.stop()
    }
  }
  for (const mode of runOptions.providerLiveOnly ? ['live'] : ['live', 'realtime']) {
    for (const bargeIn of runOptions.providerLiveOnly ? [true] : [false, true]) {
      report({ phase: 'provider_start', mode, bargeIn })
      try {
        const result = await run(
          mode,
          { bargeIn, pitch: !runOptions.providerFresh && bargeIn ? 3 : 0 },
          async (startMs) => {
            const before = snapshot(),
              requested = Performance.now()
            current.greet(mode)
            await until(() => current.stats.audibleMs > 400, 20000, 'playback_missing')
            const firstAudibleMs = Performance.now() - requested
            if (bargeIn) {
              await until(() => current.stats.sourceSamples > 0, 3000, 'input_not_forwarded')
              const speech = current.observed.speech,
                clears = current.observed.clears,
                user = current.observed.userTranscripts
              inject(clip, true)
              if (mode === 'live')
                await until(() => current.observed.userTranscripts > user, 20000, 'live_user_transcript_missing')
              else {
                await until(() => current.observed.speech > speech, 15000, 'speech_missing')
                await until(() => current.observed.clears > clears, 8000, 'clear_missing')
              }
            }
            return {
              startMs,
              firstAudibleMs,
              media: current.stats,
              observed: current.observed,
              cpu: cpu(before, snapshot()),
              memory: snapshot(),
            }
          },
        )
        report({ phase: 'provider', mode, bargeIn, ...result })
      } catch (error) {
        report({ phase: 'provider-failure', mode, bargeIn, code: safe(error.message) })
      }
    }
    if (runOptions.providerFresh) continue
    report({ phase: 'P12-start', mode })
    try {
      const result = await run(mode, { bargeIn: true }, async () => {
        const before = snapshot(),
          requested = Performance.now()
        if (mode === 'live') current.hostedSearch()
        else current.ask(question, true)
        await until(() => current.observed.search > 0, 45000, 'search_missing')
        await wait(1500)
        return {
          elapsedMs: Performance.now() - requested,
          observed: current.observed,
          media: current.stats,
          cpu: cpu(before, snapshot()),
          memory: snapshot(),
          counters: counters(),
        }
      })
      report({ phase: 'P12', mode, ...result })
    } catch (error) {
      report({ phase: 'P12-failure', mode, code: safe(error.message), observed: current?.observed })
    }
  }
  if (runOptions.providerLiveOnly) {
    synth(false)
    return
  }
  // Reuse the existing app lifecycle, checking actual start and stop each time.
  for (let cycle = 0; cycle < (runOptions.providerFresh ? 0 : (config.r14Cycles ?? 50)); cycle++) {
    const mode = cycle % 2 ? 'realtime' : 'live'
    const before = snapshot(),
      at = Performance.now()
    try {
      const media = await run(mode, { bargeIn: cycle % 4 >= 2 }, async () => {
        await until(() => current.stats.capturedSamples > 0, 5000, 'cycle_capture_missing')
        return current.stats
      })
      report({
        phase: 'cycle',
        cycle,
        mode,
        elapsedMs: Performance.now() - at,
        media,
        before,
        after: snapshot(),
        inactive: !session.active,
      })
    } catch (error) {
      report({ phase: 'cycle-failure', cycle, mode, code: safe(error.message) })
    }
  }
  // Bound each connection to ten minutes; count active sampled time only.
  let activeMs = 0
  let startupFailures = 0
  const target = (config.r14SoakSeconds ?? 3600) * 1000
  for (let part = 0; activeMs < target && part < Math.ceil(target / 600000) + 1; part++) {
    const mode = part % 2 ? 'realtime' : 'live'
    const window = Math.min(600000, target - activeMs)
    report({ phase: 'soak-start', part, mode, activeMs, window })
    try {
      await run(mode, { bargeIn: true, standby: 900 }, async () => {
        const began = Performance.now()
        current.greet(mode)
        let last = 0,
          previousCapture = 0
        while (last < window) {
          await wait(Math.min(20000, window - last))
          if (!session.active) throw new Error('soak_disconnected')
          const media = current.stats,
            elapsed = Performance.now() - began
          if (!(media.capturedSamples > previousCapture)) throw new Error('soak_capture_stalled')
          activeMs += elapsed - last
          last = elapsed
          previousCapture = media.capturedSamples
          report({ phase: 'soak', part, mode, activeMs, media, memory: snapshot() })
          if (last < window && Math.floor(last / 120000) > Math.floor((last - 20000) / 120000)) current.greet(mode)
        }
      })
    } catch (error) {
      report({ phase: 'soak-failure', part, mode, code: safe(error.message) })
      if (activeMs === 0 && ++startupFailures >= 2 && runOptions.providerFresh) break
    }
  }
  synth(false)
  report({ phase: 'soak-end', activeMs, target, reached: activeMs >= target })
}

export default async function remaining(robot, helpers, only = '') {
  const selected = only.split(',')
  const experiments = [
    ['P07', () => packetBatch(helpers)],
    ['P08', () => playbackPriming(robot, helpers)],
    ['P08-cancel', () => cancelPriming(robot, helpers)],
    ['P10', () => allocationReplay(robot, helpers)],
    ['P12-delay', () => delayedSearch(robot, helpers)],
    ['provider', () => providerTests(robot, helpers)],
  ]
  for (const [name, run] of experiments) {
    if (only && !selected.includes(name)) continue
    try {
      await run()
    } catch (error) {
      helpers.report({ phase: `${name}-failure`, code: safe(error.message) })
    }
  }
}
