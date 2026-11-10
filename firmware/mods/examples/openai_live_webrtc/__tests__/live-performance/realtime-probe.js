// Device-only Realtime Mini validation. Overrides and measurements stay in RAM.
import Resource from 'Resource'
import Conversation from 'realtimeConversation/core'
import fetch from 'realtimeConversation/http'
import Transport from 'realtimeConversation/transport'
import Performance from 'io-performance'
import { onContextCreated as installLive } from 'openai-live-integrated'
import Timer from 'timer'

const wait = (ms) => new Promise((resolve) => Timer.set(resolve, ms))
const report = (value) => trace(`[realtime-probe] ${JSON.stringify(value)}\n`)
export function onContextCreated(robot) {
  report({ phase: 'boot' })
  const clip = new Resource('probe-input.pcm')
  native('xs_live_probe_synthetic_mic')(true)
  const session = installLive(robot)
  let current, heartbeat
  class ProbeConversation extends Conversation {
    requestSerial = 0
    constructor(options) {
      const observed = { speech: 0, stopped: 0, transcripts: 0, calls: 0, results: 0, searches: 0, cancelled: 0 }
      super(
        {
          ...options,
          onEvent(event) {
            if (event.type === 'session.created' || event.type === 'session.updated') {
              observed.model = event.session?.model
              observed.vad = event.session?.audio?.input?.turn_detection
              observed.tools = event.session?.tools?.length
            }
            if (event.type === 'response.created') {
              observed.responding = true
              observed.responses = (observed.responses ?? 0) + 1
              observed.request = event.response?.metadata?.probe
              observed.responseId = event.response?.id
            }
            if (event.type === 'response.done') {
              observed.responding = false
              observed.responseStatus = event.response?.status
            }
            if (event.type === 'error') observed.errorCode = event.error?.code
            if (event.type === 'output_audio_buffer.started') {
              observed.playing = true
              observed.playingId = event.response_id
            }
            if (event.type === 'output_audio_buffer.cleared') {
              observed.playing = false
              observed.cleared = (observed.cleared ?? 0) + 1
            }
            if (event.type === 'conversation.item.added' && event.item?.role === 'user')
              observed.userItems = (observed.userItems ?? 0) + 1
            if (event.type === 'input_audio_buffer.speech_started') {
              observed.speech++
              observed.inputSpeaking = true
            }
            if (event.type === 'input_audio_buffer.speech_stopped') observed.inputSpeaking = false
            if (event.type === 'output_audio_buffer.stopped') {
              observed.stopped++
              observed.playing = false
            }
            if (event.type === 'response.function_call_arguments.done') observed.calls++
            options.onEvent?.(event)
          },
          onTranscript(fragment) {
            observed.transcripts++
            options.onTranscript?.(fragment)
          },
          onToolResult(result) {
            if (result.name === 'search_web') {
              const output = result.output ? JSON.parse(result.output) : {}
              if (output.answer && output.sources?.length) observed.results++
              else observed.resultError = output.error ?? result.error ?? 'missing_sources'
            }
          },
        },
        {
          createTransport: (callback) => (this.transport = new Transport(callback)),
          fetch(url, init) {
            const request = fetch(url, init)
            if (!url.endsWith('/responses')) return request
            observed.searches++
            // Hold delivery for 5 s while real TLS, capture, encoding and UI run.
            // Cancel both the hold timer and the worker request on STOP.
            let timer, release
            const hold = new Promise((resolve) => {
              release = resolve
              timer = Timer.set(resolve, 5000)
            })
            const checked = request.then(
              (response) => {
                observed.searchStatus = response.status
                return response
              },
              (error) => {
                observed.httpsFailure = error.message?.includes('timed out') ? 'timeout' : 'request_failed'
                throw error
              },
            )
            const delayed = Promise.all([checked, hold]).then(([response]) => response)
            delayed.cancel = () => {
              observed.cancelled++
              Timer.clear(timer)
              release()
              request.cancel?.()
            }
            return delayed
          },
          setTimeout: (fn, ms) => Timer.set(fn, ms),
          clearTimeout: (timer) => Timer.clear(timer),
        },
      )
      this.observed = observed
      current = this
    }
    say(text, search = false) {
      const request = String(++this.requestSerial)
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
          response: { metadata: { probe: request }, ...(search ? { tool_choice: 'required' } : {}) },
        }),
      )
      return request
    }
  }
  session.Conversation = ProbeConversation
  const until = async (predicate, milliseconds, code) => {
    const at = Performance.now()
    while (!predicate()) {
      if (!session.active || Performance.now() - at > milliseconds) throw new Error(code)
      await wait(100)
    }
  }
  void (async () => {
    heartbeat = Timer.repeat((timer) => {
      Performance.mark(0)
      Timer.schedule(timer, 20, 20)
    }, 20)
    for (const bargeIn of [true, false]) {
      session.settings = {
        ...session.settings,
        mode: 'realtime',
        model: 'gpt-realtime-2.1-mini',
        voice: 'marin',
        instructions:
          'You are a voice test assistant. Follow the user instructions. Keep replies to one short sentence, except when asked to count. Use search_web only when explicitly asked.',
        bargeIn,
        standbySeconds: 1,
      }
      if (!(await session.start())) throw new Error('startup')
      report({ phase: 'connected', bargeIn })
      Performance.reset()
      await wait(4000)
      if (!session.active) throw new Error('silence_disconnected')
      const observed = current.observed
      const before = { ...current.stats }
      current.say('Briefly say ready in English, then listen.')
      await until(() => observed.stopped > 0, 15000, 'initial_audio_missing')
      await wait(1000)
      const outputsBefore = observed.stopped
      native('xs_live_probe_input')(clip, true)
      await until(() => observed.speech > 0, 12000, 'vad_missing')
      await until(() => observed.stopped > outputsBefore, 20000, 'audio_missing')
      await until(
        () => !observed.responding && !observed.inputSpeaking && !observed.playing,
        15000,
        'vad_response_pending',
      )
      await wait(1000)
      report({ phase: 'vad', bargeIn, observed })
      if (bargeIn) {
        const speechBefore = observed.speech
        const clearsBefore = observed.cleared ?? 0
        const audibleBefore = current.stats.audibleMs
        const bargeRequest = current.say('Count slowly from one to thirty. Keep counting until you are interrupted.')
        await until(
          () =>
            observed.request === bargeRequest &&
            observed.playingId === observed.responseId &&
            observed.playing &&
            current.stats.audibleMs > audibleBefore + 500,
          15000,
          'barge_audio_missing',
        )
        const responseBefore = observed.responses
        native('xs_live_probe_input')(clip, true)
        await until(() => observed.speech > speechBefore, 12000, 'barge_vad_missing')
        await until(() => (observed.cleared ?? 0) > clearsBefore, 10000, 'barge_clear_missing')
        const clearAt = Performance.now()
        await until(() => current.stats.outputIdleMs >= 50, 2000, 'barge_local_audio_pending')
        observed.localStopMs = Performance.now() - clearAt
        await until(
          () => observed.responses > responseBefore && !observed.responding && !observed.playing,
          30000,
          'barge_response_pending',
        )
        await wait(1000)
        report({ phase: 'interrupted', observed, media: current.stats })
      }
      const stopsBeforeSearch = observed.stopped
      current.say(
        'Use search_web now to find the official OpenAI Realtime documentation URL. Then briefly say what you found.',
        true,
      )
      report({ phase: 'search_sent', bargeIn, observed, media: current.stats })
      await until(() => observed.searches > 0, 15000, 'search_missing')
      const during = { ...current.stats }
      const progress = Performance.stats()
      await wait(2000)
      const afterDelay = current.stats
      observed.delayOverruns = afterDelay.overruns - during.overruns
      if (observed.delayOverruns) throw new Error('capture_lost_during_search')
      if (
        afterDelay.capturedSamples <= during.capturedSamples ||
        Performance.stats().ioWrites <= progress.ioWrites ||
        Performance.stats().uiTicks <= progress.uiTicks
      )
        throw new Error('progress_stalled')
      await until(() => observed.results > 0, 55000, 'search_result_missing')
      await until(() => observed.stopped > stopsBeforeSearch, 20000, 'search_audio_missing')
      const media = current.stats
      const metrics = Performance.stats()
      await session.stop()
      report({ phase: 'end', bargeIn, observed, before, media, metrics })
      if (session.active) throw new Error('cleanup')
    }
    session.settings = { ...session.settings, mode: 'realtime' }
    if (!(await session.start())) throw new Error('restart')
    current.say('Call search_web to find the current OpenAI API documentation URL.', true)
    await until(() => current.observed.searches > 0, 15000, 'cancel_search_missing')
    const old = current
    await session.stop()
    await wait(1000)
    if (!old.observed.cancelled || old.observed.results) throw new Error('cancel_failed')
    report({ phase: 'cancelled', observed: old.observed })
    Timer.clear(heartbeat)
    report({ phase: 'done' })
  })().catch(async (error) => {
    if (heartbeat !== undefined) Timer.clear(heartbeat)
    report({ phase: 'before_failed_stop', media: current?.stats, metrics: Performance.stats() })
    await session.stop()
    report({
      phase: 'failed',
      code: error.code ?? (/^[a-z_]+$/.test(error.message) ? error.message : error.name),
      observed: current?.observed,
      media: current?.stats,
      metrics: Performance.stats(),
    })
  })
}
