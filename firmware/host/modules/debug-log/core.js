// Copyright (c) 2026 Stack-chan Community contributors
// SPDX-License-Identifier: Apache-2.0

export const PREFIX = '@diag '
export const LEASE_MS = 30000
const DISCONNECT_MS = 500
const MAX_QUEUED_CHARS = 4096
const MAX_LINE_CHARS = 768
const NUMBER_FIELDS = new Set([
  'status',
  'code',
  'attempt',
  'maxAttempts',
  'pitch',
  'threshold',
  'strength',
  'request',
  'result',
  'value',
  'audio_start_ms',
  'audio_end_ms',
  'start_ms',
  'end_ms',
  'capturedSamples',
  'renderedSamples',
  'underruns',
  'overruns',
  'micLevel',
  'cleanLevel',
  'referenceLevel',
  'playbackLevel',
  'interruptions',
  'flushedInterruptions',
  'freeHeap',
  'freeInternalHeap',
  'minimumHeap',
  'resetReason',
  'nativeDropped',
  'speaker',
  'captureDb',
  'nlp',
  'silence',
])
const STRING_FIELDS = new Set([
  'state',
  'phase',
  'mode',
  'model',
  'reason',
  'providerCode',
  'stage',
  'kind',
  'type',
  'event_id',
  'response_id',
  'item_id',
  'call_id',
  'connection_id',
  'parameter',
  'setting',
  'activeResponse',
  'playbackResponse',
  'client_event_id',
  'delegation_id',
  'tool',
  'responseStatus',
  'detailType',
  'errorCode',
  'action',
  'firmware',
  'app_sha256',
  'sdk',
  'network',
  'application',
  'vad',
  'noiseReduction',
  'previous_item_id',
  'itemRole',
  'itemType',
])
const BOOL_FIELDS = new Set(['bargeIn', 'muted', 'interrupted', 'accepted', 'pending', 'finalized'])
const identifier = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,96}$/.test(value) && !/sk[-_]|bearer|password|secret/i.test(value)

export function safeFields(fields) {
  const result = {}
  if (!fields || typeof fields !== 'object') return result
  for (const key of Object.keys(fields)) {
    const value = fields[key]
    if (NUMBER_FIELDS.has(key) && Number.isFinite(value)) result[key] = value
    else if (BOOL_FIELDS.has(key) && typeof value === 'boolean') result[key] = value
    else if (STRING_FIELDS.has(key) && identifier(value)) result[key] = value
  }
  return result
}

export class CommandParser {
  #line = ''
  #invalid = false
  constructor(receive) {
    this.receive = receive
  }
  feed(bytes) {
    for (const byte of bytes) {
      if (byte === 10) {
        this.receive(this.#invalid ? undefined : this.#line.replace(/\r$/, ''))
        this.#line = ''
        this.#invalid = false
      } else if (!this.#invalid) {
        if (this.#line.length >= 128 || (byte < 32 && byte !== 13) || byte > 126) {
          this.#invalid = true
          this.#line = ''
        } else this.#line += String.fromCharCode(byte)
      }
    }
  }
}

export class DebugRecorder {
  #enabled = false
  #deadline = 0
  #disconnectedSince
  #disableReason
  #queue = []
  #characters = 0
  #dropped = 0
  #capture = 0
  #trialPending = false
  constructor(platform) {
    this.platform = platform
    this.parser = new CommandParser((line) => this.command(line))
  }
  get enabled() {
    return this.#enabled
  }
  get dropped() {
    return this.#dropped
  }
  get queuedCharacters() {
    return this.#characters
  }
  command(line) {
    if (line === 'diag on') {
      const changed = !this.#enabled
      if (changed) {
        this.#capture++
        this.#dropped = 0
        this.#clear()
        this.#enabled = true
        this.#disableReason = undefined
        this.#disconnectedSince = undefined
      }
      this.#deadline = this.platform.now() + LEASE_MS
      if (changed) this.platform.change(true)
      this.#control('on')
      if (changed) this.platform.snapshot()
    } else if (line === 'diag off') {
      this.disable('requested')
      this.#control('off')
    } else if (line === 'diag keepalive') {
      if (this.#enabled) this.#deadline = this.platform.now() + LEASE_MS
      this.#control(this.#enabled ? 'alive' : 'off')
    } else if (line === 'diag status') this.#control('status')
    else if (line === 'diag reset' || line?.startsWith('diag set ')) {
      if (!this.#enabled) {
        this.#control('enable_required')
        return
      }
      const parts = line.split(' ')
      const parameter = line === 'diag reset' ? 'reset' : parts[2]
      const raw = parts[3]
      const value = parameter === 'noise' ? raw : Number(raw)
      const valid =
        parameter === 'reset' ||
        (parts.length === 4 &&
          raw !== '' &&
          ((parameter === 'vad' && Number.isFinite(value) && value >= 0.1 && value <= 0.95) ||
            (parameter === 'silence' && Number.isInteger(value) && value >= 200 && value <= 2000) ||
            (parameter === 'noise' && ['far_field', 'near_field', 'off'].includes(value)) ||
            (parameter === 'speaker' && Number.isFinite(value) && value >= 0 && value <= 1) ||
            (parameter === 'capture' && Number.isFinite(value) && value >= -27 && value <= 0) ||
            (parameter === 'nlp' && [0, 1, 2].includes(value))))
      if (!valid || !this.platform.tune) {
        this.#control('invalid_command')
        return
      }
      if (this.#trialPending) {
        this.#control('command_pending')
        return
      }
      this.#trialPending = true
      const capture = this.#capture
      const fields = { parameter, ...(typeof value === 'number' ? { value } : { setting: value }) }
      this.#control('set', { ...fields, phase: 'pending' })
      Promise.resolve()
        .then(() => {
          if (!this.#enabled || this.#capture !== capture)
            throw Object.assign(new Error('Diagnostic session ended'), { code: 'cancelled' })
          return this.platform.tune(parameter, value)
        })
        .then(
          () => {
            if (this.#enabled && this.#capture === capture) this.#control('set', { ...fields, phase: 'applied' })
          },
          (error) => {
            if (this.#enabled && this.#capture === capture)
              this.#control('set', { ...fields, phase: 'failed', errorCode: error?.code ?? 'tune_failed' })
          },
        )
        .finally(() => {
          this.#trialPending = false
        })
    } else this.#control('invalid_command')
  }
  tick(connected = true) {
    const now = this.platform.now()
    if (connected) this.#disconnectedSince = undefined
    else this.#disconnectedSince ??= now
    if (this.#enabled) {
      if (now >= this.#deadline) this.disable('lease_expired')
      else if (this.#disconnectedSince !== undefined && now - this.#disconnectedSince >= DISCONNECT_MS)
        this.disable('usb_disconnected')
    }
    this.pump()
  }
  disable(reason = 'requested') {
    const wasEnabled = this.#enabled
    this.#enabled = false
    if (wasEnabled) this.#disableReason = reason
    this.#clear()
    if (wasEnabled) this.platform.change(false)
  }
  emit(component, event, fields, stamp) {
    if (!this.#enabled || !identifier(component) || !identifier(event)) return
    this.#enqueue({
      ...(stamp ?? this.platform.stamp()),
      capture: this.#capture,
      component,
      event,
      dropped: this.#dropped,
      ...safeFields(typeof fields === 'function' ? fields() : fields),
    })
  }
  pump() {
    for (let i = 0; i < 8 && this.#queue.length; i++) {
      const line = this.#queue[0]
      if (!this.platform.write(line)) break
      this.#queue.shift()
      this.#characters -= line.length
    }
  }
  #control(action, fields) {
    this.#enqueue(
      {
        ...this.platform.stamp(),
        capture: this.#capture,
        component: 'debug',
        event: 'control',
        action,
        enabled: this.#enabled,
        dropped: this.#dropped,
        ...(this.#disableReason ? { reason: this.#disableReason } : {}),
        ...safeFields(fields ?? this.platform.info()),
      },
      true,
    )
  }
  #enqueue(record, control = false) {
    const line = PREFIX + JSON.stringify(record) + '\n'
    if (line.length > MAX_LINE_CHARS) {
      this.#dropped++
      return
    }
    while (control && this.#queue.length && this.#characters + line.length > MAX_QUEUED_CHARS) {
      this.#characters -= this.#queue.shift().length
      this.#dropped++
    }
    if (this.#characters + line.length > MAX_QUEUED_CHARS) {
      this.#dropped++
      return
    }
    this.#queue.push(line)
    this.#characters += line.length
    this.pump()
  }
  #clear() {
    this.#queue.length = 0
    this.#characters = 0
  }
}
