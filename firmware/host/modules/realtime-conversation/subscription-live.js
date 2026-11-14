import { subscriptionErrorMetadata } from './subscription-stream.js'

export { subscriptionErrorMetadata } from './subscription-stream.js'

// Candidate private Codex Live contract. Native WebRTC remains owned by Conversation.
// Protocol evidence: openai/codex 16e27626 and malhashemi/opencode-gpt-live c23101cf.
const CALL = 'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas'
const BACKEND = 'https://chatgpt.com/backend-api/codex/responses'
export const SUBSCRIPTION_MODEL = 'gpt-live-1.1-codex'
export const SUBSCRIPTION_BACKEND = 'gpt-6.1-terra'
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)

// Only an already-readable, bounded HTTP rejection tail; no extra request or
// wait, and no raw headers/body leave the adapter. HTTP framing follows RFC9112.
export function subscriptionUpgradeError(tail) {
  if (typeof tail !== 'string' || tail.length > 4096) return {}
  const split = tail.indexOf('\r\n\r\n')
  if (split < 0) return {}
  const headers = tail.slice(0, split)
  const body = tail.slice(split + 4)
  if (/^transfer-encoding:\s*chunked\s*$/im.test(headers)) {
    let decoded = ''
    for (let at = 0; at < body.length; ) {
      const end = body.indexOf('\r\n', at)
      if (end < 0 || !/^[0-9a-f]+(?:;[^\r\n]*)?$/i.test(body.slice(at, end))) return {}
      const size = Number.parseInt(body.slice(at, end), 16)
      if (!size) return subscriptionErrorMetadata(decoded)
      at = end + 2
      if (size > body.length - at || body.slice(at + size, at + size + 2) !== '\r\n') return {}
      decoded += body.slice(at, at + size)
      at += size + 2
    }
    return {}
  }
  const length = /^content-length:\s*(\d+)\s*$/im.exec(headers)
  if (length && Number(length[1]) !== body.length) return {}
  return subscriptionErrorMetadata(body)
}

// Diagnostic capabilities only. Never return ICE addresses/credentials, SDP,
// fingerprints, call IDs or provider text from this observer.
export function subscriptionSdpMetadata(sdp) {
  const audio = /^m=audio ([0-9]{1,5}) /m.exec(sdp)
  const application = /^m=application ([0-9]{1,5}) /m.exec(sdp)
  const opus = /^a=rtpmap:[0-9]+ opus\/([0-9]{1,6})(?:\/([0-9]{1,2}))?\r?$/im.exec(sdp)
  const mediaStart = sdp.indexOf('\nm=')
  const session = mediaStart < 0 ? sdp : sdp.slice(0, mediaStart)
  const media = mediaStart < 0 ? '' : sdp.slice(mediaStart)
  let ipv4Candidates = 0,
    ipv6Candidates = 0,
    privateCandidates = 0,
    zeroAddressCandidates = 0,
    udpMinPort,
    udpMaxPort,
    tcpMinPort,
    tcpMaxPort
  for (const candidate of sdp.matchAll(/^a=candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+)/gm)) {
    const [, protocol, address, rawPort] = candidate
    if (address.includes(':')) ipv6Candidates++
    else if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
      ipv4Candidates++
      const octets = address.split('.').map(Number)
      if (
        octets[0] === 10 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168)
      )
        privateCandidates++
      if (octets.every((part) => part === 0)) zeroAddressCandidates++
    }
    const port = Number(rawPort)
    if (port >= 0 && port <= 65535) {
      if (protocol.toLowerCase() === 'udp') {
        udpMinPort = Math.min(udpMinPort ?? port, port)
        udpMaxPort = Math.max(udpMaxPort ?? port, port)
      } else if (protocol.toLowerCase() === 'tcp') {
        tcpMinPort = Math.min(tcpMinPort ?? port, port)
        tcpMaxPort = Math.max(tcpMaxPort ?? port, port)
      }
    }
  }
  return {
    audioPort: audio ? Number(audio[1]) : undefined,
    applicationPort: application ? Number(application[1]) : undefined,
    udpCandidates: (sdp.match(/^a=candidate:\S+ [0-9]+ udp /gim) ?? []).length,
    tcpCandidates: (sdp.match(/^a=candidate:\S+ [0-9]+ tcp /gim) ?? []).length,
    dtlsRole: /^a=setup:(active|passive|actpass)\r?$/m.exec(sdp)?.[1],
    iceLite: /^a=ice-lite\r?$/m.test(sdp),
    opusRate: opus ? Number(opus[1]) : undefined,
    opusChannels: opus?.[2] ? Number(opus[2]) : undefined,
    iceUfragLength: /^a=ice-ufrag:([^\r\n]*)/m.exec(sdp)?.[1].length ?? 0,
    icePasswordLength: /^a=ice-pwd:([^\r\n]*)/m.exec(sdp)?.[1].length ?? 0,
    iceSessionAttributes: (session.match(/^a=ice-(?:ufrag|pwd):/gm) ?? []).length,
    iceMediaAttributes: (media.match(/^a=ice-(?:ufrag|pwd):/gm) ?? []).length,
    ipv4Candidates,
    ipv6Candidates,
    privateCandidates,
    zeroAddressCandidates,
    udpMinPort,
    udpMaxPort,
    tcpMinPort,
    tcpMaxPort,
  }
}

export function parseSubscriptionCall(response, sdp) {
  if (!response.ok)
    throw Object.assign(new Error('Subscription call rejected'), {
      status: response.status,
      code: 'subscription_http_error',
      ...subscriptionErrorMetadata(sdp),
    })
  const headers = response.headers ?? {}
  const location = response.location ?? headers.location
  let callId
  if (typeof location === 'string') {
    if (!/^(?:https:\/\/(?:api\.openai\.com|chatgpt\.com))?\/(?!\/)/.test(location))
      throw Object.assign(new Error('Invalid subscription call origin'), { code: 'subscription_invalid_call' })
    callId = location
      .split('?')[0]
      .split('/')
      .reverse()
      .find((part) => /^(?:rtc_[A-Za-z0-9_-]+|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.test(part))
  }
  if (!id(callId) || !/^(?:rtc_|[a-f0-9]{8}-)/i.test(callId))
    throw Object.assign(new Error('Missing subscription call identity'), { code: 'subscription_invalid_call' })
  if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > 65536)
    throw Object.assign(new Error('Invalid subscription SDP'), { code: 'subscription_invalid_sdp', callId })
  return { callId, sdp }
}

export function subscriptionAppends(text, delegationId) {
  const messages = []
  let part = '',
    size = 0
  const emit = () => {
    if (!part) return
    messages.push({
      type: 'delegation.context.append',
      delegation_item_id: delegationId,
      channel: 'speakable',
      content: [{ type: 'input_text', text: part }],
    })
    part = ''
    size = 0
  }
  for (const character of text) {
    const point = character.codePointAt(0)
    const bytes = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (size + bytes > 500) emit()
    part += character
    size += bytes
  }
  emit()
  return messages
}

export class SubscriptionLive {
  #channel
  #request
  #job
  #closed = false
  #active = false
  #ready = false
  #events = []
  #seen = []
  #unsubscribe
  #onMessage
  #outputId
  #cleared = false
  #context = []
  #probes

  constructor({
    auth,
    fetch,
    openControl,
    uuid,
    onLogout,
    wait = async () => {},
    now = Date.now,
    diagnose,
    debug,
    createProbes,
  }) {
    Object.assign(this, { auth, fetch, openControl, uuid, wait, now, diagnose, debug, createProbes })
    this.#unsubscribe = auth.onLogout(() => {
      this.dispose()
      onLogout?.()
    })
  }

  async create(sdp, options, onMessage, current, onAnswer) {
    this.#onMessage = onMessage
    this.diagnose?.('auth.start')
    const credentials = await this.auth.credentials()
    this.diagnose?.('auth.ready')
    if (this.#closed || !current()) throw new Error('Subscription start cancelled')
    let stage = 'bootstrap'
    try {
      const headers = {
        Authorization: `Bearer ${credentials.accessToken}`,
        'ChatGPT-Account-ID': credentials.accountId,
        'OpenAI-Alpha': 'quicksilver=v2',
        'session-id': this.uuid(),
        'thread-id': this.uuid(),
        'x-session-id': this.uuid(),
        'User-Agent': 'stack-chan-go/2.1.0-R5',
        'Content-Type': 'application/json',
      }
      this.options = options
      for (const item of options.input ?? []) {
        const text = (item.content ?? []).map((part) => part.text ?? '').join('')
        this.#remember(item.role, text)
      }
      this.headers = headers
      this.accountId = credentials.accountId
      this.diagnose?.('call.offer', () => subscriptionSdpMetadata(sdp))
      this.diagnose?.('call.start')
      const session = {
        model: SUBSCRIPTION_MODEL,
        instructions: options.instructions,
        audio: { output: { voice: options.voice } },
        delegation: { type: 'client' },
        ...(options.input ? { initial_items: options.input } : {}),
      }
      this.diagnose?.('call.session', () => ({
        model: session.model,
        voice: session.audio.output.voice,
        instructionsLength: (session.instructions ?? '').length,
        initialItems: session.initial_items?.length ?? 0,
      }))
      this.#request = this.fetch(CALL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sdp,
          session,
        }),
      })
      const response = await this.#request
      // Resource rejection does not prove refresh-grant revocation (RFC6750 section3.1).
      // The auth owner handles renewal failure; resource errors never delete the grant.
      this.diagnose?.('call.response', () => ({
        status: response.status,
        locationPresent: typeof (response.location ?? response.headers?.location) === 'string',
        sessionHeaderPresent: typeof response.headers?.['openai-session-id'] === 'string',
      }))
      let bootstrap
      try {
        bootstrap = parseSubscriptionCall(response, await response.text())
      } catch (error) {
        if (error.callId) {
          try {
            const orphan = await this.openControl(error.callId, headers, () => {})
            try {
              orphan.send({ type: 'session.close' })
            } finally {
              orphan.close()
            }
          } catch {}
        }
        throw error
      }
      this.#request = undefined
      this.diagnose?.('call.answer', () => ({ status: response.status, ...subscriptionSdpMetadata(bootstrap.sdp) }))
      // ICE activation must progress while the control socket joins the call.
      // Conversation keeps capture muted until the control session is ready.
      if (!this.#closed && current()) onAnswer?.(bootstrap)
      // Even a late create must acquire a bounded control connection to close the remote call.
      stage = 'control'
      const deadline = this.now() + 15000
      const activationDelays = [100, 300, 800]
      for (let attempt = 0; ; attempt++) {
        const remaining = deadline - this.now()
        if (remaining <= 0)
          throw Object.assign(new Error('Subscription control timed out'), { code: 'subscription_control_timeout' })
        try {
          this.diagnose?.('control.join', () => ({ attempt }))
          this.#channel = await this.openControl(
            bootstrap.callId,
            headers,
            (message) => this.#receive(message),
            remaining,
          )
          break
        } catch (error) {
          this.diagnose?.('control.failed', () => ({
            attempt,
            status: error?.status,
            providerCode: error?.providerCode,
            param: error?.param,
          }))
          // A newly created call may briefly be unavailable until ICE activates.
          // Retry this same call only; never create another call or change auth.
          if (error?.status !== 404 || attempt >= activationDelays.length || this.#closed || !current()) throw error
          await this.wait(Math.min(activationDelays[attempt], Math.max(0, deadline - this.now())))
          if (this.#closed || !current()) throw new Error('Subscription start cancelled')
        }
      }
      if (this.#closed || !current()) {
        this.#channel.send({ type: 'session.close' })
        this.#channel.close()
        throw new Error('Subscription start cancelled')
      }
      return bootstrap
    } catch (error) {
      if (error?.code || error?.message === 'Subscription start cancelled') throw error
      throw Object.assign(new Error('Subscription startup failed'), {
        code: stage === 'control' ? 'subscription_control_failed' : 'subscription_bootstrap_failed',
      })
    }
  }

  activate() {
    this.#active = true
    this.debug?.registerTuner?.(this, {
      set: (name, value) => this.probe(name, value),
      reset: async () => this.cancelJob(),
      snapshot: () => ({}),
    })
    const queued = this.#events
    this.#events = []
    for (const event of queued) this.#receive(event)
  }

  #receive(message) {
    if (this.#closed) return
    if (!this.#active) {
      if (this.#events.length >= 8) throw new Error('Subscription startup event limit')
      this.#events.push(message)
      return
    }
    if (typeof message.event_id === 'string') {
      if (!id(message.event_id)) throw new Error('Invalid subscription event identity')
      if (this.#seen.includes(message.event_id)) return
      this.#seen.push(message.event_id)
      if (this.#seen.length > 16) this.#seen.shift()
    }
    if (message.type === 'session.started') this.#ready = true
    if (message.type === 'turn.done' && typeof message.turn?.transcript === 'string') {
      this.#remember(message.turn.role, message.turn.transcript)
      this.#probes?.output(message.turn)
    }
    if (message.type === 'output_transcript.added' && typeof message.item?.text === 'string') {
      const outputId = id(message.item.id) ? message.item.id : undefined
      if (outputId && outputId === this.#outputId) return
      this.#outputId = outputId
      this.#cleared = false
    }
    if (message.type === 'output_audio_buffer.cleared') {
      const output = message.item_id ?? message.response_id
      if (this.#cleared || (output && output !== this.#outputId)) return
      this.#cleared = true
      this.cancelJob()
    }
    if (message.type === 'delegation.created') {
      const item = message.item
      if (item?.type !== 'delegation' || item.target !== 'client' || !id(item.id))
        throw new Error('Invalid subscription delegation')
      if (this.#job?.id === item.id || this.#seen.includes(item.id)) return
      this.#seen.push(item.id)
      if (this.#seen.length > 16) this.#seen.shift()
      if (this.#job) {
        this.#channel.send({
          type: 'delegation.context.append',
          delegation_item_id: item.id,
          channel: 'commentary',
          content: [{ type: 'input_text', text: 'Another request is in progress.' }],
        })
        return
      }
      const text = (item.content ?? [])
        .filter((part) => part.type === 'input_text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('')
      if (!text.trim() || text.length > 4096) throw new Error('Subscription delegation exceeds limit')
      void this.#delegate(item.id, text).catch(() =>
        this.#onMessage?.({ type: 'error', error: { code: 'subscription_backend_error' } }),
      )
    }
    this.#onMessage(message)
  }

  async probe(name, value) {
    if (!this.debug?.enabled || !this.#ready || this.#closed || this.#job)
      throw Object.assign(new Error('Subscription probe unavailable'), { code: 'not_connected' })
    this.#probes ??= this.createProbes?.({
      send: (message) => this.#channel.send(message),
      delegate: (text, variant) =>
        this.#delegate(this.uuid(), text, variant === 'minimal' ? 'minimal' : variant ? 'rejection' : true),
      diagnose: this.diagnose,
    })
    if (!this.#probes) throw new Error('Subscription diagnostics unavailable')
    return this.#probes.run(name, value)
  }

  async #delegate(delegationId, text, probe = false) {
    const job = { id: delegationId }
    this.#job = job
    this.diagnose?.('backend.start', () => ({
      model: this.options.backendModel ?? SUBSCRIPTION_BACKEND,
      effort: this.options.reasoningEffort ?? 'medium',
      probe: ['rejection', 'minimal'].includes(probe) ? probe : probe ? 'diagnostic' : undefined,
    }))
    this.#onMessage({ type: 'local.subscription.job.started', id: delegationId })
    try {
      const credentials = await this.auth.credentials()
      if (this.#job !== job || this.#closed) return
      if (credentials.accountId !== this.accountId) throw new Error('Subscription account changed')
      const headers = {
        Authorization: `Bearer ${probe === 'rejection' ? 'stackchan-diagnostic-invalid' : credentials.accessToken}`,
        'ChatGPT-Account-ID': credentials.accountId,
        originator: 'stack-chan-go',
        'session-id': this.headers['session-id'],
        'thread-id': this.headers['thread-id'],
        'Content-Type': 'application/json',
        'User-Agent': this.headers['User-Agent'],
        Accept: 'text/event-stream',
      }
      job.request = this.fetch(BACKEND, {
        method: 'POST',
        headers,
        responseFormat: 'subscription-response',
        timeoutMs: probe === 'rejection' ? 15000 : 300000,
        body: JSON.stringify({
          model: this.options.backendModel ?? SUBSCRIPTION_BACKEND,
          ...(probe === 'minimal' ? {} : { reasoning: { effort: this.options.reasoningEffort ?? 'medium' } }),
          instructions:
            probe === 'minimal'
              ? 'Answer briefly.'
              : `${this.options.instructions}\nAnswer the delegated question briefly and naturally in its language. Use web search for current facts and cite sources when used.`,
          input: [
            ...(probe === 'minimal'
              ? []
              : this.#context.map((item) => ({
                  role: item.role,
                  content: [{ type: item.role === 'user' ? 'input_text' : 'output_text', text: item.text }],
                }))),
            { role: 'user', content: [{ type: 'input_text', text }] },
          ],
          ...(probe === 'minimal' ? {} : { tools: [{ type: 'web_search' }], tool_choice: 'auto' }),
          store: false,
          stream: true,
        }),
      })
      const response = await job.request
      this.diagnose?.('backend.response', () => ({ status: response.status }))
      if (!response.ok)
        throw Object.assign(new Error('Subscription backend rejected'), {
          status: response.status,
          ...subscriptionErrorMetadata(await response.text()),
        })
      const result = JSON.parse(await response.text())
      this.diagnose?.('backend.result', () => ({
        accepted: !result.error,
        searched: result.searched === true,
        errorCode: result.error,
        providerCode: result.providerCode,
        param: result.param,
      }))
      if (result.error || typeof result.answer !== 'string' || result.answer.length > 3000)
        throw Object.assign(new Error('Subscription answer incomplete'), {
          errorCode: result.error,
          providerCode: result.providerCode,
          param: result.param,
        })
      if (this.#job !== job || this.#closed) return
      const answer =
        result.answer + (result.searched ? '\nSources: ' + result.sources.map((source) => source.url).join(' ') : '')
      if (probe) return result
      for (const event of subscriptionAppends(answer, delegationId)) this.#channel.send(event)
    } catch (error) {
      this.diagnose?.('backend.failed', () => ({
        status: error?.status,
        errorCode: error?.errorCode,
        phase: error?.phase,
        received: error?.received,
        written: error?.written,
        expected: error?.expected,
        reason: error?.reason,
        code: typeof error?.code === 'number' ? error.code : undefined,
        providerCode: error?.providerCode,
        param: error?.param,
      }))
      if (!probe && this.#job === job && !this.#closed)
        for (const event of subscriptionAppends('I could not complete that request. Please try again.', delegationId))
          this.#channel.send(event)
      if (probe) throw Object.assign(error, { code: 'subscription_backend_error' })
    } finally {
      if (this.#job === job) {
        this.#job = undefined
        this.#onMessage({ type: 'local.subscription.job.finished', id: delegationId })
        this.diagnose?.('backend.finished')
      }
    }
  }

  #remember(role, text) {
    if (!['user', 'assistant'].includes(role) || !text.trim()) return
    this.#context.push({ role, text: text.slice(-2048) })
    while (this.#context.length > 6 || this.#context.reduce((count, item) => count + item.text.length, 0) > 2048)
      this.#context.shift()
  }

  cancelJob() {
    this.#probes?.reset()
    const job = this.#job
    this.#job = undefined
    job?.request?.cancel?.()
    if (job) this.diagnose?.('backend.cancelled')
    if (job) this.#onMessage?.({ type: 'local.subscription.job.finished', id: job.id })
  }

  send(event) {
    this.#channel?.send(event)
  }
  dispose() {
    this.#closed = true
    this.#ready = false
    this.#probes?.reset()
    this.debug?.unregisterTuner?.(this)
    this.cancelJob()
    this.#probes = undefined
    this.#request?.cancel?.()
    this.#channel?.close()
    this.#events = []
    this.#context = []
    this.headers = undefined
    this.#unsubscribe?.()
  }
}
