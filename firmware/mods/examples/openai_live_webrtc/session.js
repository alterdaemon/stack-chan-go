// Conversation owns the protocol, native media and HTTP worker. This adapter
// only coordinates host ownership, standby and a small RAM transcript tail.
const HISTORY_CHARS = 2048
const HISTORY_MESSAGES = 6
function identifier(value, fallback) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(value) && !/^sk_/i.test(value) ? value : fallback
}

export function diagnostic(error, stage, site) {
  const localCodes = {
    'read only value (in stringify)': 'readonly_json',
    'apiKey or signaling is required': 'missing_auth',
    'Choose apiKey or signaling': 'auth_conflict',
    'invalid model': 'invalid_model',
    'invalid voice': 'invalid_voice',
    'invalid instructions': 'invalid_instructions',
    'network unavailable': 'network_unavailable',
    'volume must be between 0 and 1': 'invalid_volume',
  }
  const result = {
    code: identifier(
      error?.code,
      Object.hasOwn(localCodes, error?.message) ? localCodes[error.message] : 'operation_failed',
    ),
    stage: identifier(error?.stage, stage),
    site: identifier(error?.site, site),
  }
  if (['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError'].includes(error?.name))
    result.kind = error.name
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) result.status = error.status
  const providerCode = identifier(error?.providerCode)
  if (providerCode) result.providerCode = providerCode
  if (
    typeof error?.param === 'string' &&
    /^(?:session|delegation|model|audio|tools|reasoning)(?:[.[\]a-z0-9_]){0,96}$/i.test(error.param)
  )
    result.param = error.param
  return result
}

export function formatLiveError(detail, mode = 'live') {
  if (!detail) detail = { stage: 'unknown', code: 'missing_diagnostic', site: 'error_display' }
  const label = mode === 'realtime' ? 'GPT-Realtime 2.1 Mini' : 'GPT-Live 1'
  const lines = [`${label} error`, `${detail.stage}/${detail.code}`]
  if (detail.site) lines.push(detail.site)
  if (detail.kind) lines.push(detail.kind)
  if (detail.status) lines.push(`HTTP ${detail.status}`)
  if (detail.providerCode) lines.push(detail.providerCode)
  if (detail.param) lines.push(detail.param)
  return lines.join('\n')
}

export class LiveSession {
  constructor({ Conversation, audio, networkReady, acquireLowLatency, amp, settings, onState, Timer }) {
    Object.assign(this, { Conversation, audio, networkReady, acquireLowLatency, amp, settings, onState, Timer })
    this.history = []
  }

  start() {
    if (this.active) return this.active.starting
    const entry = { cancelled: false, backend: new Map(), idleMs: (this.settings.standbySeconds ?? 60) * 1000 }
    this.active = entry
    this.onState('connecting')
    entry.starting = this.connect(entry)
    return entry.starting
  }

  async connect(entry) {
    let stage = 'configuration'
    let site = 'settings_check'
    try {
      if (typeof this.settings.apiKey !== 'string' || !this.settings.apiKey.trim()) {
        entry.failure = 'configuration'
        return false
      }
      stage = 'network'
      site = 'network_wait'
      const ready = await this.networkReady
      if (entry.cancelled || this.active !== entry) return false
      if (ready?.status !== 'connected') throw new Error('network unavailable')
      stage = 'audio'
      site = 'audio_acquire'
      entry.releaseAudio = this.audio.acquireExclusive()
      stage = 'radio'
      site = 'radio_acquire'
      entry.radio = this.acquireLowLatency()
      // The CoreS3 SDK amplifier has a setter but no sample-rate getter.
      // Return it to the SDK's 24 kHz baseline after native audio has stopped.
      stage = 'audio'
      site = 'amp_48k'
      entry.ampChanged = true
      this.amp.sampleRate = 48000
      stage = 'configuration'
      site = 'session_options'
      // Frame the configured persona as Mini's dialogue task, including its first greeting.
      // Build this in RAM; the saved prompt and GPT-Live instructions stay unchanged.
      const instructions =
        this.settings.mode === 'realtime' && this.settings.instructions?.trim()
          ? `# Task
Write and speak ONLY the next line of dialogue for the assistant described below. The user is the other participant. Answer the actual user question accurately. If a character or style is specified, this is a consensual performance and every line must embody it, including greetings.
# Assistant specification
${this.settings.instructions}`
          : this.settings.instructions
      const options = {
        mode: this.settings.mode,
        apiKey: this.settings.apiKey,
        model: this.settings.model,
        voice: this.settings.voice,
        pitch: this.settings.pitch ?? 0,
        bargeIn: this.settings.bargeIn === true,
        instructions: this.settings.bargeIn
          ? `${instructions ?? ''}\nInterruption policy: When the user interrupts, stop speaking immediately and listen until they finish. If they say stop or wait, remain silent without an acknowledgment. Do not resume an answer they have replaced.`
          : instructions,
        input: this.history.length
          ? this.history.map(({ role, text }) => ({
              type: 'message',
              role,
              content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
            }))
          : undefined,
        delegation: {
          type: 'responses',
          responses: {
            model: this.settings.backendModel ?? 'gpt-6.1-terra',
            ...(this.settings.reasoningEffort ? { reasoning: { effort: this.settings.reasoningEffort } } : {}),
            ...(this.settings.tools?.length ? { tools: this.settings.tools, tool_choice: 'auto' } : {}),
          },
        },
        onError: (error) => {
          if (this.active !== entry) return
          // close() owns the terminal result once shutdown has started. A late
          // provider notification must not erase the requested standby state.
          if (entry.cancelled) {
            entry.diagnostic ??= diagnostic(error, 'close', 'close_event')
            return
          }
          entry.failure = 'error'
          entry.diagnostic ??= diagnostic(error, 'events', 'event_on_error')
          void this.stop()
        },
        onStateChanged: (state) => {
          if (this.active !== entry) return
          if (state === 'closed' || state === 'error') void this.stop()
        },
        onTranscript: (fragment) => {
          if (this.active !== entry || entry.cancelled) return
          if (this.settings.mode === 'realtime') return
          // Only the robot's words renew standby. Microphone noise, incoming
          // speech, silent RTP and usage heartbeats cannot keep LIVE open.
          if (fragment.role === 'assistant' && fragment.delta?.trim()) this.armStandby(entry)
          this.remember(fragment)
        },
        onEvent: (event) => this.receive(entry, event),
      }
      if (this.settings.mode === 'realtime') {
        // Realtime owns its conversation remotely; never feed GPT-Live's RAM tail.
        delete options.input
        delete options.delegation
        options.search = {
          model: this.settings.backendModel ?? 'gpt-6.1-terra',
          reasoningEffort: this.settings.reasoningEffort,
        }
      }
      site = 'session_ctor'
      const conversation = new this.Conversation(options)
      entry.conversation = conversation
      stage = 'audio'
      site = 'volume_set'
      conversation.setVolume(this.settings.volume ?? 1)
      stage = 'connect'
      site = 'connect_wait'
      await conversation.connect()
      if (entry.cancelled || this.active !== entry) return false
      entry.connected = true
      this.armStandby(entry)
      this.onState('connected')
      return true
    } catch (error) {
      if (!entry.cancelled) {
        entry.failure = 'error'
        entry.diagnostic ??= diagnostic(error, stage, site)
      }
      return false
    } finally {
      if (entry.failure && this.active === entry) await this.stop()
    }
  }

  remember({ role, delta }) {
    if (!delta || (role !== 'user' && role !== 'assistant')) return
    const last = this.history[this.history.length - 1]
    if (last?.role === role) last.text = (last.text + delta.slice(-HISTORY_CHARS)).slice(-HISTORY_CHARS)
    else this.history.push({ role, text: delta.slice(-HISTORY_CHARS) })
    while (this.history.length > HISTORY_MESSAGES) this.history.shift()
    let excess = this.history.reduce((size, message) => size + message.text.length, 0) - HISTORY_CHARS
    while (excess > 0) {
      const first = this.history[0]
      if (first.text.length <= excess) {
        excess -= first.text.length
        this.history.shift()
      } else {
        first.text = first.text.slice(excess)
        break
      }
    }
  }

  receive(entry, message) {
    if (this.active !== entry || entry.cancelled) return
    const wasPending = entry.backend.size > 0
    if (message.type === 'session.delegation.created') {
      entry.backend.set(message.delegation.id, message.delegation.response_id)
    } else if (message.type === 'response.event') {
      const event = message.event
      const response = event.response?.id ?? event.response_id
      const id = message.delegation_id ?? response
      if (['response.created', 'response.queued', 'response.in_progress'].includes(event.type))
        entry.backend.set(id, response)
      else if (
        ['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type)
      ) {
        // Some envelopes omit delegation_id; retain the response ID from startup.
        for (const [key, value] of entry.backend)
          if (key === id || (response !== undefined && value === response)) entry.backend.delete(key)
      }
    }
    // Match the protocol's bounded concurrent work; never grow a task ledger forever.
    if (entry.backend.size > 8) throw new Error('Too many pending Live delegations')
    if (wasPending !== entry.backend.size > 0) this.armStandby(entry)
  }

  armStandby(entry) {
    if (entry.idleTimer !== undefined) this.Timer.clear(entry.idleTimer)
    entry.idleTimer = undefined
    if (this.settings.mode === 'realtime') return
    if (this.active !== entry || entry.cancelled || !entry.connected || entry.backend.size) return
    // One deadline. Pause only for a pending Responses request; start a full
    // interval when the last request ends. No audio statistics or VAD polling.
    entry.idleTimer = this.Timer.set(() => {
      if (this.active === entry && !entry.cancelled) void this.stop('standby')
    }, entry.idleMs)
  }

  stop(state = 'idle') {
    const entry = this.active
    if (!entry) return Promise.resolve()
    if (entry.closing) return entry.closing
    entry.cancelled = true
    entry.stoppedState = state
    if (entry.idleTimer !== undefined) this.Timer.clear(entry.idleTimer)
    entry.idleTimer = undefined
    this.onState('closing')
    entry.closing = this.finish(entry)
    return entry.closing
  }

  async finish(entry) {
    try {
      const result = await entry.conversation?.close()
      if (result && !result.finalized) {
        // The native transport has been released when close() resolves. Both
        // STOP and standby describe local shutdown; missing remote confirmation
        // remains a diagnostic. Earlier failures and cleanup errors stay errors.
        if (!['close_timeout', 'connection_lost', 'transport_error', 'hangup_failed'].includes(result.reason))
          entry.failure = 'error'
        entry.diagnostic ??= diagnostic({ code: result.reason }, 'close', 'native_close')
      }
    } catch (error) {
      entry.failure = 'error'
      entry.diagnostic ??= diagnostic(error, 'close', 'native_close')
    } finally {
      for (const [site, release] of [
        [
          'amp_restore',
          () => {
            if (entry.ampChanged) this.amp.sampleRate = 24000
          },
        ],
        ['radio_release', () => entry.radio?.close()],
        ['audio_release', () => entry.releaseAudio?.()],
      ]) {
        try {
          release()
        } catch (error) {
          entry.failure = 'error'
          entry.diagnostic ??= diagnostic(error, 'close', site)
        }
      }
      if (this.active === entry) {
        this.active = undefined
        if (entry.stoppedState !== 'standby') this.history.length = 0
        this.onState(entry.failure ?? entry.stoppedState, entry.diagnostic)
      }
    }
  }

  async setMuted(muted) {
    const entry = this.active,
      conversation = entry?.conversation
    if (!conversation || entry.cancelled) return false
    try {
      await conversation.setMuted(muted)
      return this.active === entry && !entry.cancelled && conversation.muted
    } catch (error) {
      if (this.active === entry) {
        entry.failure = 'error'
        entry.diagnostic ??= diagnostic(error, 'mute', 'mute_wait')
        await this.stop()
      }
      return false
    }
  }
}
