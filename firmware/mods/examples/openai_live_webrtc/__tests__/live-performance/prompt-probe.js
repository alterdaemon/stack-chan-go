// Device/API test. Never writes preferences or prints credentials/instructions.
import Conversation from 'realtimeConversation/core'
import Resource from 'Resource'
import Performance from 'io-performance'
import fetch from 'realtimeConversation/http'
import Transport from 'realtimeConversation/transport'
import { onContextCreated as installLive } from 'openai-live-integrated'
import Timer from 'timer'
import config from 'mc/config'

const wait = (ms) => new Promise((resolve) => Timer.set(resolve, ms))
const report = (value) => trace(`[prompt-probe] ${JSON.stringify(value)}\n`)
const marker = 'Miedziany pingwin testuje prompt'
const markerMatches = (text) =>
  text
    .trim()
    .replace(/[.!?]+$/, '')
    .toLowerCase() === marker.toLowerCase()

export function onContextCreated(robot) {
  report({ phase: 'boot' })
  native('xs_live_probe_synthetic_mic')(true)
  const clip = new Resource('probe-input.pcm')
  const session = installLive(robot)
  let current
  class ProbeConversation extends Conversation {
    constructor(options) {
      const observed = { text: '', done: 0, updates: 0 }
      super(
        {
          ...options,
          onError(error) {
            const message = error.message ?? ''
            report({
              phase: 'diagnostic',
              code: error.code,
              message:
                /^[a-z0-9_ .():-]{1,120}$/i.test(message) &&
                !message.includes(options.apiKey) &&
                !/sk[-_]/i.test(message)
                  ? message
                  : 'redacted',
            })
            options.onError?.(error)
          },
          onEvent(event) {
            if (event.type === 'session.created' || event.type === 'session.updated') {
              observed.updates++
              observed.match = event.session?.instructions === options.instructions
              report({
                phase: 'configuration',
                event: event.type,
                expectedLength: options.instructions?.length,
                receivedLength: event.session?.instructions?.length,
                match: observed.match,
                model: event.session?.model,
              })
            }
            if (event.type === 'response.done') {
              observed.done++
              observed.status = event.response?.status
              observed.phases = (event.response?.output ?? []).map((item) => item.phase ?? null).slice(0, 4)
            }
            if (event.type === 'response.output_item.done') observed.lastItemPhase = event.item?.phase ?? null
            if (event.type === 'input_audio_buffer.speech_started') observed.speech = (observed.speech ?? 0) + 1
            options.onEvent?.(event)
          },
          onToolResult(result) {
            const output = typeof result.output === 'string' ? JSON.parse(result.output) : {}
            observed.tools = (observed.tools ?? 0) + 1
            observed.sources = output.sources?.length ?? 0
            observed.toolError = result.error ?? output.error
            observed.searchDoneBefore = observed.done
            options.onToolResult?.(result)
          },
          onTranscript(fragment) {
            if (fragment.role === 'assistant') {
              observed.text = (observed.text + fragment.delta).slice(-1024)
              observed.lastTranscript = Performance.now()
            } else if (fragment.delta?.trim()) observed.speech = (observed.speech ?? 0) + 1
            options.onTranscript?.(fragment)
          },
        },
        {
          createTransport: (callback) => (this.transport = new Transport(callback)),
          fetch(url, init) {
            const request = fetch(url, init)
            if (!url.endsWith('/live/sessions')) return request
            const checked = request.then(async (response) => {
              const text = await response.text()
              if (response.ok) {
                const session = JSON.parse(text).session
                observed.requestMatches = JSON.parse(init.body).session.instructions === options.instructions
                observed.match =
                  typeof session?.instructions === 'string' ? session.instructions === options.instructions : null
                report({
                  phase: 'configuration',
                  event: 'http_session',
                  expectedLength: options.instructions?.length,
                  receivedLength: session?.instructions?.length,
                  match: observed.match,
                  requestMatches: observed.requestMatches,
                  model: session?.model,
                })
              }
              return { ...response, text: async () => text }
            })
            checked.cancel = () => request.cancel?.()
            return checked
          },
          setTimeout: (fn, ms) => Timer.set(fn, ms),
          clearTimeout: (timer) => Timer.clear(timer),
        },
      )
      this.observed = observed
      this.instructions = options.instructions
      current = this
    }
    say(text) {
      this.observed.text = ''
      this.transport.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
        }),
      )
      this.transport.send(JSON.stringify({ type: 'response.create' }))
    }
    applyInstructions() {
      this.transport.send(
        JSON.stringify({ type: 'session.update', session: { type: 'realtime', instructions: this.instructions } }),
      )
    }
  }
  session.Conversation = ProbeConversation
  const until = async (predicate, milliseconds, code) => {
    const started = Performance.now()
    while (!predicate()) {
      if (!session.active || Performance.now() - started >= milliseconds) throw new Error(code)
      await wait(100)
    }
  }
  void (async () => {
    const saved = session.settings
    const cases = config.openaiPromptProbeSearchOnly
      ? [['realtime', 'saved_search']]
      : [
          ['live', 'saved'],
          ['realtime', 'saved_a'],
          ['realtime', 'saved_b'],
          ['realtime', 'marker'],
        ]
    for (const [mode, variant] of cases) {
      session.settings = {
        ...saved,
        mode,
        bargeIn: false,
        model: mode === 'realtime' ? 'gpt-realtime-2.1-mini' : 'gpt-live-1',
        ...(variant === 'marker'
          ? { instructions: `For every reply, say exactly: ${marker}. Do not say any other words.` }
          : {}),
      }
      session.history = []
      report({ phase: 'starting', mode, variant, bargeIn: false, savedPromptLength: saved.instructions?.length })
      if (!(await session.start())) throw new Error('startup')
      const observed = current.observed
      // Exercise the microphone path before any assistant reply can seed its style.
      await wait(4000)
      await until(() => current.stats.outputIdleMs >= 500, 20000, 'audio_not_idle')
      if (variant === 'saved_search') {
        current.say('Wyszukaj w internecie aktualną pogodę w Warszawie i podaj źródło.')
        await until(() => observed.tools > 0, 60000, 'search_result_missing')
        if (observed.toolError || !observed.sources) throw new Error('search_result_failed')
        await until(
          () => observed.done > observed.searchDoneBefore && observed.text.trim(),
          20000,
          'search_reply_missing',
        )
        await until(
          () => current.stats.outputIdleMs >= 500 && current.stats.audibleMs > 0,
          30000,
          'search_audio_missing',
        )
        report({ phase: 'search', mode, variant, ...observed, media: current.stats })
        await session.stop()
        await wait(1000)
        continue
      }
      const before = observed.done
      const speechBefore = observed.speech ?? 0
      native('xs_live_probe_input')(clip, true)
      await wait(3000)
      report({ phase: 'injected', mode, variant, media: current.stats, capture: Performance.stats() })
      if (mode === 'realtime') {
        await until(() => (observed.speech ?? 0) > speechBefore, 20000, 'speech_missing')
        await until(() => observed.done > before, 20000, 'voice_response_timeout')
      } else {
        await until(
          () =>
            observed.text.trim() &&
            current.stats.outputIdleMs >= 1000 &&
            Performance.now() - observed.lastTranscript >= 2000,
          30000,
          'voice_response_timeout',
        )
        observed.status = 'audio_received'
      }
      report({ phase: 'audio_input', mode, variant, ...observed, markerFollowed: markerMatches(observed.text) })
      await wait(1500)
      if (mode === 'live') {
        await session.stop()
        await wait(1000)
        continue
      }
      const ask = async (phase, question = 'Hello, how are you today?') => {
        const before = observed.done
        current.say(question)
        await until(() => observed.done > before, 20000, 'response_timeout')
        report({ phase, mode, variant, ...observed, markerFollowed: markerMatches(observed.text) })
        await wait(1500)
      }
      await ask('initial')
      if (variant.startsWith('saved_')) await ask('arithmetic', 'Czy dwa plus dwa daje pięć?')
      if (variant === 'marker') {
        const before = observed.updates
        current.applyInstructions()
        await until(() => observed.updates > before, 10000, 'update_timeout')
        await ask('explicit_update')
      }
      await session.stop()
      await wait(1000)
    }
    report({ phase: 'done' })
  })().catch(async (error) => {
    report({
      phase: 'failed',
      code: /^[a-z_]+$/.test(error.message) ? error.message : 'probe_error',
      observed: current?.observed,
      media: current?.stats,
      capture: Performance.stats(),
    })
    await session.stop()
  })
}
