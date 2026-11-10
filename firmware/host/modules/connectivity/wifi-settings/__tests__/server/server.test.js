import Resource from 'Resource'
import TCP from 'embedded:io/socket/tcp'
import Base64 from 'base64'
import Preference from 'preference'
import { assert, equal } from 'testing/assert'
import Timer from 'timer'
import { WiFiSettingsServer } from 'wifi-settings-server'

const port = 18085
const defaults = {
  wifi: { ssid: 'saved-network', password: 'wifi-secret' },
  driver: { type: 'm5stackchan', typeLocked: true },
  openailive: { backendModel: 'firmware-model', reasoningEffort: 'medium' },
}
function getPreferences() {
  return {
    ...defaults,
    openailive: {
      backendModel: Preference.get('openailive', 'backendModel') ?? defaults.openailive.backendModel,
      reasoningEffort: Preference.get('openailive', 'reasoningEffort') ?? defaults.openailive.reasoningEffort,
    },
  }
}
const auth = (password, username = 'anything') => `Basic ${Base64.encode(`${username}:${password}`)}`

/** Exercise the real HTTP server and ROM resource writer over a TCP connection. */
function request(path, { body, authorization, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body)
    const payload = ArrayBuffer.fromString(text)
    const method = body === undefined ? 'GET' : 'POST'
    const lines = [`${method} ${path} HTTP/1.1`, `Host: localhost:${port}`, `Content-Length: ${payload.byteLength}`]
    if (authorization !== undefined) lines.push(`Authorization: ${authorization}`)
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
    const packet = ArrayBuffer.fromString(`${lines.join('\r\n')}\r\n\r\n${text}`)
    let offset = 0
    let received = new Uint8Array(0)
    let timeout
    const socket = new TCP({
      address: '127.0.0.1',
      port,
      onWritable(count) {
        const size = Math.min(count, packet.byteLength - offset)
        if (size <= 0) return
        const chunk = new DataView(packet, offset, size)
        offset += size
        this.write(chunk)
      },
      onReadable(count) {
        try {
          const chunk = new Uint8Array(this.read(count))
          const next = new Uint8Array(received.length + chunk.length)
          next.set(received)
          next.set(chunk, received.length)
          received = next
          let end = -1
          for (let i = 0; i + 3 < received.length; i++) {
            if (received[i] === 13 && received[i + 1] === 10 && received[i + 2] === 13 && received[i + 3] === 10) {
              end = i
              break
            }
          }
          if (end < 0) return
          const header = String.fromArrayBuffer(received.slice(0, end).buffer).toLowerCase()
          const length = Number(/content-length: (\d+)/.exec(header)?.[1])
          if (!Number.isFinite(length)) throw new Error('missing content length')
          if (received.length < end + 4 + length) return
          Timer.clear(timeout)
          this.close()
          resolve({
            status: Number(header.split(' ')[1]),
            header,
            body: received.slice(end + 4, end + 4 + length).buffer,
          })
        } catch (error) {
          Timer.clear(timeout)
          this.close()
          reject(error)
        }
      },
      onError() {
        Timer.clear(timeout)
        this.close()
        reject(new Error('HTTP connection failed'))
      },
    })
    timeout = Timer.set(() => {
      socket.close()
      reject(new Error('HTTP request timed out'))
    }, 3000)
  })
}
const jsonHeaders = { 'Content-Type': 'application/json', 'X-Stackchan-Settings': '1' }
const save = (batch, authorization, headers = jsonHeaders) =>
  request('/api/preferences', {
    body: { _batch: batch },
    authorization,
    headers,
  })
const values = (response) => JSON.parse(String.fromArrayBuffer(response.body))

let server
try {
  server = new WiFiSettingsServer({ port, getPreferences })
  equal((await request('/settings/')).status, 503, 'no password must fail closed outside physical setup')
  equal((await request('/api/preferences')).status, 503)
  equal(
    (
      await request('/api/preferences', {
        headers: {
          'User-Agent': 'Browser/'.repeat(40),
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'.repeat(4),
        },
      })
    ).status,
    503,
    'browser-sized headers must reach the handler',
  )
  for (const length of [120, 256, 1024, 4096]) {
    equal((await request('/api/preferences', { headers: { 'User-Agent': 'A'.repeat(length) } })).status, 503)
  }
  let oversizedRejected = false
  try {
    await request('/api/preferences', { headers: { 'User-Agent': 'A'.repeat(8192) } })
  } catch {
    oversizedRejected = true
  }
  assert(oversizedRejected, 'oversized header must close its connection')
  equal((await request('/api/preferences')).status, 503, 'server must remain usable after an oversized header')
  server.close()
  server = new WiFiSettingsServer({ port, getPreferences, setupDurationMs: 1000 })
  equal(server.address, '192.0.2.10')
  const bootstrap = await request('/api/preferences')
  equal(bootstrap.status, 200)
  const initial = values(bootstrap)
  assert(
    initial.every((value) => value.value === ''),
    'bootstrap must never reveal saved preferences',
  )
  assert(initial.every((value) => value.readOnly === (value.prop !== 'www.password')))
  equal((await save({ 'ai.token': 'must-not-save' })).status, 403)
  equal(Preference.get('ai', 'token'), undefined)
  Timer.delay(1100)
  equal((await save({ 'www.password': 'too-late' })).status, 503, 'initial setup window expires')
  server.close()
  server = new WiFiSettingsServer({ port, getPreferences, setupDurationMs: 300000 })
  equal((await save({ 'www.password': 'first-secret' }, undefined, {})).status, 403, 'reject form/CSRF writes')
  equal((await save({ 'www.password': 'first-secret' })).status, 200)
  equal((await request('/api/preferences')).status, 401)
  equal((await request('/settings/')).status, 401, 'HTML is authenticated too')
  const incorrect = await request('/api/preferences', { authorization: auth('wrong') })
  equal(incorrect.status, 401)
  assert(incorrect.header.includes('www-authenticate: basic'))
  for (const invalid of ['Bearer first-secret', 'Basic !!!!', 'Basic YQ==']) {
    equal((await request('/api/preferences', { authorization: invalid })).status, 401)
  }
  const authorization = auth('first-secret', 'different-login')
  const loaded = await request('/api/preferences', { authorization })
  equal(loaded.status, 200, 'any login with the correct password is accepted')
  const loadedValues = values(loaded)
  equal(loadedValues.find((value) => value.prop === 'openailive.backendModel').value, 'firmware-model')
  equal(loadedValues.find((value) => value.prop === 'driver.type').readOnly, true)
  equal(loadedValues.find((value) => value.prop === 'www.password').value, '')
  assert(!String.fromArrayBuffer(loaded.body).includes('first-secret'), 'never return the WWW password')
  equal((await request('/', { authorization })).status, 302)
  const page = await request('/settings/', { authorization })
  equal(page.status, 200)
  assert(page.header.includes('content-encoding: gzip'))
  const index = JSON.parse(String.fromArrayBuffer(new Resource('wifi-settings-index.dat')))
  const expected = new Uint8Array(new Resource(index['/settings/'].resource))
  const actual = new Uint8Array(page.body)
  equal(actual.length, expected.length)
  assert(
    actual.every((value, index) => value === expected[index]),
    'ROM resource must arrive byte-for-byte',
  )
  const assetPath = Object.keys(index).find((path) => path.endsWith('.js'))
  equal((await request(assetPath)).status, 401, 'assets require authentication')
  equal((await request(assetPath, { authorization })).status, 200, 'ROM assets stream successfully')
  equal(
    (await save({ 'openailive.backendModel': 'saved-model', 'openailive.reasoningEffort': 'high' }, authorization))
      .status,
    200,
  )
  equal(Preference.get('openailive', 'backendModel'), 'saved-model')
  equal((await save({ 'ai.token': 'must-not-save', 'driver.type': 'none' }, authorization)).status, 403)
  equal(Preference.get('ai', 'token'), undefined, 'invalid batch must not be partially saved')
  equal((await save({ 'openailive.reasoningEffort': 'invalid' }, authorization)).status, 400)
  equal((await save({ 'other.token': 'invalid' }, authorization)).status, 400)
  equal((await save({ 'tts.volume': 'NaN' }, authorization)).status, 400)
  equal((await save({ 'www.password': '' }, authorization)).status, 200)
  equal(Preference.get('www', 'password'), 'first-secret', 'blank password preserves existing credentials')
  equal(
    (
      await save({ 'www.password': 'new:secret' }, authorization, {
        ...jsonHeaders,
        Origin: 'http://elsewhere.example',
      })
    ).status,
    403,
  )
  equal((await save({ 'www.password': 'new:secret' }, authorization)).status, 200)
  equal((await request('/api/preferences', { authorization })).status, 401, 'old password stops working')
  equal((await request('/api/preferences', { authorization: auth('new:secret') })).status, 200)
  server.close()
  server = new WiFiSettingsServer({ port, getPreferences })
  equal(
    (await request('/api/preferences', { authorization: auth('new:secret') })).status,
    200,
    'credentials survive service restart',
  )
  trace('@@STACKCHAN_TEST:PASS@@\n')
} catch (error) {
  trace(`@@STACKCHAN_TEST:FAIL@@ ${error}\n`)
} finally {
  server?.close()
}
