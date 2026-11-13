import assert from 'node:assert/strict'
import test from 'node:test'
import { SubscriptionAuth } from '../subscription-auth.js'
import {
  parseSubscriptionCall,
  SubscriptionLive,
  subscriptionAppends,
  subscriptionErrorMetadata,
  subscriptionSdpMetadata,
  subscriptionUpgradeError,
} from '../subscription-live.js'
import { createSubscriptionStream } from '../subscription-stream.js'

const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
const reply = (value, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(value),
})
function authFixture(store, diagnose) {
  const timers = new Map(),
    requests = []
  let sequence = 0,
    now = 1000000
  const claims = {
    iss: 'https://auth.openai.com',
    sub: 'person',
    exp: 2000,
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    'https://api.openai.com/auth': { chatgpt_account_id: 'account' },
    email: 'person@example.test',
  }
  let respond = async (url) =>
    url.endsWith('/usercode')
      ? reply({ device_auth_id: 'device-private', user_code: 'ABCD-EFGH', interval: '2' })
      : url.endsWith('/deviceauth/token')
        ? reply({ authorization_code: 'private-code', code_verifier: 'private-verifier' })
        : reply({
            access_token: 'access-secret',
            refresh_token: 'refresh-secret',
            id_token: 'id-secret',
            expires_in: 1000,
          })
  const create = () =>
    new SubscriptionAuth({
      store,
      diagnose,
      fetch: (url, options) => {
        requests.push({ url, options })
        return respond(url, options)
      },
      schedule: (callback, delay) => {
        const id = ++sequence
        timers.set(id, { callback, delay })
        return id
      },
      cancel: (id) => timers.delete(id),
      now: () => now,
      decodeClaims: () => claims,
    })
  const auth = create()
  return {
    auth,
    restart: create,
    requests,
    timers,
    claims,
    respond: (fn) => {
      respond = fn
    },
    time: (value) => {
      now = value
    },
    async poll() {
      const entry = [...timers].find(([, x]) => x.delay === 2000)
      assert.ok(entry)
      timers.delete(entry[0])
      entry[1].callback()
      await tick()
    },
  }
}

function savedStore() {
  let disk
  return {
    events: [],
    available: () => true,
    read: () => (disk === undefined ? undefined : structuredClone(disk)),
    write(value) {
      this.events.push('write')
      if (this.failWrite) throw new Error('synthetic secret storage error')
      disk = structuredClone(value)
    },
    clear() {
      this.events.push('clear')
      if (this.failClear) throw new Error('synthetic secret storage error')
      disk = undefined
    },
  }
}

test('authorization diagnostics identify storage, renewal and cached access without credential content', async () => {
  const logs = []
  const f = authFixture(savedStore(), (event, fields) =>
    logs.push({ event, ...(typeof fields === 'function' ? fields() : fields) }),
  )
  await f.auth.start()
  await f.poll()
  const reboot = f.restart()
  await reboot.credentials()
  await reboot.credentials()
  assert.ok(logs.some((e) => e.event === 'storage.loaded'))
  assert.ok(logs.some((e) => e.event === 'request.start' && e.kind === 'refresh'))
  assert.ok(logs.some((e) => e.event === 'request.response' && e.kind === 'refresh' && e.status === 200))
  assert.ok(logs.some((e) => e.event === 'refresh.complete'))
  assert.ok(logs.some((e) => e.event === 'access.cached'))
  f.time(1950000)
  f.respond(async () => {
    throw new Error('synthetic-sensitive-response')
  })
  await assert.rejects(reboot.credentials(), { code: 'subscription_sign_in_required' })
  assert.ok(logs.some((e) => e.event === 'refresh.failed' && e.phase === 'exchange'))
  const serialized = JSON.stringify(logs)
  for (const privateValue of ['secret', 'person', 'account', 'private', 'ABCD', 'synthetic-sensitive'])
    assert.ok(!serialized.includes(privateValue))
})

test('protected sign-in persists only the refresh credential and bound identity; reboot renews once', async () => {
  const store = savedStore()
  const f = authFixture(store)
  await f.auth.start()
  await f.poll()
  assert.equal(f.auth.status().volatile, false)
  assert.equal(store.read().refreshToken, 'refresh-secret')
  assert.deepEqual(Object.keys(store.read()).sort(), [
    'accountId',
    'clientId',
    'issuer',
    'label',
    'refreshToken',
    'subject',
    'version',
  ])
  assert.ok(!JSON.stringify(store.read()).includes('access-secret'))
  assert.ok(!JSON.stringify(store.read()).includes('id-secret'))
  const rebooted = f.restart()
  assert.equal(rebooted.status().signedIn, true)
  const before = f.requests.length
  const a = rebooted.credentials(),
    b = rebooted.credentials()
  assert.equal(store.read(), undefined, 'invalidate saved refresh token before using it')
  assert.deepEqual(await a, await b)
  assert.equal(f.requests.length, before + 1)
  assert.deepEqual(store.events, ['write', 'clear', 'write'])
  assert.equal(store.read().accountId, 'account')
  rebooted.logout()
  assert.equal(f.restart().status().signedIn, false)
})

test('power loss during rotation yields reauthorization, then a complete new credential after commit', async () => {
  const store = savedStore(),
    f = authFixture(store)
  await f.auth.start()
  await f.poll()
  let finish
  f.respond(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const rebooted = f.restart(),
    renewal = rebooted.credentials()
  assert.equal(f.restart().status().signedIn, false)
  finish(reply({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 1000 }))
  await renewal
  assert.equal(store.read().refreshToken, 'rotated-refresh')
  assert.equal(f.restart().status().signedIn, true)
  assert.equal(store.read().accessToken, undefined)
})

test('logout racing rotation cannot restore a credential in RAM or storage after reboot', async () => {
  const store = savedStore(),
    f = authFixture(store)
  await f.auth.start()
  await f.poll()
  let finish
  f.respond(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const rebooted = f.restart(),
    renewal = rebooted.credentials()
  rebooted.logout()
  finish(reply({ access_token: 'late-access', refresh_token: 'late-refresh' }))
  await assert.rejects(renewal, { code: 'subscription_sign_in_required' })
  assert.equal(store.read(), undefined)
  assert.equal(rebooted.status().signedIn, false)
  assert.equal(f.restart().status().signedIn, false)
})

test('Stop during independent renewal preserves its committed grant without starting a call', async () => {
  const store = savedStore(),
    f = authFixture(store)
  await f.auth.start()
  await f.poll()
  let finish,
    calls = 0
  f.respond(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const auth = f.restart()
  const live = new SubscriptionLive({
    auth,
    fetch: () => {
      calls++
      throw new Error('A stopped session cannot create a call')
    },
    uuid: () => 'fixture',
  })
  const starting = live.create(
    'v=0',
    {},
    () => {},
    () => true,
  )
  live.dispose()
  finish(reply({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 1000 }))
  await assert.rejects(starting, /cancelled/)
  assert.equal(calls, 0)
  assert.equal(store.read().refreshToken, 'new-refresh')
  assert.equal(f.restart().status().signedIn, true)
})

test('unavailable hardware refuses authorization without a plaintext or volatile fallback', async () => {
  const f = authFixture({ available: () => false })
  assert.equal((await f.auth.start()).state, 'storage-unavailable')
  assert.equal(f.requests.length, 0)
  assert.equal(f.auth.status().signedIn, false)
})

test('a late authorization exchange cannot persist credentials past its deadline', async () => {
  const store = savedStore(),
    f = authFixture(store)
  await f.auth.start()
  f.time(2000000)
  await f.poll()
  assert.equal(f.auth.status().state, 'expired')
  assert.equal(store.read(), undefined)
  assert.equal(f.auth.status().signedIn, false)
})

test('storage failures are explicit; a failed refresh invalidation sends no credential request', async () => {
  const store = savedStore(),
    f = authFixture(store)
  store.failWrite = true
  await f.auth.start()
  await f.poll()
  assert.equal(f.auth.status().state, 'storage-error')
  assert.equal(f.auth.status().signedIn, false)
  assert.ok(!JSON.stringify(f.auth.status()).includes('secret'))
  store.failWrite = false
  f.auth.logout()
  await f.auth.start()
  await f.poll()
  const rebooted = f.restart(),
    before = f.requests.length
  store.failClear = true
  await assert.rejects(rebooted.credentials(), { code: 'subscription_sign_in_required' })
  assert.equal(f.requests.length, before)
  assert.equal(rebooted.status().state, 'storage-error')
  assert.equal((await rebooted.start()).state, 'storage-error')
  store.failClear = false
  assert.equal(rebooted.logout().state, 'signed-out')
  assert.equal(f.restart().status().signedIn, false)
})

test('malformed stored identities, read errors and rejected or rebound refreshes require sign-in', async () => {
  const store = savedStore(),
    f = authFixture(store)
  await f.auth.start()
  await f.poll()
  const saved = store.read()
  for (const change of [
    { version: 2 },
    { issuer: 'https://attacker.test' },
    { clientId: 'other' },
    { refreshToken: '' },
    { accountId: '' },
    { subject: '' },
    { accessToken: 'forbidden' },
    { label: 'x'.repeat(161) },
  ]) {
    store.write({ ...saved, ...change })
    assert.equal(f.restart().status().state, 'storage-error')
  }
  store.write(saved)
  const rebound = f.restart()
  f.claims['https://api.openai.com/auth'].chatgpt_account_id = 'different-account'
  await assert.rejects(rebound.credentials(), { code: 'subscription_sign_in_required' })
  assert.equal(store.read(), undefined)
  store.write(saved)
  f.respond(async () => reply({}, 401))
  await assert.rejects(f.restart().credentials(), { code: 'subscription_sign_in_required' })
  assert.equal(store.read(), undefined)
  const broken = authFixture({
    available: () => true,
    read() {
      throw new Error('synthetic secret')
    },
  })
  assert.equal(broken.auth.status().state, 'storage-error')
  assert.ok(!JSON.stringify(broken.auth.status()).includes('secret'))
})

test('robot device authorization keeps secrets out of status and permits one pending attempt', async () => {
  const f = authFixture()
  await f.auth.start()
  await f.auth.start()
  assert.equal(f.requests.length, 1)
  assert.equal(f.auth.status().state, 'pending')
  assert.equal(f.auth.status().url, 'https://auth.openai.com/codex/device')
  assert.equal(f.auth.status().volatile, true)
  await f.poll()
  assert.equal(f.auth.status().signedIn, true)
  assert.equal(f.timers.size, 0)
  assert.deepEqual(await f.auth.credentials(), { accessToken: 'access-secret', accountId: 'account' })
  assert.ok(!JSON.stringify(f.auth.status()).includes('secret'))
  assert.ok(!JSON.stringify(f.auth.status()).includes('private'))
  assert.ok(f.requests.every((x) => x.url.startsWith('https://auth.openai.com/')))
  assert.ok(f.requests[2].options.body.includes('redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback'))
})
test('pending polls obey interval; cancellation and expiry discard late grants', async () => {
  const f = authFixture()
  await f.auth.start()
  f.respond(async () => reply({}, 403))
  await f.poll()
  assert.equal(f.auth.status().state, 'pending')
  f.auth.cancelSignIn()
  assert.equal(f.timers.size, 0)
  let finish
  f.respond(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const starting = f.auth.start()
  f.auth.cancelSignIn()
  finish(reply({ device_auth_id: 'late', user_code: 'LATE', interval: 2 }))
  await starting
  assert.equal(f.auth.status().signedIn, false)
  assert.equal(f.timers.size, 0)
  f.respond(async () => reply({ device_auth_id: 'device', user_code: 'CODE', interval: 2 }))
  await f.auth.start()
  const expiry = [...f.timers.values()].find((x) => x.delay === 900000)
  expiry.callback()
  assert.equal(f.auth.status().state, 'expired')
  assert.equal(f.timers.size, 0)
})
test('renewal is single flight, bound to account, and cannot restore a signed-out account', async () => {
  const f = authFixture()
  await f.auth.start()
  await f.poll()
  f.time(1950000)
  let finish,
    loggedOut = 0
  f.auth.onLogout(() => loggedOut++)
  f.respond(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const first = f.auth.credentials(),
    second = f.auth.credentials()
  assert.equal(f.requests.length, 4)
  f.auth.logout()
  finish(reply({ access_token: 'rotated-secret', refresh_token: 'rotated-refresh', expires_in: 1000 }))
  await assert.rejects(first, /sign-in required/)
  await assert.rejects(second, /sign-in required/)
  assert.equal(loggedOut, 1)
  assert.equal(f.auth.status().signedIn, false)
  assert.ok(f.requests[3].options.body.includes('grant_type=refresh_token'))
})
test('account mismatch during renewal signs out without trying an API key', async () => {
  const f = authFixture()
  await f.auth.start()
  await f.poll()
  f.time(1950000)
  f.claims['https://api.openai.com/auth'].chatgpt_account_id = 'different'
  await assert.rejects(f.auth.credentials(), /sign-in required/)
  assert.equal(f.auth.status().signedIn, false)
  assert.equal(f.requests.length, 4)
})

test('SSE reducer preserves split Unicode, requires a completed answer and real search citations', () => {
  const encode = (s) => new TextEncoder().encode(s).buffer
  const decode = (b) => new TextDecoder('utf-8', { fatal: true }).decode(b)
  const completed = (output) =>
    `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`
  const source =
    completed([
      { type: 'web_search_call', status: 'completed' },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'Zażółć 🌍',
            annotations: [{ type: 'url_citation', url: 'https://example.test/news', title: 'News' }],
          },
        ],
      },
    ]) + 'data: [DONE]\n\n'
  const bytes = new TextEncoder().encode(source)
  for (const chunkSize of [1, 2, 7, 1024]) {
    const stream = createSubscriptionStream(decode, encode)
    for (let offset = 0; offset < bytes.length; offset += chunkSize)
      stream.write(bytes.subarray(offset, offset + chunkSize))
    assert.deepEqual(JSON.parse(decode(stream.finish())), {
      answer: 'Zażółć 🌍',
      searched: true,
      sources: [{ url: 'https://example.test/news', title: 'News' }],
    })
  }
  const incomplete = createSubscriptionStream(decode, encode)
  incomplete.write(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'))
  assert.throws(() => incomplete.finish(), /before completion/)
  const missing = createSubscriptionStream(decode, encode)
  missing.write(
    new TextEncoder().encode(
      completed([
        { type: 'web_search_call', status: 'completed' },
        { type: 'message', content: [{ type: 'output_text', text: 'Unverified' }] },
      ]),
    ),
  )
  assert.equal(JSON.parse(decode(missing.finish())).error, 'search_missing_sources')
  const oversized = createSubscriptionStream(decode, encode)
  assert.throws(() => oversized.write(new TextEncoder().encode('x'.repeat(32769))), /exceeds limit/)
})

test('private call identity is distinct from session ID, and UTF-8 appends stay within 500 bytes', () => {
  assert.deepEqual(parseSubscriptionCall({ ok: true, headers: { location: '/v1/live/rtc_123' } }, 'v=0\r\nanswer'), {
    callId: 'rtc_123',
    sdp: 'v=0\r\nanswer',
  })
  assert.throws(
    () => parseSubscriptionCall({ ok: true, headers: { location: 'https://attacker.test/rtc_123' } }, 'v=0'),
    /origin/,
  )
  assert.throws(() => parseSubscriptionCall({ ok: true, headers: {} }, 'v=0'), /identity/)
  assert.throws(
    () => parseSubscriptionCall({ ok: true, headers: { 'openai-session-id': 'rtc_session' } }, 'v=0'),
    /identity/,
  )
  assert.equal(
    parseSubscriptionCall(
      {
        ok: true,
        headers: {
          location: '/v1/live/rtc_parent/calls/rtc_actual',
          'openai-session-id': 'rtc_session',
        },
      },
      'v=0',
    ).callId,
    'rtc_actual',
  )
  const text = 'Zażółć🌍'.repeat(120),
    events = subscriptionAppends(text, 'd1')
  assert.equal(events.map((x) => x.content[0].text).join(''), text)
  assert.ok(events.every((x) => new TextEncoder().encode(x.content[0].text).length <= 500))
})

test('SDP diagnostics retain capability numbers and roles without private SDP fields', () => {
  const sdp = [
    'v=0',
    'a=ice-lite',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    'a=setup:passive',
    'a=ice-ufrag:synthetic-username',
    'a=ice-pwd:synthetic-password',
    'a=fingerprint:sha-256 synthetic-fingerprint',
    'a=candidate:one 1 UDP 123 192.0.2.1 5000 typ host',
    'a=candidate:two 1 TCP 123 192.0.2.2 443 typ host tcptype passive',
    'a=candidate:three 1 UDP 123 2001:db8::1 5000 typ host',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    '',
  ].join('\r\n')
  assert.deepEqual(subscriptionSdpMetadata(sdp), {
    audioPort: 9,
    applicationPort: 9,
    udpCandidates: 2,
    tcpCandidates: 1,
    dtlsRole: 'passive',
    iceLite: true,
    opusRate: 48000,
    opusChannels: 2,
    iceUfragLength: 'synthetic-username'.length,
    icePasswordLength: 'synthetic-password'.length,
    iceSessionAttributes: 0,
    iceMediaAttributes: 2,
    ipv4Candidates: 2,
    ipv6Candidates: 1,
    privateCandidates: 0,
    zeroAddressCandidates: 0,
    udpMinPort: 5000,
    udpMaxPort: 5000,
    tcpMinPort: 443,
    tcpMaxPort: 443,
  })
  const serialized = JSON.stringify(subscriptionSdpMetadata(sdp))
  for (const secret of ['synthetic', '192.0.2', 'fingerprint', 'ice-pwd', 'ice-ufrag', 'v=0'])
    assert.ok(!serialized.includes(secret))
  const absent = subscriptionSdpMetadata('v=0\r\n')
  assert.equal(absent.audioPort, undefined)
  assert.equal(absent.dtlsRole, undefined)
  assert.equal(absent.udpCandidates, 0)
  const classified = subscriptionSdpMetadata(
    [
      'a=candidate:1 1 UDP 123 10.0.0.1 1234 typ host',
      'a=candidate:2 1 UDP 123 172.16.0.1 9876 typ host',
      'a=candidate:3 1 UDP 123 172.31.0.1 5000 typ host',
      'a=candidate:4 1 TCP 123 192.168.0.1 443 typ host',
      'a=candidate:5 1 TCP 123 0.0.0.0 0 typ host',
      'a=candidate:6 1 UDP 123 172.32.0.1 70000 typ host',
    ].join('\n'),
  )
  assert.equal(classified.privateCandidates, 4)
  assert.equal(classified.zeroAddressCandidates, 1)
  assert.equal(classified.udpMinPort, 1234)
  assert.equal(classified.udpMaxPort, 9876)
  assert.equal(classified.tcpMinPort, 0)
  assert.equal(classified.tcpMaxPort, 443)
})
function liveFixture() {
  const requests = [],
    sent = [],
    events = []
  let receive,
    closes = 0,
    finishJob,
    cancels = 0
  const auth = {
    credentials: async () => ({ accessToken: 'subscription-only', accountId: 'account' }),
    onLogout: () => () => {},
  }
  const live = new SubscriptionLive({
    auth,
    uuid: () => 'fixture-id',
    openControl: async (_id, _headers, cb) => {
      receive = cb
      return { send: (event) => sent.push(event), close: () => closes++ }
    },
    fetch: (url, options) => {
      requests.push({ url, options })
      if (url.includes('/realtime/calls'))
        return Promise.resolve({
          ok: true,
          headers: { location: '/v1/live/rtc_call' },
          text: async () => 'v=0\r\nanswer',
        })
      const request = new Promise((resolve) => {
        finishJob = resolve
      })
      request.cancel = () => cancels++
      return request
    },
  })
  return {
    live,
    requests,
    sent,
    events,
    receive: (event) => receive(event),
    finish: (value) => finishJob(reply(value)),
    get closes() {
      return closes
    },
    get cancels() {
      return cancels
    },
  }
}

test('a transient activation 404 retries the same call within one deadline', async () => {
  const f = liveFixture(),
    joins = [],
    waits = []
  let now = 0
  f.live.now = () => now
  f.live.wait = async (delay) => {
    waits.push(delay)
    now += delay
  }
  f.live.openControl = async (id, _headers, _receive, timeout) => {
    joins.push([id, timeout])
    now += 50
    if (joins.length < 3) throw Object.assign(new Error('fixture'), { status: 404 })
    return { send() {}, close() {} }
  }
  await f.live.create(
    'v=0 offer',
    {},
    () => {},
    () => true,
  )
  assert.deepEqual(joins, [
    ['rtc_call', 15000],
    ['rtc_call', 14850],
    ['rtc_call', 14500],
  ])
  assert.deepEqual(waits, [100, 300])
  assert.equal(f.requests.length, 1)
  f.live.dispose()
})

test('control retries are bounded, never retry denial and stop after cancellation or the deadline', async () => {
  for (const status of [401, 403, 404, 410, 500]) {
    const f = liveFixture()
    let joins = 0
    f.live.openControl = async () => {
      joins++
      throw Object.assign(new Error('fixture'), { status, code: 'subscription_control_failed' })
    }
    await assert.rejects(
      f.live.create(
        'v=0 offer',
        {},
        () => {},
        () => true,
      ),
      (error) => error.status === status,
    )
    assert.equal(joins, status === 404 ? 4 : 1)
    assert.equal(f.requests.length, 1)
    f.live.dispose()
  }
  for (const cancel of [false, true]) {
    const f = liveFixture()
    let now = 0,
      joins = 0
    f.live.now = () => now
    f.live.openControl = async () => {
      joins++
      now = 14950
      throw Object.assign(new Error('fixture'), { status: 404 })
    }
    f.live.wait = async (delay) => {
      now += delay
      if (cancel) f.live.dispose()
    }
    await assert.rejects(
      f.live.create(
        'v=0 offer',
        {},
        () => {},
        () => true,
      ),
      (error) =>
        cancel ? error.message === 'Subscription start cancelled' : error.code === 'subscription_control_timeout',
    )
    assert.equal(joins, 1)
    f.live.dispose()
  }
})
test('subscription uses its own bootstrap and backend, deduplicates jobs, drops cancelled answers', async () => {
  const f = liveFixture()
  const boot = await f.live.create(
    'v=0',
    { voice: 'marin', instructions: 'Speak Polish.' },
    (event) => f.events.push(event),
    () => true,
  )
  assert.equal(boot.callId, 'rtc_call')
  f.live.activate()
  for (let index = 0; index < 8; index++)
    f.receive({ type: 'turn.done', turn: { role: 'assistant', transcript: `Prior answer ${index}` } })
  const delegation = {
    type: 'delegation.created',
    item: {
      type: 'delegation',
      target: 'client',
      id: 'd1',
      content: [{ type: 'input_text', text: 'Current weather?' }],
    },
  }
  f.receive(delegation)
  f.receive(delegation)
  await tick()
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests.every((x) => x.url.startsWith('https://chatgpt.com/backend-api/codex/')))
  assert.ok(f.requests.every((x) => x.options.headers.Authorization === 'Bearer subscription-only'))
  const backend = JSON.parse(f.requests[1].options.body)
  assert.equal(backend.stream, true)
  assert.equal(backend.store, false)
  assert.equal(backend.input.length, 7)
  assert.equal(backend.input[0].content[0].text, 'Prior answer 2')
  assert.equal(backend.input.at(-1).content[0].text, 'Current weather?')
  assert.ok(Array.isArray(backend.input))
  assert.equal(f.requests[1].options.responseFormat, 'subscription-response')
  f.receive({ type: 'output_transcript.added', item: { id: 'output', text: 'Checking.' } })
  f.receive({ type: 'output_audio_buffer.cleared', item_id: 'old' })
  assert.equal(f.cancels, 0)
  f.receive({ type: 'output_audio_buffer.cleared', item_id: 'output' })
  assert.equal(f.cancels, 1)
  f.receive({ type: 'output_audio_buffer.cleared', item_id: 'output' })
  assert.equal(f.cancels, 1)
  f.finish({ answer: 'Late result', sources: [], searched: false })
  await tick()
  assert.equal(f.sent.length, 0)
  assert.equal(f.events.filter((x) => x.type === 'local.subscription.job.finished').length, 1)
  f.live.dispose()
  assert.equal(f.closes, 1)
})
test('late bootstrap closes the orphan call without accepting SDP', async () => {
  const f = liveFixture()
  await assert.rejects(
    f.live.create(
      'v=0',
      {},
      () => {},
      () => false,
    ),
    /cancelled/,
  )
  assert.equal(f.requests.length, 0)
  let current = true
  const start = f.live.create(
    'v=0',
    {},
    () => {},
    () => current,
    () => assert.fail('a late answer must never be accepted'),
  )
  await Promise.resolve()
  current = false
  await assert.rejects(start, /cancelled/)
  assert.equal(f.sent[0].type, 'session.close')
  assert.equal(f.closes, 1)
})

test('the SDP answer is delivered before joining the control socket', async () => {
  const steps = []
  const live = new SubscriptionLive({
    auth: {
      credentials: async () => ({ accessToken: 'subscription-only', accountId: 'fixture' }),
      onLogout: () => () => {},
    },
    uuid: () => 'id',
    fetch: async () => ({
      ok: true,
      headers: { location: '/v1/live/rtc_fixture' },
      text: async () => 'v=0 answer',
    }),
    openControl: async () => {
      assert.deepEqual(steps, ['answer'])
      steps.push('control')
      return { send() {}, close() {} }
    },
  })
  await live.create(
    'v=0 offer',
    {},
    () => {},
    () => true,
    (answer) => {
      assert.deepEqual(answer, { callId: 'rtc_fixture', sdp: 'v=0 answer' })
      steps.push('answer')
    },
  )
  assert.deepEqual(steps, ['answer', 'control'])
  live.dispose()
})

test('subscription denial, quota and service failures never try a public endpoint', async () => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    const requests = []
    let logouts = 0
    const live = new SubscriptionLive({
      auth: {
        credentials: async () => ({ accessToken: 'subscription-grant', accountId: 'account' }),
        logout() {
          logouts++
        },
        onLogout: () => () => {},
      },
      uuid: () => 'id',
      openControl: () => {
        throw new Error('Control must not open after failed create')
      },
      fetch: async (url, options) => {
        requests.push({ url, options })
        return { ok: false, status, text: async () => 'provider-private-error' }
      },
    })
    await assert.rejects(
      live.create(
        'v=0',
        {},
        () => {},
        () => true,
      ),
      /Subscription call rejected/,
    )
    assert.equal(requests.length, 1)
    assert.equal(logouts, status === 401 ? 1 : 0)
    assert.ok(requests[0].url.startsWith('https://chatgpt.com/backend-api/codex/realtime/calls'))
    assert.equal(requests[0].options.headers.Authorization, 'Bearer subscription-grant')
    live.dispose()
  }
})
test('wrong issuer, client and audience cannot install a grant', async () => {
  for (const [key, value] of [
    ['iss', 'https://attacker.test'],
    ['client_id', 'other-client'],
    ['aud', 'other-client'],
  ]) {
    const f = authFixture()
    f.claims[key] = value
    await f.auth.start()
    await f.poll()
    assert.equal(f.auth.status().signedIn, false)
    assert.equal(f.auth.status().state, 'error')
    await assert.rejects(f.auth.credentials(), /sign-in required/)
  }
})
test('search citations without completed tool evidence are rejected', () => {
  const stream = createSubscriptionStream(
    (bytes) => new TextDecoder().decode(bytes),
    (text) => new TextEncoder().encode(text).buffer,
  )
  stream.write(
    new TextEncoder().encode(
      'data: ' +
        JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: 'Claim',
                    annotations: [{ type: 'url_citation', url: 'https://example.test' }],
                  },
                ],
              },
            ],
          },
        }) +
        '\n\n',
    ),
  )
  assert.equal(JSON.parse(new TextDecoder().decode(stream.finish())).error, 'search_missing_tool')
})

test('malformed SDP with a known call ID gets bounded orphan cleanup', async () => {
  const sent = []
  let closed = 0
  const live = new SubscriptionLive({
    auth: {
      credentials: async () => ({ accessToken: 'subscription', accountId: 'account' }),
      onLogout: () => () => {},
    },
    uuid: () => 'id',
    fetch: async () => ({ ok: true, headers: { location: '/v1/live/rtc_orphan' }, text: async () => 'invalid SDP' }),
    openControl: async (id) => {
      assert.equal(id, 'rtc_orphan')
      return { send: (event) => sent.push(event), close: () => closed++ }
    },
  })
  await assert.rejects(
    live.create(
      'v=0',
      {},
      () => {},
      () => true,
    ),
    /Invalid subscription SDP/,
  )
  assert.deepEqual(sent, [{ type: 'session.close' }])
  assert.equal(closed, 1)
  live.dispose()
})

test('startup diagnostics identify bootstrap, call metadata and control failures without error bodies', async () => {
  const secret = 'synthetic-sensitive-error-body'
  const fail = () => {
    throw new Error(secret)
  }
  const validResponse = () => ({
    ok: true,
    headers: { location: '/v1/live/rtc_fixture' },
    text: async () => 'v=0 answer',
  })
  for (const [overrides, code] of [
    [{ uuid: fail }, 'subscription_bootstrap_failed'],
    [{ fetch: fail }, 'subscription_bootstrap_failed'],
    [{ fetch: async () => ({ ...validResponse(), headers: {} }) }, 'subscription_invalid_call'],
    [{ openControl: fail }, 'subscription_control_failed'],
  ]) {
    const live = new SubscriptionLive({
      auth: {
        credentials: async () => ({ accessToken: 'subscription-only', accountId: 'fixture' }),
        onLogout: () => () => {},
      },
      uuid: () => 'id',
      fetch: async () => validResponse(),
      openControl: async () => ({ send() {}, close() {} }),
      ...overrides,
    })
    await assert.rejects(
      live.create(
        'v=0 offer',
        {},
        () => {},
        () => true,
      ),
      (error) => error.code === code && !error.message.includes(secret),
    )
    live.dispose()
  }
})

test('subscription errors retain only structured code and parameter, including HTTP upgrade rejections', () => {
  const body = JSON.stringify({
    error: {
      code: 'call_id_not_found',
      param: 'session.audio.output.voice',
      message: 'synthetic-private-body',
      account: 'synthetic-private-account',
    },
  })
  const expected = { providerCode: 'call_id_not_found', param: 'session.audio.output.voice' }
  assert.deepEqual(subscriptionErrorMetadata(body), expected)
  assert.deepEqual(
    subscriptionUpgradeError(`Content-Length: ${body.length}\r\nContent-Type: application/json\r\n\r\n${body}`),
    expected,
  )
  assert.deepEqual(
    subscriptionUpgradeError(`Transfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`),
    expected,
  )
  assert.deepEqual(subscriptionUpgradeError('Content-Length: 100\r\n\r\n{}'), {})
  assert.deepEqual(subscriptionErrorMetadata(JSON.stringify({ error: { code: 'sk_private', param: 'arbitrary' } })), {})
  assert.deepEqual(subscriptionErrorMetadata('x'.repeat(4097)), {})
  assert.throws(
    () => parseSubscriptionCall({ ok: false, status: 400 }, body),
    (error) =>
      error.providerCode === 'call_id_not_found' &&
      error.param === expected.param &&
      !error.message.includes('private'),
  )
})

test('USB backend probes require enabled diagnostics and an active subscription and send no fake control events', async () => {
  const f = liveFixture()
  let tuner, removed
  f.live.debug = {
    enabled: false,
    registerTuner(owner, value) {
      assert.equal(owner, f.live)
      tuner = value
    },
    unregisterTuner(owner) {
      removed = owner
    },
  }
  await assert.rejects(f.live.probe('probe', 'reasoning'), /unavailable/)
  await f.live.create(
    'v=0 offer',
    { instructions: '', voice: 'cove' },
    (event) => f.events.push(event),
    () => true,
  )
  f.live.activate()
  await assert.rejects(tuner.set('probe', 'reasoning'), /unavailable/)
  f.live.debug.enabled = true
  await assert.rejects(tuner.set('probe', 'reasoning'), /unavailable/)
  f.receive({ type: 'session.started' })
  await assert.rejects(tuner.set('probe', 'arbitrary'), /Invalid/)
  const calculation = tuner.set('probe', 'reasoning')
  await tick()
  assert.equal(JSON.parse(f.requests.at(-1).options.body).input.at(-1).content[0].text.includes('17'), true)
  await assert.rejects(tuner.set('probe', 'search'), /unavailable/)
  f.finish({ answer: '323', searched: false })
  await calculation
  const search = tuner.set('probe', 'search')
  await tick()
  f.finish({ answer: 'Status checked.', searched: true, sources: [{ url: 'https://status.openai.com/' }] })
  await search
  assert.deepEqual(f.sent, [])
  await tuner.set('probe', 'english')
  assert.equal(f.sent[0].type, 'session.context.append')
  assert.equal(f.sent[0].channel, 'final')
  assert.ok(f.sent[0].content[0].text.includes('voice test'))
  const missingSearch = tuner.set('probe', 'search')
  await tick()
  f.finish({ answer: 'I did not search.', searched: false })
  await assert.rejects(missingSearch, /probe failed/)
  f.live.dispose()
  assert.equal(removed, f.live)
  await assert.rejects(tuner.set('probe', 'reasoning'), /unavailable/)
})

test('subscription requests honor selected model and each effort without public API overrides', async () => {
  for (const model of ['gpt-6.1-terra', 'gpt-6-luna']) {
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const f = liveFixture()
      await f.live.create(
        'v=0 offer',
        { instructions: 'Context', voice: 'cove', backendModel: model, reasoningEffort: effort },
        (event) => f.events.push(event),
        () => true,
      )
      f.live.activate()
      f.receive({
        type: 'delegation.created',
        item: {
          id: 'item_fixture',
          type: 'delegation',
          target: 'client',
          content: [{ type: 'input_text', text: 'A question' }],
        },
      })
      await tick()
      const body = JSON.parse(f.requests.at(-1).options.body)
      assert.equal(body.model, model)
      assert.deepEqual(body.reasoning, { effort })
      assert.equal(body.store, false)
      assert.equal(body.stream, true)
      assert.deepEqual(body.tools, [{ type: 'web_search' }])
      f.finish({ answer: 'An answer', searched: false })
      await tick()
      f.live.dispose()
    }
  }
})
