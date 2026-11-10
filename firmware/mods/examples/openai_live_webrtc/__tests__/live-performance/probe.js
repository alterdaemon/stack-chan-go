// Autonomous device test: saved settings are read, all overrides stay in RAM.

import Resource from 'Resource'
import Conversation from 'realtimeConversation/core'
import fetch from 'realtimeConversation/http'
import Transport from 'realtimeConversation/transport'
import Performance from 'io-performance'
import { onContextCreated as installLive } from 'openai-live-integrated'
import Timer from 'timer'

const wait = (ms) => new Promise((resolve) => Timer.set(resolve, ms))
let reportMaxMs = 0
const report = (event) => {
  const at = Performance.now()
  trace(`[live-probe] ${JSON.stringify({ ...event, reportMaxMs })}\n`)
  reportMaxMs = Math.max(reportMaxMs, Performance.now() - at)
}
const greeting = 'Speak now in English. Count slowly from one to fifteen, then remain silent and listen.'
const budgets = [
  [20, 21, 2000, 6000],
  [20, 21, 4000, 8000],
  [20, 21, 8000, 12000],
  [21, 22, 4000, 8000],
]
export function onContextCreated(robot) {
  report({ phase: 'boot' })
  let inputClip
  try {
    inputClip = new Resource('probe-input.pcm')
  } catch (error) {
    report({ phase: 'failed', code: error.name })
    return
  }
  native('xs_live_probe_measure')()
  const session = installLive(robot)
  class ProbeConversation extends Conversation {
    constructor(options) {
      const observed = { userTranscripts: 0 }
      super(
        {
          ...options,
          onTranscript(fragment) {
            if (fragment.role === 'user' && fragment.delta?.trim()) observed.userTranscripts++
            options.onTranscript(fragment)
          },
          input: [
            ...(options.input ?? []),
            { type: 'message', role: 'developer', content: [{ type: 'input_text', text: greeting }] },
          ],
        },
        {
          createTransport: (callback) => (this.transport = new Transport(callback)),
          fetch,
          setTimeout: (callback, ms) => Timer.set(callback, ms),
          clearTimeout: (timer) => Timer.clear(timer),
        },
      )
      this.observed = observed
      this.resumedFragments = options.input?.length ?? 0
    }
    greet() {
      this.transport.send(
        JSON.stringify({
          type: 'session.commentary.append',
          event_id: 'probe_greeting',
          delegation_id: null,
          content: greeting,
        }),
      )
    }
  }
  session.Conversation = ProbeConversation
  const onState = session.onState
  let lastState, heartbeat, connectedStats
  session.onState = (state, detail) => {
    if (state === 'closing') connectedStats = Performance.stats()
    lastState = state
    onState(state, detail)
    report({ state, detail, history: session.history.length })
  }
  void (async () => {
    let touching = false
    heartbeat = Timer.repeat((timer) => {
      Performance.mark(0)
      if (touching) Performance.touch?.(true)
      Timer.schedule(timer, 20, 20)
    }, 20)
    const results = []
    let selected = 0
    for (const mode of ['control', 'sweep', 'verify']) {
      const bargeIn = true
      session.settings = { ...session.settings, bargeIn, standbySeconds: mode === 'sweep' ? 30 : 12 }
      native('xs_live_probe_budget')(
        ...(mode === 'control' ? [6, 10, 2000, 6000] : budgets[mode === 'sweep' ? 0 : selected]),
      )
      Performance.reset()
      report({ phase: 'start', mode, bargeIn })
      const connected = await session.start()
      if (!connected) {
        report({ phase: 'connect_failed' })
        break
      }
      report({ phase: 'connected', bargeIn, ...Performance.stats() })
      Performance.reset()
      connectedStats = undefined
      native('xs_live_probe_tasks')()
      session.active.conversation.greet()
      const conversation = session.active.conversation
      const started = Performance.now()
      let profile = mode === 'sweep' ? 0 : selected,
        profileAt = started
      let last,
        injected = false,
        inputBefore = 0
      if (mode !== 'sweep') {
        inputBefore = conversation.observed.userTranscripts
        native('xs_live_probe_input')(inputClip)
        injected = true
      }
      const guardMs = mode === 'control' ? 25000 : mode === 'sweep' ? 35000 : 60000
      while (session.active && Performance.now() - started < guardMs) {
        await wait(1000)
        if (mode === 'control' && conversation.observed.userTranscripts > inputBefore) {
          await session.stop('standby')
          break
        }
        const profileElapsed = Performance.now() - profileAt
        const nextTouching = bargeIn && profileElapsed >= 1000 && profileElapsed < 3000
        if (nextTouching !== touching) {
          touching = nextTouching
          Performance.touch?.(touching)
          if (touching) robot.ui.openDrawer()
          else robot.ui.closeDrawer()
        }
        if (mode === 'sweep' && profileElapsed >= 4000) {
          const result = { profile, budget: budgets[profile], ...Performance.stats() }
          results.push(result)
          if (profile + 1 === budgets.length) {
            await session.stop('standby')
            break
          }
          profile++
          native('xs_live_probe_budget')(...budgets[profile])
          report({ phase: 'progress', profile })
          profileAt = Performance.now()
          Performance.reset()
        }
      }
      touching = false
      Performance.touch?.(false)
      robot.ui.closeDrawer()
      if (session.active) await session.stop()
      last = conversation.stats
      if (mode === 'sweep') for (const result of results) report({ phase: 'budget_end', ...result })
      report({
        phase: 'end',
        mode,
        state: lastState,
        bargeIn,
        history: session.history.length,
        injected,
        inputReceived: injected && conversation.observed.userTranscripts > inputBefore,
        resumedFragments: conversation.resumedFragments,
        profile,
        budget: mode === 'control' ? [6, 10, 2000, 6000] : budgets[profile],
        ...(connectedStats ?? Performance.stats()),
        media: last,
      })
      if (mode === 'control' && conversation.observed.userTranscripts <= inputBefore)
        throw new Error('input control failed')
      if (mode === 'sweep') {
        const candidates = results.filter((result) => result.writeMaxUs < 25000)
        if (!candidates.length) throw new Error('no viable audio budget')
        selected = candidates.reduce((best, result) => (result.uiMaxUs < best.uiMaxUs ? result : best)).profile
        report({ phase: 'selected', profile: selected, budget: budgets[selected] })
      }
      await wait(3000)
    }
    Timer.clear(heartbeat)
    report({ phase: 'done' })
  })().catch(async (error) => {
    if (heartbeat !== undefined) Timer.clear(heartbeat)
    Performance.touch?.(false)
    await session.stop()
    report({ phase: 'failed', code: error.code ?? error.name })
  })
}
