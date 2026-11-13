// Candidate private Codex Live contract. Native WebRTC remains owned by Conversation.
// Protocol evidence: openai/codex 16e27626 and malhashemi/opencode-gpt-live c23101cf.
const CALL = 'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas'
const BACKEND = 'https://chatgpt.com/backend-api/codex/responses'
export const SUBSCRIPTION_MODEL = 'gpt-live-1-codex'
export const SUBSCRIPTION_BACKEND = 'gpt-6.1-terra'
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)

export function parseSubscriptionCall(response, sdp) {
  if (!response.ok)
    throw Object.assign(new Error('Subscription call rejected'), {
      status: response.status,
      code: 'subscription_http_error',
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
  #events = []
  #seen = []
  #unsubscribe
  #onMessage
  #outputId
  #cleared = false
  #context = []

  constructor({ auth, fetch, openControl, uuid, onLogout, wait = async () => {}, now = Date.now }) {
    Object.assign(this, { auth, fetch, openControl, uuid, wait, now })
    this.#unsubscribe = auth.onLogout(() => {
      this.dispose()
      onLogout?.()
    })
  }

  async create(sdp, options, onMessage, current, onAnswer) {
    this.#onMessage = onMessage
    const credentials = await this.auth.credentials()
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
      this.#request = this.fetch(CALL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sdp,
          session: {
            model: SUBSCRIPTION_MODEL,
            instructions: options.instructions,
            audio: { output: { voice: options.voice } },
            delegation: { type: 'client' },
            ...(options.input ? { initial_items: options.input } : {}),
          },
        }),
      })
      const response = await this.#request
      if (response.status === 401) this.auth.logout()
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
          this.#channel = await this.openControl(
            bootstrap.callId,
            headers,
            (message) => this.#receive(message),
            remaining,
          )
          break
        } catch (error) {
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
    if (message.type === 'turn.done' && typeof message.turn?.transcript === 'string')
      this.#remember(message.turn.role, message.turn.transcript)
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

  async #delegate(delegationId, text) {
    const job = { id: delegationId }
    this.#job = job
    this.#onMessage({ type: 'local.subscription.job.started', id: delegationId })
    try {
      const credentials = await this.auth.credentials()
      if (this.#job !== job || this.#closed) return
      if (credentials.accountId !== this.accountId) throw new Error('Subscription account changed')
      const headers = { ...this.headers, Authorization: `Bearer ${credentials.accessToken}` }
      job.request = this.fetch(BACKEND, {
        method: 'POST',
        headers,
        responseFormat: 'subscription-response',
        timeoutMs: 45000,
        body: JSON.stringify({
          model: SUBSCRIPTION_BACKEND,
          instructions: `${this.options.instructions}\nAnswer the delegated question briefly and naturally in its language. Use web search for current facts and cite sources when used.`,
          input: [
            ...this.#context.map((item) => ({
              role: item.role,
              content: [{ type: item.role === 'user' ? 'input_text' : 'output_text', text: item.text }],
            })),
            { role: 'user', content: [{ type: 'input_text', text }] },
          ],
          tools: [{ type: 'web_search' }],
          tool_choice: 'auto',
          store: false,
          stream: true,
        }),
      })
      const response = await job.request
      if (response.status === 401) this.auth.logout()
      if (!response.ok) throw new Error('Subscription backend rejected')
      const result = JSON.parse(await response.text())
      if (result.error || typeof result.answer !== 'string' || result.answer.length > 3000)
        throw new Error('Subscription answer incomplete')
      if (this.#job !== job || this.#closed) return
      const answer =
        result.answer + (result.searched ? '\nSources: ' + result.sources.map((source) => source.url).join(' ') : '')
      for (const event of subscriptionAppends(answer, delegationId)) this.#channel.send(event)
    } catch {
      if (this.#job === job && !this.#closed)
        for (const event of subscriptionAppends('I could not complete that request. Please try again.', delegationId))
          this.#channel.send(event)
    } finally {
      if (this.#job === job) {
        this.#job = undefined
        this.#onMessage({ type: 'local.subscription.job.finished', id: delegationId })
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
    const job = this.#job
    this.#job = undefined
    job?.request?.cancel?.()
    if (job) this.#onMessage?.({ type: 'local.subscription.job.finished', id: job.id })
  }

  send(event) {
    this.#channel?.send(event)
  }
  dispose() {
    this.#closed = true
    this.cancelJob()
    this.#request?.cancel?.()
    this.#channel?.close()
    this.#events = []
    this.#context = []
    this.headers = undefined
    this.#unsubscribe?.()
  }
}
