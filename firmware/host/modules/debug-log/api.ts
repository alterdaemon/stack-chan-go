// Copyright (c) 2026 Stack-chan Community contributors
// SPDX-License-Identifier: Apache-2.0

type Fields = Record<string, unknown>
type Recorder = {
  readonly enabled: boolean
  emit(component: string, event: string, fields?: Fields | (() => Fields)): void
}
let recorder: Recorder | undefined
type Tuner = { set(name: string, value: number | string): Promise<void>; reset(): Promise<void>; snapshot(): Fields }
let tuner: { owner: object; value: Tuner } | undefined
type LiveControl = {
  start(interruption?: boolean, stage?: number, voice?: string, parameters?: Fields): Promise<boolean> | undefined
  stop(): Promise<unknown>
  warmup?(): Promise<void>
  isActive?(): boolean
  stats?(): Fields | undefined
}
let live:
  | {
      owner: object
      value: LiveControl
      controlled: boolean
      interruption?: boolean
      voice?: string
      parameters?: Fields
    }
  | undefined
// Codex V3 builtin candidates; USB trials are separate from qualified Settings voices.
// openai/codex 69231e11, codex-rs/protocol/src/protocol.rs, RealtimeVoicesList::builtin.
const voiceTrials =
  'juniper maple spruce ember vale breeze arbor sol cove marin aube bubbie haetsal hanul himari leher miko neer porto rindo rio rivage selva sonna tinta viola'.split(
    ' ',
  )
const context = { application: 'initialization', network: 'unknown' }
export default {
  get enabled(): boolean {
    return recorder?.enabled === true
  },
  install(value: Recorder): void {
    recorder = value
  },
  registerTuner(owner: object, value: Tuner): void {
    tuner = { owner, value }
  },
  unregisterTuner(owner: object): void {
    if (tuner?.owner === owner) tuner = undefined
  },
  registerLive(owner: object, value: LiveControl): void {
    live = { owner, value, controlled: false }
  },
  unregisterLive(owner: object): void {
    if (live?.owner === owner) live = undefined
  },
  releaseLive(owner: object): void {
    if (live?.owner === owner) live.controlled = false
  },
  async controlLive(action: 'start' | 'standard' | 'voice' | 'prompt' | 'pitch' | 'stop' | 'warmup'): Promise<void> {
    if (!recorder?.enabled || !live)
      throw Object.assign(new Error('LIVE control unavailable'), { code: 'live_unavailable' })
    const owner = live
    if (action === 'stop') {
      const stopped = owner.value.stop()
      owner.controlled = false
      await stopped
    } else if (['start', 'standard', 'voice', 'prompt', 'pitch'].includes(action)) {
      const stage = ['standard', 'voice', 'prompt', 'pitch', 'start'].indexOf(action)
      const started = owner.value.start(
        stage < 4 ? (owner.interruption ?? false) : owner.interruption,
        stage,
        owner.voice,
        owner.parameters,
      )
      if (!started) throw Object.assign(new Error('LIVE is active'), { code: 'live_active' })
      owner.controlled = true
      if (!(await started)) {
        owner.controlled = false
        throw Object.assign(new Error('LIVE did not connect'), { code: 'live_start_failed' })
      }
    } else if (action === 'warmup' && owner.value.warmup) await owner.value.warmup()
    else throw Object.assign(new Error('Invalid LIVE action'), { code: 'invalid_parameter' })
  },
  async stopControlledLive(): Promise<void> {
    if (!live?.controlled) return
    const owner = live
    owner.controlled = false
    await owner.value.stop()
  },
  tune(name: string, value: number | string): Promise<void> {
    if (!recorder?.enabled || !tuner)
      return Promise.reject(Object.assign(new Error('No connected Realtime tuner'), { code: 'not_connected' }))
    return tuner.value.set(name, value)
  },
  resetTuning(): Promise<void> {
    if (live) {
      live.interruption = undefined
      live.voice = undefined
      live.parameters = undefined
    }
    return tuner?.value.reset() ?? Promise.resolve()
  },
  setInterruptionTrial(value: 'on' | 'off' | 'saved'): void {
    if (!recorder?.enabled || !live || live.value.isActive?.() !== false)
      throw Object.assign(new Error('LIVE must be stopped'), { code: 'live_active' })
    if (!['on', 'off', 'saved'].includes(value)) throw new RangeError('Invalid interruption trial')
    live.interruption = value === 'saved' ? undefined : value === 'on'
  },
  setVoiceTrial(value: string): void {
    if (!recorder?.enabled || !live || live.value.isActive?.() !== false)
      throw Object.assign(new Error('LIVE must be stopped'), { code: 'live_active' })
    if (value !== 'saved' && !voiceTrials.includes(value)) throw new RangeError('Invalid voice trial')
    live.voice = value === 'saved' ? undefined : value
  },
  setLiveTrial(name: string, value: number | string): void {
    if (!recorder?.enabled || !live || live.value.isActive?.() !== false)
      throw Object.assign(new Error('LIVE must be stopped'), { code: 'live_active' })
    const valid =
      (name === 'pitch' && Number.isInteger(value) && Number(value) >= -6 && Number(value) <= 6) ||
      (name === 'volume' && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) ||
      (name === 'standby' && Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 3600) ||
      (name === 'style' && ['default', 'calm', 'expressive'].includes(String(value))) ||
      (name === 'prompt' && ['standard', 'long'].includes(String(value))) ||
      (name === 'model' && ['gpt-6.1-terra', 'gpt-6-luna'].includes(String(value))) ||
      (name === 'effort' && ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(value)))
    if (
      !['pitch', 'volume', 'standby', 'style', 'prompt', 'model', 'effort'].includes(name) ||
      (value !== 'saved' && !valid)
    )
      throw new RangeError('Invalid LIVE trial')
    live.parameters ??= {}
    if (value === 'saved') delete live.parameters[name]
    else live.parameters[name] = value
  },
  tuningSnapshot(): Fields {
    return {
      interruptionTrial: live?.interruption === undefined ? 'saved' : live.interruption ? 'on' : 'off',
      voiceTrial: live?.voice ?? 'saved',
      trialPitch: live?.parameters?.pitch ?? 'saved',
      trialVolume: live?.parameters?.volume ?? 'saved',
      trialStandby: live?.parameters?.standby ?? 'saved',
      trialStyle: live?.parameters?.style ?? 'saved',
      trialPrompt: live?.parameters?.prompt ?? 'saved',
      trialModel: live?.parameters?.model ?? 'saved',
      trialEffort: live?.parameters?.effort ?? 'saved',
      ...tuner?.value.snapshot(),
    }
  },
  event(component: string, event: string, fields?: Fields | (() => Fields)): void {
    try {
      if (!recorder?.enabled) return
      if (component === 'audio' && event === 'snapshot') {
        const stats = typeof fields === 'function' ? fields() : fields
        if (!stats) return
        let part: Fields = {},
          count = 0
        // Native snapshots contain many counters. Keep the existing USB line
        // and queue bounds instead of silently losing one oversized record.
        for (const key of Object.keys(stats)) {
          if (typeof stats[key] !== 'number') continue
          part[key] = stats[key]
          if (++count === 10) {
            recorder.emit(component, event, part)
            part = {}
            count = 0
          }
        }
        if (count) recorder.emit(component, event, part)
        return
      }
      recorder?.emit(component, event, fields)
    } catch {}
  },
  sampleLive(): void {
    if (recorder?.enabled) this.event('audio', 'snapshot', () => live?.value.stats?.() ?? {})
  },
  context(component: 'application' | 'network', state: string): void {
    context[component] = state
    if (recorder?.enabled) recorder.emit(component, 'state', { state })
  },
  snapshot(): Fields {
    return { ...context }
  },
}
