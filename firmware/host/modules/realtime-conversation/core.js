// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0

import ToolRunner from 'realtimeConversation/tools'
import { createWebSearchTool } from 'realtimeConversation/web-search'

const ENDPOINT = 'https://api.openai.com/v1/live/sessions'
const REALTIME_ENDPOINT = 'https://api.openai.com/v1/realtime/calls'
const DIAGNOSTIC_EVENTS = new Set([
  'session.created',
  'session.updated',
  'session.started',
  'session.closed',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed',
  'output_audio_buffer.started',
  'output_audio_buffer.stopped',
  'output_audio_buffer.cleared',
  'response.created',
  'response.done',
  'response.completed',
  'response.cancelled',
  'response.failed',
  'response.incomplete',
  'response.function_call_arguments.done',
  'response.output_item.done',
  'error',
  'session.input_audio.muted',
  'session.input_audio.unmuted',
  'session.delegation.created',
  'conversation.item.created',
  'conversation.item.added',
  'conversation.item.done',
])

export class ConversationError extends Error {
  constructor(message, code, stage, status) {
    super(message)
    this.code = code
    this.stage = stage
    if (status !== undefined) this.status = status
  }
  get name() {
    return 'ConversationError'
  }
}

function attachErrorMetadata(error, source) {
  if (typeof source?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(source.code) && !/^sk_/i.test(source.code))
    error.providerCode = source.code
  if (
    typeof source?.param === 'string' &&
    /^(?:session|delegation|model|audio|tools|reasoning)(?:[.[\]a-z0-9_]){0,96}$/i.test(source.param)
  )
    error.param = source.param
  return error
}

function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}

function copyDelegation(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (error) {
    error.site = 'core_delegation'
    throw error
  }
}

function trialInput(input) {
  const t = input.turn_detection
  const turn = { type: t.type, create_response: t.create_response, interrupt_response: t.interrupt_response }
  for (const name of ['threshold', 'silence_duration_ms', 'prefix_padding_ms', 'eagerness'])
    if (t[name] !== undefined) turn[name] = t[name]
  const noise = input.noise_reduction
  return { turn_detection: turn, noise_reduction: noise ? { type: noise.type, strength: noise.strength } : null }
}

export default class Conversation {
  #platform
  #options
  #key
  #state = 'idle'
  #transport
  #connection
  #closing
  #finishing = false
  #signalPending = false
  #signaled = false
  #sessionId
  #ready = false
  #closeSent = false
  #timers = new Set()
  #connectTimer
  #mute
  #muted = false
  #volume = 0.5
  #eventID = 0
  #usage
  #result
  #stats
  #trialBaseline
  #trialCurrent
  #trial
  #trialDirty = false
  #tools
  #signaling
  #toolTimeout
  #realtime = false
  #callId
  #signalRequest
  #activeResponse
  #playbackResponse
  #continuation
  #continuationTimer
  #continuationAttempts = 0
  #sentContinuation
  #continuationInFlight = false
  #miniInterrupted = false
  #liveOutputStart = -1
  #liveOutputEnd = -1
  #liveInputStart = -1
  #liveInputEnd = -1
  #liveInterrupted = false
  #liveResumed = false

  constructor(options, platform) {
    if (!options || (!options.signaling && (typeof options.apiKey !== 'string' || !options.apiKey.trim())))
      throw new TypeError('apiKey or signaling is required')
    if ([options.signaling, options.apiKey].filter((v) => v !== undefined).length !== 1)
      throw new TypeError('Choose apiKey or signaling')
    if (options.signaling) {
      const adapter = options.signaling
      if (typeof adapter.createSession !== 'function' || typeof adapter.hangup !== 'function')
        throw new TypeError('Invalid signaling adapter')
      this.#signaling = {
        create: (sdp, canStart, starting) => adapter.createSession({ sdp, canStart, starting }),
        accept: (result) => adapter.acceptSession?.(result),
        hangup: (sessionId) => adapter.hangup({ sessionId }),
      }
    }
    for (const name of ['onStateChanged', 'onTranscript', 'onEvent', 'onError', 'onToolResult'])
      if (options[name] !== undefined && typeof options[name] !== 'function')
        throw new TypeError(`${name} must be a function`)
    if (options.bargeIn !== undefined && typeof options.bargeIn !== 'boolean')
      throw new TypeError('bargeIn must be boolean')
    const vad = options.turnDetection
    if (
      vad !== undefined &&
      (!vad ||
        !['server_vad', 'semantic_vad'].includes(vad.type) ||
        (vad.threshold !== undefined &&
          (vad.type !== 'server_vad' || !Number.isFinite(vad.threshold) || vad.threshold < 0 || vad.threshold > 1)) ||
        (vad.eagerness !== undefined &&
          (vad.type !== 'semantic_vad' || !['low', 'medium', 'high', 'auto'].includes(vad.eagerness))))
    )
      throw new TypeError('Invalid turn detection')
    if (options.pitch !== undefined && (!Number.isInteger(options.pitch) || options.pitch < -6 || options.pitch > 6))
      throw new RangeError('pitch must be an integer between -6 and 6 semitones')
    this.#key = options.apiKey
    this.#realtime = options.mode === 'realtime'
    if (options.mode !== undefined && options.mode !== 'live' && !this.#realtime) throw new TypeError('Invalid mode')
    if (this.#realtime && options.signaling) throw new TypeError('Realtime requires apiKey')
    this.#options = {
      model: options.model ?? (this.#realtime ? 'gpt-realtime-2.1-mini' : 'gpt-live-1'),
      instructions: options.instructions ?? '',
      voice: options.voice ?? 'marin',
      pitch: options.pitch ?? 0,
      bargeIn: options.bargeIn === true,
      turnDetection: vad === undefined ? undefined : { ...vad },
      delegation: options.delegation === undefined ? undefined : copyDelegation(options.delegation),
      input: options.input === undefined ? undefined : copyDelegation(options.input),
      onStateChanged: options.onStateChanged,
      onTranscript: options.onTranscript,
      onEvent: options.onEvent,
      onError: options.onError,
      onToolResult: options.onToolResult,
    }
    for (const name of ['model', 'instructions', 'voice'])
      if (typeof this.#options[name] !== 'string') throw new TypeError(`invalid ${name}`)
    if (this.#realtime && !['gpt-realtime-2.1-mini', 'gpt-realtime-2.1'].includes(this.#options.model))
      throw new TypeError('Invalid Realtime model')
    this.#platform = platform
    this.#toolTimeout = options.toolTimeout ?? (this.#realtime ? 50000 : undefined)
    if (options.tools !== undefined && !Array.isArray(options.tools)) throw new TypeError('Invalid tools')
    const tools =
      this.#realtime && options.search
        ? [createWebSearchTool({ ...options.search, apiKey: this.#key, fetch: platform.fetch })]
        : options.tools
    if (tools?.length) {
      if (!this.#realtime && this.#options.delegation?.type !== 'responses')
        throw new TypeError('Tools require Responses delegation')
      this.#tools = new ToolRunner(tools, {
        platform,
        timeout: this.#toolTimeout,
        send: (event) => this.#send(event),
        onError: (error) => this.#fail(error),
        onResult: (result) => this.#notify('onToolResult', result),
        protocol: this.#realtime ? 'realtime' : 'live',
      })
      if (this.#realtime) return
      const backend = this.#options.delegation.responses
      const definitions = backend.tools ?? []
      const names = new Set(definitions.filter((tool) => tool.type === 'function').map((tool) => tool.name))
      for (const tool of this.#tools.definitions) {
        if (names.has(tool.name)) throw new TypeError('Duplicate tool definition')
        definitions.push(tool)
      }
      backend.tools = definitions
    }
  }

  // Signaling configuration may arrive while the local SDP is being prepared.
  setTools(tools) {
    if (!this.#signaling || this.#signaled || !['idle', 'connecting'].includes(this.#state))
      throw new Error('Configure signaling tools before session creation')
    const runner = new ToolRunner(tools, {
      platform: this.#platform,
      timeout: this.#toolTimeout,
      send: (event) => this.#send(event),
      onError: (error) => this.#fail(error),
      onResult: (result) => this.#notify('onToolResult', result),
    })
    this.#tools?.close()
    this.#tools = runner
  }

  get state() {
    return this.#state
  }
  get sessionId() {
    return this.#sessionId
  }
  get muted() {
    return this.#muted
  }
  get volume() {
    return this.#volume
  }
  get usage() {
    return this.#usage && { ...this.#usage }
  }
  get stats() {
    return this.#transport?.stats ?? this.#stats
  }

  connect() {
    if (this.#state === 'connecting' || this.#state === 'connected') return this.#connection.promise
    if (this.#state !== 'idle')
      return Promise.reject(new ConversationError('Create a new conversation to reconnect', 'closed', 'connect'))
    this.#connection = deferred()
    const promise = this.#connection.promise
    this.#setState('connecting')
    if (this.#state !== 'connecting') return promise
    try {
      this.#transport = this.#platform.createTransport((event) => this.#receive(event))
      this.#transport.setVolume(this.#volume)
      // Realtime must acknowledge the requested prompt before receiving speech.
      if (this.#realtime) this.#transport.setMuted(true)
      this.#connectTimer = this.#after(60000, () =>
        this.#fail(new ConversationError('Session startup timed out', 'connect_timeout', 'connect')),
      )
      this.#transport.start({
        bargeIn: this.#options.bargeIn,
        pitch: this.#options.pitch,
        ...(this.#realtime ? { realtime: true } : {}),
      })
    } catch (error) {
      this.#fail(error)
    }
    return promise
  }

  close() {
    if (this.#closing) return this.#closing.promise
    this.#closing = deferred()
    if (this.#result) {
      this.#closing.resolve(this.#result)
      return this.#closing.promise
    }
    // Silence locally before signaling/finalization, including during startup.
    this.#transport?.quiesce?.()
    this.#cancelTimer(this.#connectTimer)
    this.#tools?.close()
    this.#connection?.reject(new ConversationError('Connection cancelled', 'cancelled', 'connect'))
    this.#setState('closing')
    if (this.#realtime) {
      this.#signalRequest?.cancel?.()
      void this.#finish({ finalized: !this.#signaled, reason: 'client_request' })
      return this.#closing.promise
    }
    if (!this.#signaled) {
      void this.#finish({ finalized: true, reason: 'not_started' })
    } else {
      this.#after(3000, () => {
        const error = new ConversationError('No session.closed event received', 'close_timeout', 'close')
        this.#notify('onError', error)
        void this.#finish({ finalized: false, reason: 'close_timeout', usage: this.#usage })
      })
      if (this.#ready) this.#sendClose()
    }
    return this.#closing.promise
  }

  setVolume(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
      throw new RangeError('volume must be between 0 and 1')
    this.#transport?.setVolume(value)
    this.#volume = value
  }

  setMuted(value) {
    if (typeof value !== 'boolean') return Promise.reject(new TypeError('muted must be boolean'))
    if (this.#state !== 'connected')
      return Promise.reject(new ConversationError('Session is not connected', 'not_connected', 'mute'))
    if (this.#mute) return Promise.reject(new ConversationError('A mute command is pending', 'command_pending', 'mute'))
    if (value === this.#muted) return Promise.resolve()
    if (this.#realtime) {
      this.#transport.setMuted(value)
      this.#muted = value
      return Promise.resolve()
    }
    const pending = { ...deferred(), value, id: `mute_${++this.#eventID}` }
    this.#mute = pending
    try {
      // Keep local capture gated until the remote command is acknowledged.
      this.#transport.setMuted(true)
      this.#muted = true
      pending.timer = this.#after(5000, () =>
        this.#rejectMute(new ConversationError('Mute acknowledgment timed out', 'command_timeout', 'mute')),
      )
      this.#send({ type: value ? 'session.input_audio.mute' : 'session.input_audio.unmute', event_id: pending.id })
    } catch (error) {
      this.#rejectMute(error)
    }
    return pending.promise
  }

  async #signal(sdp) {
    if (this.#signaled || this.#signalPending || this.#state !== 'connecting') return
    if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > 65536)
      return this.#fail(new ConversationError('Invalid local SDP', 'invalid_sdp', 'signaling'))
    this.#signalPending = true
    const key = this.#key
    try {
      const options = this.#options
      let response
      if (this.#signaling) {
        response = await this.#signaling.create(
          sdp,
          () => this.#state === 'connecting' && !this.#finishing && !this.#result,
          () => {
            this.#signaled = true
          },
        )
        if (!response) return
      } else if (this.#realtime) {
        const session = JSON.stringify({
          type: 'realtime',
          model: options.model,
          instructions: options.instructions,
          audio: {
            input: this.#realtimeInput(),
            output: { voice: options.voice },
          },
          tools: this.#tools?.definitions ?? [],
        })
        // Pick a boundary absent from both fields, including user instructions.
        let boundary = 'stackchan_realtime'
        while (session.includes(boundary) || sdp.includes(boundary)) boundary += '_'
        const body = `--${boundary}\r\nContent-Disposition: form-data; name="sdp"\r\nContent-Type: application/sdp\r\n\r\n${sdp}\r\n--${boundary}\r\nContent-Disposition: form-data; name="session"\r\nContent-Type: application/json\r\n\r\n${session}\r\n--${boundary}--\r\n`
        this.#signaled = true
        this.#signalRequest = this.#platform.fetch(REALTIME_ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
          body,
        })
        response = await this.#signalRequest
        const location = response.location ?? response.headers?.get?.('location')
        const match =
          typeof location === 'string' &&
          /^(?:https:\/\/api\.openai\.com)?\/v1\/realtime\/calls\/([a-zA-Z0-9_-]{1,256})$/.exec(location)
        if (match) this.#callId = match[1]
      } else {
        this.#signaled = true
        response = await this.#platform.fetch(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session: {
              model: options.model,
              instructions: options.instructions,
              input: options.input,
              audio: { output: { voice: options.voice } },
              delegation: options.delegation,
              store: false,
            },
            transport: { type: 'webrtc', sdp },
          }),
        })
      }
      const text = await response.text()
      if (this.#realtime && response.ok) {
        if (this.#finishing || this.#result || this.#state === 'closing') {
          if (this.#callId) await this.#hangup(this.#callId, key)
          return
        }
        if (typeof text !== 'string' || !text.startsWith('v=0') || text.length > 65536)
          throw new ConversationError('Missing SDP answer', 'invalid_sdp', 'signaling')
        if (!this.#callId) throw new ConversationError('Missing call ID', 'invalid_session', 'signaling')
        this.#transport.acceptAnswer(text)
        return
      }
      if (response.status !== 201 || this.#realtime) {
        const error = new ConversationError(
          `Live session creation failed (HTTP ${response.status})`,
          'http_error',
          'signaling',
          response.status,
        )
        if (typeof text === 'string' && text.length <= 131072) {
          try {
            attachErrorMetadata(error, JSON.parse(text)?.error)
          } catch {
            // Keep status-only diagnostics for non-JSON error responses.
          }
        }
        throw error
      }
      if (typeof text !== 'string' || text.length > 131072)
        throw new ConversationError('Session response exceeds limit', 'response_limit', 'signaling')
      let result
      try {
        result = JSON.parse(text)
      } catch {
        throw new ConversationError('Invalid session response JSON', 'invalid_json', 'signaling')
      }
      if (typeof result.session?.id !== 'string' || !result.session.id)
        throw new ConversationError('Missing session ID', 'invalid_session', 'signaling')
      this.#sessionId = result.session.id
      this.#signaling?.accept(result)
      if (this.#finishing || this.#result) {
        await this.#hangup(result.session.id, key)
        return
      }
      if (
        result.transport?.type !== 'webrtc' ||
        typeof result.transport.sdp !== 'string' ||
        !result.transport.sdp.startsWith('v=0')
      )
        throw new ConversationError('Missing SDP answer', 'invalid_sdp', 'signaling')
      this.#transport.acceptAnswer(result.transport.sdp)
    } catch (error) {
      if (!this.#finishing && !this.#result) this.#fail(error)
    } finally {
      this.#signalRequest = undefined
      this.#signalPending = false
    }
  }

  #receive(event) {
    if (this.#finishing || this.#result) return
    try {
      if (event.type === 'offer') {
        void this.#signal(event.sdp)
        return
      }
      if (event.type === 'error')
        throw new ConversationError(`WebRTC failure (${event.code})`, 'transport_error', event.stage ?? 'transport')
      if (event.type === 'disconnected')
        throw new ConversationError('WebRTC disconnected before session.closed', 'connection_lost', 'transport')
      if (event.type !== 'message') return
      if (typeof event.data !== 'string' || event.data.length > 131072)
        throw new ConversationError('Invalid event size', 'event_limit', 'events')
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        throw new ConversationError('Invalid event JSON', 'invalid_json', 'events')
      }
      if (!message || typeof message.type !== 'string')
        throw new ConversationError('Invalid event', 'invalid_event', 'events')
      if (this.#platform.debug?.enabled) this.#diagnose('receive', message)
      this.#tools?.receive(message)
      switch (message.type) {
        case 'input_audio_buffer.speech_started':
          if (this.#realtime && this.#options.bargeIn && !this.#muted && !this.#miniInterrupted) {
            this.#miniInterrupted = true
            this.#interruptSpeech(message.type)
          } else if (this.#platform.debug?.enabled) this.#diagnose('interrupt.ignore', message)
          break
        case 'output_audio_buffer.cleared':
          if (
            this.#realtime &&
            this.#options.bargeIn &&
            !this.#muted &&
            !this.#miniInterrupted &&
            (!message.response_id || !this.#playbackResponse || message.response_id === this.#playbackResponse)
          ) {
            this.#miniInterrupted = true
            this.#interruptSpeech(message.type)
          } else if (this.#platform.debug?.enabled) this.#diagnose('interrupt.ignore', message)
          break
        case 'response.created':
          if (this.#realtime) {
            this.#activeResponse = message.response?.id
            this.#playbackResponse = this.#activeResponse
            this.#continuationInFlight = false
            this.#miniInterrupted = false
            if (this.#platform.debug?.enabled) this.#diagnose('output.resume', message)
            this.#transport.resumeOutput?.()
          }
          break
        case 'session.created':
        case 'session.updated':
          if (!this.#realtime) break
          if (this.#ready) {
            if (message.type === 'session.updated' && this.#trial) {
              const actual = trialInput(message.session.audio.input)
              if (JSON.stringify(actual) !== JSON.stringify(this.#trial.expected))
                this.#rejectTrial(
                  new ConversationError('Trial configuration mismatch', 'configuration_mismatch', 'tune'),
                )
              else {
                const pending = this.#trial
                this.#trial = undefined
                this.#trialCurrent = actual
                this.#cancelTimer(pending.timer)
                pending.resolve()
              }
            }
            break
          }
          if (typeof message.session?.id !== 'string' || !message.session.id)
            throw new ConversationError('Missing session ID', 'invalid_session', 'events')
          this.#sessionId = message.session.id
          const turn = message.session.audio?.input?.turn_detection
          const noise = message.session.audio?.input?.noise_reduction
          if (
            turn?.type !== this.#turnDetection().type ||
            turn.threshold !== this.#turnDetection().threshold ||
            turn.eagerness !== this.#turnDetection().eagerness ||
            turn.create_response !== true ||
            turn.interrupt_response !== this.#options.bargeIn ||
            (this.#options.bargeIn && (noise?.type !== 'far_field' || noise.strength !== 1)) ||
            message.session.instructions !== this.#options.instructions
          ) {
            if (message.type === 'session.updated')
              throw new ConversationError('Realtime session configuration mismatch', 'configuration_mismatch', 'events')
            this.#send({
              type: 'session.update',
              event_id: 'realtime_setup',
              session: {
                type: 'realtime',
                instructions: this.#options.instructions,
                audio: {
                  input: this.#realtimeInput(),
                },
              },
            })
            break
          }
          this.#ready = true
          this.#trialBaseline = this.#trialCurrent = trialInput(message.session.audio.input)
          this.#platform.debug?.registerTuner?.(this, {
            set: (name, value) => this.#setTrial(name, value),
            reset: () => this.#resetTrial(),
            snapshot: () => ({
              threshold: this.#trialCurrent.turn_detection.threshold,
              silence: this.#trialCurrent.turn_detection.silence_duration_ms,
              noiseReduction: this.#trialCurrent.noise_reduction?.type ?? 'off',
            }),
          })
          this.#transport.setMuted(this.#muted)
          this.#cancelTimer(this.#connectTimer)
          this.#setState('connected')
          this.#connection.resolve({ id: this.#sessionId })
          break
        case 'response.output_audio_transcript.delta':
          if (this.#realtime && typeof message.delta === 'string')
            this.#notify('onTranscript', { role: 'assistant', delta: message.delta })
          break
        case 'response.done':
          if (this.#realtime) {
            if (message.response?.usage) this.#usage = { ...message.response.usage }
            if (message.response?.id === this.#activeResponse) {
              this.#activeResponse = undefined
              if (!this.#continuation && !this.#continuationInFlight) this.#sentContinuation = undefined
            }
            if (this.#continuation && !this.#activeResponse) this.#continueResponse()
          }
          break
        case 'session.started':
          if (message.session?.id !== this.#sessionId)
            throw new ConversationError('Session ID mismatch', 'session_mismatch', 'events')
          this.#ready = true
          this.#cancelTimer(this.#connectTimer)
          if (this.#state === 'closing') this.#sendClose()
          else {
            this.#setState('connected')
            this.#connection.resolve({ id: this.#sessionId })
          }
          break
        case 'session.input_transcript.delta':
        case 'session.output_transcript.delta':
          if (
            typeof message.delta !== 'string' ||
            !Number.isFinite(message.start_ms) ||
            !Number.isFinite(message.end_ms) ||
            message.end_ms < message.start_ms
          )
            throw new ConversationError('Invalid transcript fragment', 'invalid_transcript', 'events')
          if (!this.#realtime && this.#state === 'connected' && message.delta.trim()) this.#liveTurn(message)
          this.#notify('onTranscript', {
            role: message.type === 'session.input_transcript.delta' ? 'user' : 'assistant',
            delta: message.delta,
            start_ms: message.start_ms,
            end_ms: message.end_ms,
          })
          break
        case 'session.usage.updated':
          if (Number.isFinite(message.usage?.seconds)) this.#usage = { ...message.usage }
          break
        case 'session.input_audio.muted':
        case 'session.input_audio.unmuted': {
          const pending = this.#mute
          if (
            pending &&
            message.client_event_id === pending.id &&
            (message.type === 'session.input_audio.muted') === pending.value
          ) {
            this.#cancelTimer(pending.timer)
            this.#muted = pending.value
            this.#transport.setMuted(pending.value)
            this.#mute = undefined
            pending.resolve()
          }
          break
        }
        case 'error': {
          if (
            this.#trial &&
            (message.error?.event_id === this.#trial.id || message.error?.client_event_id === this.#trial.id)
          ) {
            this.#rejectTrial(new ConversationError('Trial rejected', message.error.code ?? 'tune_failed', 'tune'))
            break
          }
          // Automatic cancellation can win this race without losing a session.
          if (this.#realtime && message.error?.code === 'response_cancel_not_active') break
          if (message.error?.code === 'conversation_already_has_active_response') {
            // This rejects a command, not the session, with either interruption
            // policy. event_id is optional; attribute an absent ID only while
            // our single continuation is awaiting a response.
            const eventID = message.error.event_id
            if (
              this.#realtime &&
              this.#sentContinuation &&
              (eventID === this.#sentContinuation.event_id || (eventID == null && this.#continuationInFlight))
            ) {
              this.#cancelTimer(this.#continuationTimer)
              this.#continuationInFlight = false
              this.#continuation ??= this.#sentContinuation
              // VAD may win before response.created reaches the device. Bound
              // speculative retries, then wait for response.done. Never replay
              // function_call_output or retry an unrelated/stale command.
              if (!this.#activeResponse && this.#continuationAttempts < 3)
                this.#continuationTimer = this.#after(250, () => this.#continueResponse())
            }
            break
          }
          const error = attachErrorMetadata(
            new ConversationError(
              message.error?.message ?? 'Live command rejected',
              message.error?.code ?? 'server_error',
              'events',
            ),
            message.error,
          )
          if (message.error?.client_event_id && this.#mute?.id === message.error.client_event_id)
            this.#rejectMute(error)
          else this.#notify('onError', error)
          break
        }
        case 'session.closed':
          if (Number.isFinite(message.usage?.seconds)) this.#usage = { ...message.usage }
          this.#notify('onEvent', message)
          void this.#finish({ finalized: true, reason: message.reason, usage: this.#usage })
          return
      }
      this.#notify('onEvent', message)
    } catch (error) {
      this.#fail(error)
    }
  }

  #realtimeInput() {
    return {
      // Filter residual echo before server VAD can cancel the current reply.
      ...(this.#options.bargeIn ? { noise_reduction: { type: 'far_field', strength: 1 } } : {}),
      turn_detection: this.#turnDetection(),
    }
  }
  #setTrial(name, value) {
    if (this.#state !== 'connected' || !this.#realtime)
      return Promise.reject(new ConversationError('No connected Realtime session', 'not_connected', 'tune'))
    const input = JSON.parse(JSON.stringify(this.#trialCurrent))
    if (
      name === 'vad' &&
      typeof value === 'number' &&
      value >= 0.1 &&
      value <= 0.95 &&
      input.turn_detection.type === 'server_vad'
    )
      input.turn_detection.threshold = value
    else if (
      name === 'silence' &&
      Number.isInteger(value) &&
      value >= 200 &&
      value <= 2000 &&
      input.turn_detection.type === 'server_vad'
    )
      input.turn_detection.silence_duration_ms = value
    else if (name === 'noise' && ['far_field', 'near_field', 'off'].includes(value))
      input.noise_reduction = value === 'off' ? null : { type: value, strength: 1 }
    else return Promise.reject(new ConversationError('Invalid trial parameter', 'invalid_parameter', 'tune'))
    this.#trialDirty = true
    return this.#updateTrial(input)
  }
  #updateTrial(input) {
    if (this.#trial) return Promise.reject(new ConversationError('Trial pending', 'command_pending', 'tune'))
    const pending = { ...deferred(), id: `trial_${++this.#eventID}`, expected: input }
    this.#trial = pending
    try {
      pending.timer = this.#after(5000, () =>
        this.#rejectTrial(new ConversationError('Trial acknowledgement timed out', 'command_timeout', 'tune')),
      )
      this.#send({ type: 'session.update', event_id: pending.id, session: { type: 'realtime', audio: { input } } })
    } catch (error) {
      this.#rejectTrial(error)
    }
    return pending.promise
  }
  async #resetTrial() {
    if (!this.#trialDirty) return
    if (this.#trial) {
      try {
        await this.#trial.promise
      } catch {}
    }
    if (this.#state === 'connected' && this.#trialBaseline) {
      await this.#updateTrial(this.#trialBaseline)
      this.#trialDirty = false
    }
  }
  #rejectTrial(error) {
    const pending = this.#trial
    if (!pending) return
    this.#trial = undefined
    this.#cancelTimer(pending.timer)
    pending.reject(error)
  }
  #turnDetection() {
    const configured = this.#options.turnDetection
    return {
      type: configured?.type ?? 'server_vad',
      ...(configured?.type === 'semantic_vad'
        ? { eagerness: configured.eagerness ?? 'auto' }
        : { threshold: configured?.threshold ?? 0.5 }),
      create_response: true,
      interrupt_response: this.#options.bargeIn,
    }
  }
  #interruptSpeech(reason) {
    if (this.#platform.debug?.enabled) this.#diagnose('interrupt.accept', { type: reason })
    this.#transport.interruptOutput?.()
    this.#tools?.cancelPending(true)
    this.#cancelTimer(this.#continuationTimer)
    this.#continuation = this.#sentContinuation = undefined
    this.#continuationInFlight = false
    this.#notify('onEvent', { type: 'local.interruption' })
  }
  #liveTurn(message) {
    if (message.type === 'session.output_transcript.delta') {
      if (message.end_ms <= this.#liveOutputEnd) return
      if (this.#liveOutputStart < 0 || message.start_ms - this.#liveOutputEnd >= 500) {
        this.#liveOutputStart = message.start_ms
      }
      this.#liveOutputEnd = message.end_ms
      if (this.#liveInterrupted && !this.#liveResumed && message.start_ms >= this.#liveInputEnd) {
        // Keep the caller's interruption latch after resume: late fragments
        // from that same caller turn must not cancel continued output again.
        this.#liveResumed = true
        if (this.#platform.debug?.enabled) this.#diagnose('output.resume', { type: 'live.caller_finished' })
        this.#transport.resumeOutput?.()
      }
    } else {
      if (message.end_ms <= this.#liveInputEnd) return
      if (this.#liveInputStart < 0 || message.start_ms - this.#liveInputEnd >= 500) {
        this.#liveInputStart = message.start_ms
        this.#liveInterrupted = false
      }
      this.#liveInputEnd = message.end_ms
    }
    // Delivery is not speech onset. Use the source interval and the caller's
    // first fragment; late old words must not cancel a later assistant reply.
    if (
      this.#options.bargeIn &&
      !this.#muted &&
      !this.#liveInterrupted &&
      this.#liveOutputStart >= 0 &&
      this.#liveInputStart >= this.#liveOutputStart &&
      this.#liveInputStart <= this.#liveOutputEnd + 300
    ) {
      this.#liveInterrupted = true
      this.#liveResumed = false
      this.#interruptSpeech('live.transcript_overlap')
    }
  }
  #send(message) {
    if (this.#platform.debug?.enabled) this.#diagnose('send.queue', message)
    if (this.#realtime && message.type === 'response.create') {
      this.#continuation = message
      this.#continuationAttempts = 0
      this.#continueResponse()
      return
    }
    if (this.#platform.debug?.enabled) this.#diagnose('send.attempt', message)
    this.#transport.send(JSON.stringify(message))
  }
  #continueResponse() {
    if (!this.#continuation || this.#activeResponse || this.#continuationInFlight || this.#state !== 'connected') return
    this.#cancelTimer(this.#continuationTimer)
    const message = this.#continuation
    this.#continuation = undefined
    this.#sentContinuation = message
    this.#continuationInFlight = true
    this.#continuationAttempts++
    try {
      if (this.#platform.debug?.enabled) this.#diagnose('send.attempt', message)
      this.#transport.send(JSON.stringify(message))
    } catch (error) {
      this.#fail(error)
    }
  }
  #sendClose() {
    if (this.#closeSent) return
    this.#closeSent = true
    try {
      this.#send({ type: 'session.close' })
    } catch (error) {
      this.#fail(error)
    }
  }
  #rejectMute(error) {
    const pending = this.#mute
    if (!pending) return
    this.#mute = undefined
    this.#cancelTimer(pending.timer)
    pending.reject(error)
    this.#notify('onError', error)
  }
  #fail(error) {
    if (this.#platform.debug?.enabled) this.#diagnose('failure', { type: 'error', error })
    if (this.#finishing || this.#result) return
    if (!(error instanceof ConversationError))
      error = new ConversationError(error?.message ?? 'Conversation failed', 'operation_failed', 'transport')
    this.#connection?.reject(error)
    this.#notify('onError', error)
    void this.#finish({ finalized: false, reason: error.code, usage: this.#usage }, true)
  }
  async #hangup(id, key) {
    try {
      if (this.#signaling) {
        await this.#signaling.hangup(id)
        return
      }
      const endpoint = this.#realtime ? REALTIME_ENDPOINT : ENDPOINT
      const response = await this.#platform.fetch(`${endpoint}/${encodeURIComponent(id)}/hangup`, {
        method: 'POST',
        ...(this.#realtime ? { timeoutMs: 3000 } : {}),
        headers: { Authorization: `Bearer ${key}` },
        body: '',
      })
      await response.text()
      if (!response.ok)
        this.#notify(
          'onError',
          new ConversationError('Session hangup was not confirmed', 'hangup_failed', 'close', response.status),
        )
      return response.ok
    } catch {
      this.#notify('onError', new ConversationError('Session hangup was not confirmed', 'hangup_failed', 'close'))
      return false
    }
  }
  async #finish(result, failed = false) {
    if (this.#finishing || this.#result) return
    if (this.#platform.debug?.enabled)
      this.#diagnose('finish', { type: 'local.close', response: { status_details: { reason: result.reason } } })
    this.#finishing = true
    this.#platform.debug?.unregisterTuner?.(this)
    this.#rejectTrial(new ConversationError('Session ended', 'closed', 'tune'))
    this.#tools?.close()
    this.#signalRequest?.cancel?.()
    this.#continuation = undefined
    this.#sentContinuation = undefined
    for (const timer of this.#timers) this.#platform.clearTimeout(timer)
    this.#timers.clear()
    this.#rejectMute(new ConversationError('Session ended', 'closed', 'mute'))
    this.#connection?.reject(new ConversationError('Session ended before startup', 'closed', 'connect'))
    const transport = this.#transport
    this.#transport = undefined
    if (this.#realtime) transport?.quiesce?.()
    const hangup = this.#realtime && this.#callId ? this.#hangup(this.#callId, this.#key) : undefined
    // Keep silent media clocks running while the peer ends its stream. Live
    // already reaches teardown after session.closed or its grace deadline.
    const confirmed = hangup ? await hangup : undefined
    if (!this.#realtime && (!result.finalized || this.#signaling) && this.#sessionId)
      void this.#hangup(this.#sessionId, this.#key)
    try {
      await transport?.close()
      this.#stats = transport?.stats
    } catch (error) {
      failed = true
      result = { ...result, finalized: false, reason: 'cleanup_error' }
      this.#notify('onError', error)
    }
    if (hangup) {
      if (!failed && result.reason === 'client_request')
        result = { ...result, finalized: confirmed, reason: confirmed ? 'client_request' : 'hangup_failed' }
    } else if (this.#realtime && !result.finalized && result.reason === 'client_request') {
      result = { ...result, reason: 'close_timeout' }
    }
    this.#key = undefined
    this.#result = result
    this.#setState(failed ? 'error' : 'closed')
    this.#closing?.resolve(result)
  }
  #setState(state) {
    this.#state = state
    if (this.#platform.debug?.enabled) this.#diagnose('state', { type: state })
    this.#notify('onStateChanged', state)
  }
  #notify(name, value) {
    try {
      this.#options[name]?.(value)
    } catch (error) {
      if (name !== 'onError')
        try {
          this.#options.onError?.(new ConversationError(error.message, 'callback_error', 'callback'))
        } catch {}
    }
  }
  #after(delay, callback) {
    const timer = this.#platform.setTimeout(() => {
      this.#timers.delete(timer)
      callback()
    }, delay)
    this.#timers.add(timer)
    return timer
  }
  #cancelTimer(timer) {
    if (this.#timers.delete(timer)) this.#platform.clearTimeout(timer)
  }

  #diagnose(event, envelope) {
    const debug = this.#platform.debug
    if (!debug?.enabled) return
    try {
      const message = envelope?.type === 'response.event' ? envelope.event : envelope
      if (event === 'receive' && !DIAGNOSTIC_EVENTS.has(message?.type)) return
      const response = message?.response
      const error = message?.error ?? response?.status_details?.error
      // Incremental assignment keeps this optional path within the XS stack
      // budget even when a test transport delivers a close event synchronously.
      const fields = {}
      fields.type = message?.type
      fields.event_id = message?.event_id
      fields.response_id = response?.id ?? message?.response_id
      fields.item_id = message?.item_id ?? message?.item?.id
      fields.previous_item_id = message?.previous_item_id
      fields.itemRole = message?.item?.role
      fields.itemType = message?.item?.type
      fields.call_id = message?.call_id ?? message?.item?.call_id
      fields.connection_id = this.#realtime ? this.#callId : this.#sessionId
      fields.tool = message?.name ?? message?.item?.name
      fields.delegation_id = envelope?.delegation_id
      fields.responseStatus = response?.status
      fields.detailType = response?.status_details?.type
      fields.reason = response?.status_details?.reason
      fields.errorCode = error?.code
      fields.status = error?.status
      fields.client_event_id = error?.event_id ?? message?.client_event_id
      fields.audio_start_ms = message?.audio_start_ms
      fields.audio_end_ms = message?.audio_end_ms
      fields.activeResponse = this.#activeResponse
      fields.playbackResponse = this.#playbackResponse
      fields.mode = this.#realtime ? 'realtime' : 'live'
      fields.model = this.#options.model
      fields.state = this.#state
      fields.bargeIn = this.#options.bargeIn
      fields.muted = this.#muted
      fields.interrupted = this.#realtime ? this.#miniInterrupted : this.#liveInterrupted
      fields.pending = this.#continuationInFlight
      fields.attempt = this.#continuationAttempts
      fields.vad = message?.session?.audio?.input?.turn_detection?.type
      fields.threshold = message?.session?.audio?.input?.turn_detection?.threshold
      fields.noiseReduction = message?.session?.audio?.input?.noise_reduction?.type
      fields.strength = message?.session?.audio?.input?.noise_reduction?.strength
      debug.event('conversation', event, fields)
      if (event === 'interrupt.accept' || event === 'output.resume' || event === 'finish') {
        const stats = this.#transport?.stats
        if (stats) debug.event('audio', 'snapshot', stats)
      }
    } catch {}
  }
}
