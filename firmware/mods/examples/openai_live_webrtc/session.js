// Conversation owns the protocol, native media and HTTP worker. This adapter
// only coordinates the host's audio/radio ownership and explicit user actions.
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

export function formatLiveError(detail) {
  if (!detail) detail = { stage: 'unknown', code: 'missing_diagnostic', site: 'error_display' }
  const lines = ['GPT-Live error R4', `${detail.stage}/${detail.code}`]
  if (detail.site) lines.push(detail.site)
  if (detail.kind) lines.push(detail.kind)
  if (detail.status) lines.push(`HTTP ${detail.status}`)
  if (detail.providerCode) lines.push(detail.providerCode)
  if (detail.param) lines.push(detail.param)
  return lines.join('\n')
}

export class LiveSession {
  constructor({ Conversation, audio, networkReady, acquireLowLatency, amp, settings, onState }) {
    Object.assign(this, { Conversation, audio, networkReady, acquireLowLatency, amp, settings, onState })
  }

  start() {
    if (this.active) return this.active.starting
    const entry = { cancelled: false }
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
      const options = {
        apiKey: this.settings.apiKey,
        model: this.settings.model,
        voice: this.settings.voice,
        instructions: this.settings.instructions,
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
          entry.failure = 'error'
          entry.diagnostic ??= diagnostic(error, 'events', 'event_on_error')
          void this.stop()
        },
        onStateChanged: (state) => {
          if (this.active !== entry) return
          if (state === 'closed' || state === 'error') void this.stop()
        },
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

  stop() {
    const entry = this.active
    if (!entry) return Promise.resolve()
    if (entry.closing) return entry.closing
    entry.cancelled = true
    this.onState('closing')
    entry.closing = this.finish(entry)
    return entry.closing
  }

  async finish(entry) {
    try {
      const result = await entry.conversation?.close()
      if (result && !result.finalized) {
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
        this.onState(entry.failure ?? 'idle', entry.diagnostic)
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
