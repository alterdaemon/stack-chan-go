// Robot-owned device authorization. Tokens never enter ordinary preferences or UI responses.
const ISSUER = 'https://auth.openai.com'
const CLIENT = 'app_EMoamEEZ73f0CkXaXp7hrann'
const LIMIT = 16384
const valid = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= LIMIT && !/[\r\n\0]/.test(value)
const form = (values) =>
  Object.entries(values)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')

export class SubscriptionAuth {
  #record
  #attempt
  #generation = 0
  #renewal
  #state = 'signed-out'
  #listeners = new Set()

  constructor({ fetch, schedule, cancel, decodeClaims, now = Date.now, clientId = CLIENT }) {
    Object.assign(this, { fetch, schedule, cancel, decodeClaims, now, clientId })
  }

  status() {
    const attempt = this.#attempt
    return {
      state: this.#state,
      signedIn: !!this.#record,
      account: this.#record?.label,
      volatile: true,
      ...(attempt?.code ? { url: `${ISSUER}/codex/device`, code: attempt.code, expiresAt: attempt.expiresAt } : {}),
    }
  }

  onLogout(callback) {
    this.#listeners.add(callback)
    return () => this.#listeners.delete(callback)
  }

  async #post(path, data, operation, encoded = false) {
    const request = this.fetch(`${ISSUER}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': encoded ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: encoded ? form(data) : JSON.stringify(data),
      timeoutMs: 30000,
    })
    operation.request = request
    const response = await request
    operation.request = undefined
    // Never follow redirects or expose provider error bodies (which may contain secrets).
    if (!response.ok) return { status: response.status }
    const text = await response.text()
    if (text.length > LIMIT * 3) throw new Error('Authorization response exceeds limit')
    return { status: response.status, value: JSON.parse(text) }
  }

  async start() {
    if (this.#record || this.#attempt || this.#renewal) return this.status()
    const attempt = { generation: this.#generation, expiresAt: this.now() + 900000 }
    this.#attempt = attempt
    this.#state = 'authorizing'
    attempt.expiry = this.schedule(() => this.#finishAttempt(attempt, 'expired'), 900000)
    try {
      const response = await this.#post('/api/accounts/deviceauth/usercode', { client_id: this.clientId }, attempt)
      if (this.#attempt !== attempt) return this.status()
      const value = response.value
      const code = value?.user_code ?? value?.usercode
      const interval = Number(value?.interval)
      if (
        !valid(value?.device_auth_id) ||
        !valid(code) ||
        code.length > 64 ||
        !Number.isFinite(interval) ||
        interval < 1 ||
        interval > 900
      )
        throw new Error('Invalid authorization challenge')
      Object.assign(attempt, { deviceId: value.device_auth_id, code, interval: interval * 1000 })
      this.#state = 'pending'
      attempt.timer = this.schedule(() => void this.#poll(attempt), attempt.interval)
    } catch {
      this.#finishAttempt(attempt, 'error')
    }
    return this.status()
  }

  async #poll(attempt) {
    if (this.#attempt !== attempt) return
    attempt.timer = undefined
    try {
      const response = await this.#post(
        '/api/accounts/deviceauth/token',
        { device_auth_id: attempt.deviceId, user_code: attempt.code },
        attempt,
      )
      if (this.#attempt !== attempt) return
      if ([403, 404].includes(response.status)) {
        const remaining = attempt.expiresAt - this.now()
        if (remaining <= 0) return this.#finishAttempt(attempt, 'expired')
        attempt.timer = this.schedule(() => void this.#poll(attempt), Math.min(attempt.interval, remaining))
        return
      }
      const value = response.value
      if (!valid(value?.authorization_code) || !valid(value?.code_verifier)) throw new Error('Authorization denied')
      const tokens = await this.#post(
        '/oauth/token',
        {
          grant_type: 'authorization_code',
          client_id: this.clientId,
          redirect_uri: `${ISSUER}/deviceauth/callback`,
          code: value.authorization_code,
          code_verifier: value.code_verifier,
        },
        attempt,
        true,
      )
      if (this.#attempt !== attempt) return
      await this.#install(tokens.value, attempt.generation)
      this.#finishAttempt(attempt, 'signed-in')
    } catch {
      this.#finishAttempt(attempt, 'error')
    }
  }

  async #install(tokens, generation, previous) {
    if (!valid(tokens?.access_token) || !valid(tokens.refresh_token ?? previous?.refreshToken))
      throw new Error('Invalid subscription grant')
    // Claims come only from this robot's pinned, certificate-verified token exchange,
    // never from a browser-supplied JWT or the ordinary preference API.
    const identity = this.decodeClaims(tokens.id_token ?? tokens.access_token)
    const access = this.decodeClaims(tokens.access_token)
    const binding = identity['https://api.openai.com/auth'] ?? access['https://api.openai.com/auth']
    const accountId = binding?.chatgpt_account_id
    const accessAccount = access['https://api.openai.com/auth']?.chatgpt_account_id
    const audience = identity.aud
    if (
      access.iss !== ISSUER ||
      (accessAccount && accessAccount !== accountId) ||
      (audience && !(Array.isArray(audience) ? audience : [audience]).includes(this.clientId)) ||
      (identity.exp !== undefined && Number(identity.exp) * 1000 <= this.now())
    )
      throw new Error('Invalid subscription binding')
    const subject = identity.sub
    const client = access.client_id ?? access.azp
    const expiresAt = Math.min(
      tokens.expires_in === undefined ? Infinity : this.now() + Number(tokens.expires_in) * 1000,
      Number(access.exp) * 1000,
    )
    if (
      identity.iss !== ISSUER ||
      !valid(subject) ||
      subject.length > 256 ||
      !valid(accountId) ||
      accountId.length > 256 ||
      (client && client !== this.clientId) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.now()
    )
      throw new Error('Invalid subscription identity')
    if (previous && (previous.subject !== subject || previous.accountId !== accountId))
      throw new Error('Subscription identity changed')
    const record = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? previous?.refreshToken,
      accountId,
      subject,
      expiresAt,
      clientId: this.clientId,
      label: typeof identity.email === 'string' ? identity.email.slice(0, 160) : 'ChatGPT account',
    }
    if (generation !== this.#generation) throw new Error('Authorization cancelled')
    this.#record = record
  }

  #finishAttempt(attempt, state) {
    if (this.#attempt !== attempt) return
    if (state !== 'signed-in') this.#generation++
    if (attempt.timer !== undefined) this.cancel(attempt.timer)
    if (attempt.expiry !== undefined) this.cancel(attempt.expiry)
    attempt.request?.cancel?.()
    this.#attempt = undefined
    this.#state = this.#record ? 'signed-in' : state
  }

  cancelSignIn() {
    if (this.#attempt) this.#finishAttempt(this.#attempt, 'signed-out')
    return this.status()
  }

  async credentials() {
    if (this.#renewal) return this.#renewal.promise
    const record = this.#record
    if (!record)
      throw Object.assign(new Error('Subscription sign-in required'), { code: 'subscription_sign_in_required' })
    if (record.expiresAt > this.now() + 60000) return { accessToken: record.accessToken, accountId: record.accountId }
    const operation = { generation: this.#generation }
    this.#renewal = operation
    operation.promise = (async () => {
      try {
        const response = await this.#post(
          '/oauth/token',
          { grant_type: 'refresh_token', refresh_token: record.refreshToken, client_id: record.clientId },
          operation,
          true,
        )
        await this.#install(response.value, operation.generation, record)
        return { accessToken: this.#record.accessToken, accountId: this.#record.accountId }
      } catch {
        if (operation.generation === this.#generation) this.logout()
        throw Object.assign(new Error('Subscription sign-in required'), { code: 'subscription_sign_in_required' })
      } finally {
        if (this.#renewal === operation) this.#renewal = undefined
      }
    })()
    return operation.promise
  }

  logout() {
    this.#generation++
    this.cancelSignIn()
    this.#renewal?.request?.cancel?.()
    this.#record = undefined
    this.#state = 'signed-out'
    for (const callback of this.#listeners) {
      try {
        callback()
      } catch {}
    }
    return this.status()
  }
}
