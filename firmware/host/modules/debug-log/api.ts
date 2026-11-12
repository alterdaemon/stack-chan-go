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
  tune(name: string, value: number | string): Promise<void> {
    if (!recorder?.enabled || !tuner)
      return Promise.reject(Object.assign(new Error('No connected Realtime tuner'), { code: 'not_connected' }))
    return tuner.value.set(name, value)
  },
  resetTuning(): Promise<void> {
    return tuner?.value.reset() ?? Promise.resolve()
  },
  tuningSnapshot(): Fields {
    return tuner?.value.snapshot() ?? {}
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
