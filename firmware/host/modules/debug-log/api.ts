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
  start(interruption?: boolean, stage?: number): Promise<boolean> | undefined
  stop(): Promise<unknown>
  warmup?(): Promise<void>
  isActive?(): boolean
}
let live: { owner: object; value: LiveControl; controlled: boolean; interruption?: boolean } | undefined
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
      const started = owner.value.start(stage < 4 ? (owner.interruption ?? false) : owner.interruption, stage)
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
    if (live) live.interruption = undefined
    return tuner?.value.reset() ?? Promise.resolve()
  },
  setInterruptionTrial(value: 'on' | 'off' | 'saved'): void {
    if (!recorder?.enabled || !live || live.value.isActive?.() !== false)
      throw Object.assign(new Error('LIVE must be stopped'), { code: 'live_active' })
    if (!['on', 'off', 'saved'].includes(value)) throw new RangeError('Invalid interruption trial')
    live.interruption = value === 'saved' ? undefined : value === 'on'
  },
  tuningSnapshot(): Fields {
    return {
      interruptionTrial: live?.interruption === undefined ? 'saved' : live.interruption ? 'on' : 'off',
      ...tuner?.value.snapshot(),
    }
  },
  event(component: string, event: string, fields?: Fields | (() => Fields)): void {
    try {
      recorder?.emit(component, event, fields)
    } catch {}
  },
  context(component: 'application' | 'network', state: string): void {
    context[component] = state
    if (recorder?.enabled) recorder.emit(component, 'state', { state })
  },
  snapshot(): Fields {
    return { ...context }
  },
}
