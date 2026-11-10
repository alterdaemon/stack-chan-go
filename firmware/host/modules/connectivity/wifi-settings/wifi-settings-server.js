import Resource from 'Resource'
import Base64 from 'base64'
import { PREF_KEYS } from 'consts'
import { HttpServerService, Response } from 'http-server-service'
import { getNetworkConnection } from 'network-manager'
import Preference from 'preference'
import Time from 'time'

// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in Basic Auth passwords.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

/** Compare passwords without stopping at the first differing character. */
function passwordMatches(header, password) {
  if (typeof header !== 'string' || !/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(header)) return false
  try {
    const decoded = String.fromArrayBuffer(Base64.decode(header.slice(6)))
    const separator = decoded.indexOf(':')
    if (separator < 0 || CONTROL_CHARACTERS.test(decoded)) return false
    const supplied = decoded.slice(separator + 1)
    let difference = supplied.length ^ password.length
    for (let index = 0; index < Math.max(supplied.length, password.length); index++) {
      difference |= (supplied.charCodeAt(index) || 0) ^ (password.charCodeAt(index) || 0)
    }
    return difference === 0
  } catch {
    return false
  }
}

export class WiFiSettingsServer {
  #server
  #getPreferences
  #onPreferenceChanged
  #assets
  #setupStarted
  #setupDuration

  constructor({ getPreferences, onPreferenceChanged, setupDurationMs = 0, port = 80 }) {
    this.#getPreferences = getPreferences
    this.#onPreferenceChanged = onPreferenceChanged
    this.#setupStarted = Time.ticks
    this.#setupDuration = setupDurationMs
    this.#assets = JSON.parse(String.fromArrayBuffer(new Resource('wifi-settings-index.dat')))
    this.#server = new HttpServerService({ port, onNotFound: (context) => this.#handle(context) })
  }

  close() {
    this.#setupDuration = 0
    this.#server.close()
  }

  get address() {
    return getNetworkConnection()?.address
  }

  #setupOpen() {
    const elapsed = Time.delta(this.#setupStarted)
    return elapsed >= 0 && elapsed < this.#setupDuration
  }

  async #handle(context) {
    context.header('Cache-Control', 'no-store')
    context.header('X-Frame-Options', 'DENY')
    context.header('X-Content-Type-Options', 'nosniff')
    const password = Preference.get('www', 'password')
    const configured = typeof password === 'string' && password.length > 0
    if (configured) {
      if (!passwordMatches(context.req.header('authorization'), password)) {
        context.header('WWW-Authenticate', 'Basic realm="Stack-chan Settings", charset="UTF-8"')
        return context.text('Authentication required', 401)
      }
    } else if (!this.#setupOpen()) {
      return context.text('Open Settings on the robot to set the WWW password.', 503)
    }

    const path = context.req.path
    if (path === '/api/preferences') {
      if (context.req.method === 'get') {
        const preferences = configured ? this.#getPreferences() : {}
        return context.json(
          PREF_KEYS.map(([domain, key]) => {
            const prop = `${domain}.${key}`
            return {
              prop,
              value: prop === 'www.password' ? '' : (preferences[domain]?.[key] ?? ''),
              readOnly:
                (!configured && prop !== 'www.password') ||
                (prop === 'driver.type' && preferences.driver?.typeLocked === true),
            }
          }),
        )
      }
      if (context.req.method === 'post') return this.#save(context, configured)
      return context.text('Method Not Allowed', 405)
    }

    if (context.req.method !== 'get') return context.text('Not Found', 404)
    if (path === '/' || path === '/settings' || path === '/preference') {
      context.header('Location', '/settings/')
      return context.text('', 302)
    }
    const asset = this.#assets[path]
    if (!asset) return context.text('Not Found', 404)
    // Resource is a read-only ROM buffer. Send slices without copying the whole asset to RAM.
    return new Response(new Resource(asset.resource), {
      headers: {
        'Content-Type': asset.type,
        'Content-Encoding': 'gzip',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }

  async #save(context, configured) {
    // Require a same-origin JSON request; never accept cross-site HTML form submissions.
    const origin = context.req.header('origin')
    const host = context.req.header('host')
    if (
      context.req.header('x-stackchan-settings') !== '1' ||
      !context.req.header('content-type')?.toLowerCase().startsWith('application/json') ||
      (origin && origin !== `http://${host}` && origin !== `https://${host}`)
    ) {
      return context.text('Forbidden', 403)
    }
    let batch
    try {
      batch = (await context.req.json())._batch
    } catch {
      return context.text('Invalid JSON', 400)
    }
    if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return context.text('Invalid batch', 400)
    const preferences = this.#getPreferences()
    const entries = Object.entries(batch)
    // Validate the entire batch before changing anything.
    for (const [prop, value] of entries) {
      const entry = PREF_KEYS.find(([domain, key]) => prop === `${domain}.${key}`)
      if (!entry || typeof value !== 'string') return context.text('Invalid preference', 400)
      if (
        (!configured && prop !== 'www.password') ||
        (prop === 'driver.type' && preferences.driver?.typeLocked === true)
      ) {
        return context.text('Read-only preference', 403)
      }
      if (
        (entry[2] === Number && !Number.isFinite(Number(value))) ||
        (prop === 'tts.volume' && (Number(value) < 0 || Number(value) > 1)) ||
        (prop === 'openailive.backendModel' && !value.trim()) ||
        (prop === 'openailive.reasoningEffort' && !EFFORTS.includes(value)) ||
        (prop === 'openailive.bargeIn' && !['0', '1'].includes(value)) ||
        (prop === 'www.password' && CONTROL_CHARACTERS.test(value))
      ) {
        return context.text('Invalid value', 400)
      }
    }
    if (!configured && (!batch['www.password'] || !this.#setupOpen())) {
      return context.text('WWW password required', 403)
    }
    for (const [prop, value] of entries) {
      if (prop === 'www.password' && value.length === 0) continue
      const [domain, key] = prop.split('.')
      Preference.set(domain, key, value)
      this.#onPreferenceChanged?.(prop, value)
    }
    return context.json({ ok: true })
  }
}
