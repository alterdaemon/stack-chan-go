import assert from 'node:assert/strict'
import test from 'node:test'
import { createSubscriptionProbes, detachedBackendProbe, runApiLiveProbe } from '../../debug-log/subscription-probes.js'
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

test('detached USB backend probe uses one fixed minimal request and accepts only a terminal answer', async () => {
  const requests = [],
    diagnostics = []
  await detachedBackendProbe({
    credentials: async () => ({ accessToken: 'synthetic-grant', accountId: 'synthetic-account' }),
    random: () => new ArrayBuffer(16),
    fetch: async (url, options) => {
      requests.push({ url, options })
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ answer: 'OK.', searched: false, sources: [] }),
      }
    },
    diagnose: (event, fields) => diagnostics.push({ event, ...fields() }),
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://chatgpt.com/backend-api/codex/responses')
  assert.deepEqual(Object.keys(JSON.parse(requests[0].options.body)), [
    'model',
    'instructions',
    'input',
    'store',
    'stream',
  ])
  assert.equal(requests[0].options.timeoutMs, 45000)
  assert.equal(requests[0].options.headers.Authorization, 'Bearer synthetic-grant')
  assert.deepEqual(diagnostics, [{ event: 'probe.detached', status: 200, accepted: true }])
})

test('detached backend cancellation prevents a late grant from starting HTTPS', async () => {
  let grant,
    calls = 0
  const probe = detachedBackendProbe({
    credentials: () =>
      new Promise((resolve) => {
        grant = resolve
      }),
    random: () => new ArrayBuffer(16),
    fetch: () => {
      calls++
      throw new Error('Must not run')
    },
  })
  probe.cancel()
  grant({ accessToken: 'synthetic-grant', accountId: 'synthetic-account' })
  await assert.rejects(probe, /session ended/)
  assert.equal(calls, 0)
})

test('API Live diagnostic speech uses only fixed commentary input and rejects arbitrary commands', () => {
  const messages = []
  runApiLiveProbe((value) => messages.push(value), 'probe', 'polish')
  assert.equal(messages[0].type, 'session.commentary.append')
  assert.equal(messages[0].delegation_id, null)
  assert.match(messages[0].content, /Cześć/)
  assert.throws(() => runApiLiveProbe(() => {}, 'probe', 'arbitrary private text'), RangeError)
  assert.throws(() => runApiLiveProbe(() => {}, 'other', 'english'), RangeError)
})

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
    createProbes: createSubscriptionProbes,
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
    finish: (value, status) => finishJob(reply(value, status)),
    get closes() {
      return closes
    },
    get cancels() {
      return cancels
    },
  }
}

test('native control owns readiness, deduplicated delegation and close without opening a sideband', async () => {
  const f = liveFixture(),
    received = [],
    sent = []
  let closes = 0
  f.live.control = { send: (event) => sent.push(event), close: () => closes++ }
  f.live.openControl = () => {
    throw new Error('Normal native control must not open WSS')
  }
  f.live.receiveControl({ type: 'session.started', session: { id: 'too-early' } })
  await f.live.create(
    'v=0 offer',
    {},
    (event) => received.push(event),
    () => true,
  )
  f.live.receiveControl({ type: 'session.started', session: { id: 'native-session' } })
  assert.equal(received.length, 0)
  f.live.activate()
  assert.equal(received.length, 1)
  const delegation = {
    type: 'delegation.created',
    event_id: 'native-event',
    item: {
      type: 'delegation',
      target: 'client',
      id: 'native-job',
      content: [{ type: 'input_text', text: 'What is two plus two?' }],
    },
  }
  f.live.receiveControl(delegation)
  f.live.receiveControl(delegation)
  await new Promise(setImmediate)
  assert.equal(f.requests.length, 2)
  f.finish({ answer: 'Four.', searched: false, sources: [] })
  await new Promise(setImmediate)
  assert.ok(sent.some((event) => event.channel === 'speakable'))
  f.live.send({ type: 'session.close' })
  assert.equal(sent.at(-1).type, 'session.close')
  f.live.dispose()
  assert.equal(closes, 1)
  const count = received.length
  f.live.receiveControl({ type: 'turn.done', turn: { role: 'assistant', transcript: 'stale' } })
  assert.equal(received.length, count)
})

test('a late native create closes only its orphan through the bounded sideband cleanup', async () => {
  const f = liveFixture(),
    sent = []
  f.live.control = {
    send() {
      throw new Error('Closed local peer must not receive control')
    },
    close() {},
  }
  f.live.openControl = async () => ({
    send(event) {
      sent.push(event)
    },
    close() {},
  })
  let checks = 0
  await assert.rejects(
    f.live.create(
      'v=0 offer',
      {},
      () => {},
      () => ++checks === 1,
    ),
    /cancelled/,
  )
  assert.deepEqual(sent, [{ type: 'session.close' }])
  f.live.dispose()
})

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
  const voice = JSON.parse(f.requests[0].options.body).session
  assert.ok(voice.instructions.endsWith('Speak Polish.'))
  assert.ok(voice.instructions.includes('Follow the assistant specification'))
  assert.ok(voice.instructions.includes('never delegate them again'))
  assert.equal(voice.instructions.split('Speak Polish.').length, 2)
  assert.deepEqual(voice.initial_items, [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Speak Polish.' }] },
  ])
  assert.equal(backend.stream, true)
  assert.equal(backend.store, false)
  assert.equal(backend.input.length, 7)
  assert.equal(backend.input[0].content[0].text, 'Prior answer 2')
  assert.equal(backend.input.at(-1).content[0].text, 'Current weather?')
  assert.ok(Array.isArray(backend.input))
  assert.deepEqual(backend.include, ['web_search_call.action.sources'])
  assert.ok(backend.instructions.endsWith('Speak Polish.'))
  assert.ok(!backend.instructions.includes('in its language'))
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
test('a native Codex user turn cancels obsolete delegation without requiring an audio-clear event', async () => {
  const f = liveFixture()
  f.live.control = { send: (event) => f.sent.push(event), close() {} }
  await f.live.create(
    'v=0',
    {},
    (event) => f.events.push(event),
    () => true,
  )
  f.live.activate()
  const receive = (message) => f.live.receiveControl(message)
  const input = (start_ms, end_ms) =>
    receive({ type: 'input_transcript.added', start_ms, end_ms, item: { text: 'Synthetic input' } })
  const turn = { type: 'turn.created', turn: { role: 'user' } }
  const delegate = (id) =>
    receive({
      type: 'delegation.created',
      item: { type: 'delegation', target: 'client', id, content: [{ type: 'input_text', text: 'Question?' }] },
    })
  input(0, 200)
  receive(turn)
  delegate('first')
  await tick()
  receive(turn)
  input(0, 200)
  receive(turn)
  input(-1, 400)
  input(500, 400)
  input(200, Infinity)
  receive(turn)
  assert.equal(f.cancels, 0, 'old boundaries and invalid input cannot cancel current work')
  input(400, 600)
  receive({ type: 'turn.created', turn: { role: 'assistant' } })
  assert.equal(f.cancels, 0, 'transcript fragments and assistant turns are not cut-ins')
  receive(turn)
  receive(turn)
  assert.equal(f.cancels, 1)
  f.finish({ answer: 'Obsolete answer', searched: false, sources: [] })
  await tick()
  assert.equal(f.sent.length, 0, 'the cancelled answer cannot be forwarded')
  delegate('second')
  await tick()
  input(0, 200)
  receive(turn)
  assert.equal(f.cancels, 1, 'old input cannot cancel a later request')
  f.finish({ answer: 'Current answer', searched: false, sources: [] })
  await tick()
  assert.ok(f.sent.some((event) => event.channel === 'speakable'))
  assert.equal(f.events.filter((event) => event.type === 'local.subscription.job.finished').length, 2)
  f.live.dispose()
})
test('ready delegation cancellation informs the voice agent once and failure never requests an automatic retry', async () => {
  const f = liveFixture()
  await f.live.create(
    'v=0',
    { instructions: 'Speak Polish.' },
    (event) => f.events.push(event),
    () => true,
  )
  f.live.activate()
  f.receive({ type: 'session.started' })
  const delegate = (id) =>
    f.receive({
      type: 'delegation.created',
      item: {
        id,
        type: 'delegation',
        target: 'client',
        content: [{ type: 'input_text', text: 'Search current facts.' }],
      },
    })
  delegate('cancelled')
  await tick()
  assert.equal(f.requests.at(-1).options.timeoutMs, 45000)
  f.live.cancelJob()
  f.live.cancelJob()
  assert.equal(f.cancels, 1)
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].channel, 'commentary')
  assert.equal(f.sent[0].delegation_item_id, 'cancelled')
  f.finish({ answer: 'Obsolete answer.', searched: false, sources: [] })
  await tick()
  assert.equal(f.sent.length, 1, 'late completion cannot re-enter the voice session')
  delegate('failed')
  await tick()
  f.finish({ error: 'search_missing_sources' })
  await tick()
  assert.equal(f.sent.at(-1).delegation_item_id, 'failed')
  assert.equal(f.sent.at(-1).channel, 'commentary')
  assert.match(f.sent.at(-1).content[0].text, /Do not retry it automatically/)
  assert.equal(f.events.filter((event) => event.type === 'local.subscription.job.finished').length, 2)
  delegate('fresh')
  await tick()
  f.finish({ answer: 'Fresh answer.', searched: false, sources: [] })
  await tick()
  assert.equal(f.sent.at(-1).channel, 'speakable')
  assert.equal(f.events.filter((event) => event.type === 'local.subscription.job.finished').length, 3)
  f.live.dispose()
})
test('a Codex cut-in during renewal prevents the obsolete delegation from starting HTTP', async () => {
  const f = liveFixture()
  await f.live.create(
    'v=0',
    {},
    () => {},
    () => true,
  )
  f.live.activate()
  let grant
  f.live.auth.credentials = () => new Promise((resolve) => (grant = resolve))
  f.receive({
    type: 'delegation.created',
    item: { type: 'delegation', target: 'client', id: 'renewing', content: [{ type: 'input_text', text: 'Old?' }] },
  })
  f.receive({ type: 'input_transcript.added', item: { text: 'New', start_ms: 100, end_ms: 200 } })
  f.receive({ type: 'turn.created', turn: { role: 'user' } })
  grant({ accessToken: 'subscription-only', accountId: 'account' })
  await tick()
  assert.equal(f.requests.length, 1, 'only bootstrap may have run')
  assert.equal(f.sent.length, 0)
  f.live.dispose()
})
test('lost native control cannot prevent local backend cancellation or finish', async () => {
  const f = liveFixture()
  f.live.control = {
    send() {
      throw new Error('Control closed')
    },
    close() {},
  }
  await f.live.create(
    'v=0',
    {},
    (event) => f.events.push(event),
    () => true,
  )
  f.live.activate()
  f.live.receiveControl({ type: 'session.started' })
  f.live.receiveControl({
    type: 'delegation.created',
    item: {
      id: 'lost',
      type: 'delegation',
      target: 'client',
      content: [{ type: 'input_text', text: 'Search.' }],
    },
  })
  await tick()
  assert.doesNotThrow(() => f.live.cancelJob())
  assert.equal(f.cancels, 1)
  assert.equal(f.events.filter((event) => event.type === 'local.subscription.job.finished').length, 1)
  f.finish({ answer: 'Late answer.', searched: false, sources: [] })
  await tick()
  f.live.dispose()
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
    assert.equal(logouts, 0)
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
  let tuner,
    removed,
    probeLoads = 0
  f.live.createProbes = (hooks) => {
    probeLoads++
    return createSubscriptionProbes(hooks)
  }
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
  assert.equal(probeLoads, 0)
  await assert.rejects(tuner.set('probe', 'arbitrary'), /Invalid/)
  const calculation = tuner.set('probe', 'reasoning')
  await tick()
  assert.equal(JSON.parse(f.requests.at(-1).options.body).input.at(-1).content[0].text.includes('17'), true)
  await assert.rejects(tuner.set('probe', 'search'), /unavailable/)
  f.finish({ answer: '323', searched: false })
  await calculation
  const minimal = tuner.set('probe', 'minimal')
  await tick()
  const minimalBody = JSON.parse(f.requests.at(-1).options.body)
  assert.equal(f.requests.at(-1).options.timeoutMs, 45000)
  assert.deepEqual(Object.keys(minimalBody).sort(), ['input', 'instructions', 'model', 'store', 'stream'])
  assert.equal(minimalBody.input.length, 1)
  assert.equal(minimalBody.input[0].content[0].text, 'Say OK.')
  f.finish({ answer: 'OK', searched: false })
  await minimal
  let identity = 0
  f.live.uuid = () => `isolated-${++identity}`
  const isolated = tuner.set('probe', 'minimal-isolated')
  await tick()
  assert.deepEqual(JSON.parse(f.requests.at(-1).options.body), minimalBody)
  for (const name of ['session-id', 'thread-id'])
    assert.notEqual(f.requests.at(-1).options.headers[name], f.requests[0].options.headers[name])
  f.finish({ answer: 'OK', searched: false })
  await isolated
  const search = tuner.set('probe', 'search')
  await tick()
  f.finish({ answer: 'Status checked.', searched: true, sources: [{ url: 'https://status.openai.com/' }] })
  await search
  assert.equal(probeLoads, 1)
  assert.deepEqual(f.sent, [])
  await tuner.set('probe', 'english')
  assert.equal(f.sent[0].type, 'session.context.append')
  assert.equal(f.sent[0].channel, 'speakable')
  assert.ok(f.sent[0].content[0].text.includes('voice test'))
  await tuner.set('probe', 'handoff')
  assert.equal(f.sent[1].type, 'session.context.append')
  assert.equal(f.sent[1].channel, undefined)
  assert.ok(f.sent[1].content[0].text.includes('client assistant'))
  const missingSearch = tuner.set('probe', 'search')
  await tick()
  f.finish({ answer: 'I did not search.', searched: false })
  await assert.rejects(missingSearch, /probe failed/)
  f.live.dispose()
  assert.equal(removed, f.live)
  await assert.rejects(tuner.set('probe', 'reasoning'), /unavailable/)
})

test('the fixed rejection probe isolates HTTP response delivery without sending an account token', async () => {
  const f = liveFixture()
  f.live.debug = { enabled: true }
  await f.live.create(
    'v=0 offer',
    { instructions: '', voice: 'cove' },
    () => {},
    () => true,
  )
  f.live.activate()
  f.receive({ type: 'session.started' })
  const rejected = f.live.probe('probe', 'rejection')
  await tick()
  assert.equal(f.requests.at(-1).options.headers.Authorization, 'Bearer stackchan-diagnostic-invalid')
  assert.equal(f.requests.at(-1).options.timeoutMs, 15000)
  assert.equal(f.requests.at(-1).url, 'https://chatgpt.com/backend-api/codex/responses')
  await assert.rejects(f.live.probe('probe', 'reasoning'), /unavailable/)
  f.finish({ error: { code: 'invalid_token' } }, 401)
  await rejected
  assert.deepEqual(f.sent, [])
  const calculation = f.live.probe('probe', 'reasoning')
  await tick()
  assert.equal(f.requests.at(-1).options.headers.Authorization, 'Bearer subscription-only')
  f.finish({ answer: '323', searched: false })
  await calculation
  f.live.dispose()
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
      assert.equal(f.requests.at(-1).options.headers.Accept, 'text/event-stream')
      assert.equal(f.requests.at(-1).options.headers.originator, 'stack-chan-go')
      assert.equal(f.requests[0].options.headers['OpenAI-Alpha'], 'quicksilver=v2')
      assert.equal(f.requests.at(-1).options.headers['OpenAI-Alpha'], undefined)
      assert.equal(f.requests.at(-1).options.headers['session-id'], f.requests[0].options.headers['session-id'])
      assert.equal(f.requests.at(-1).options.headers['thread-id'], f.requests[0].options.headers['thread-id'])
      assert.deepEqual(body.tools, [{ type: 'web_search' }])
      f.finish({ answer: 'An answer', searched: false })
      await tick()
      f.live.dispose()
    }
  }
})

test('backend resource rejection preserves the grant and never substitutes credentials', async () => {
  const f = liveFixture()
  let logouts = 0
  f.live.auth.logout = () => logouts++
  f.live.debug = { enabled: true }
  await f.live.create(
    'v=0 offer',
    { instructions: '', voice: 'cove' },
    () => {},
    () => true,
  )
  f.live.activate()
  f.receive({ type: 'session.started' })
  const requests = []
  f.live.fetch = async (url) => {
    requests.push(url)
    return reply({ error: { code: 'invalid_token' } }, 401)
  }
  await assert.rejects(
    f.live.probe('probe', 'reasoning'),
    (error) =>
      error.code === 'subscription_backend_error' && error.status === 401 && error.providerCode === 'invalid_token',
  )
  assert.equal(logouts, 0)
  assert.equal(requests.length, 1)
  assert.ok(requests[0].startsWith('https://chatgpt.com/backend-api/codex/'))
  f.live.dispose()
})

test('completed search sources survive absent answer annotations and yield to explicit citations', () => {
  const decode = (bytes) => new TextDecoder().decode(bytes)
  const source = (url) => ({ type: 'url', url })
  const tool = {
    id: 'search',
    type: 'web_search_call',
    status: 'completed',
    action: {
      sources: [source('javascript:bad'), ...Array.from({ length: 12 }, (_, i) => source(`https://example.test/${i}`))],
    },
  }
  const message = (annotations = []) => ({
    id: 'answer',
    type: 'message',
    content: [{ type: 'output_text', text: 'A verified answer.', annotations }],
  })
  const reduce = (output) => {
    const stream = createSubscriptionStream(decode, (text) => new TextEncoder().encode(text).buffer)
    stream.write(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`,
      ),
    )
    return JSON.parse(decode(stream.finish()))
  }
  const consulted = reduce([tool, message()])
  assert.equal(consulted.searched, true)
  assert.equal(consulted.sources.length, 6)
  assert.equal(consulted.sources[0].url, 'https://example.test/0')
  for (const output of [
    [tool, message([{ type: 'url_citation', url: 'https://example.test/cited' }])],
    [message([{ type: 'url_citation', url: 'https://example.test/cited' }]), tool],
  ])
    assert.deepEqual(reduce(output).sources, [{ url: 'https://example.test/cited', title: '' }])
  assert.equal(reduce([message()]).searched, false)
  assert.equal(
    reduce([{ ...tool, action: { sources: [source('javascript:bad')] } }, message()]).error,
    'search_missing_sources',
  )
  assert.throws(() => reduce([{ ...tool, status: 'in_progress' }, message()]), /search incomplete/)
})

test('Codex item completion is bounded, deduplicated and gated by terminal completion', () => {
  const encode = (s) => new TextEncoder().encode(s).buffer
  const decode = (b) => new TextDecoder('utf-8', { fatal: true }).decode(b)
  const tool = { id: 'tool_1', type: 'web_search_call', status: 'completed' }
  const message = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      { type: 'output_text', text: 'Żółw 🌍', annotations: [{ type: 'url_citation', url: 'https://example.test/' }] },
    ],
  }
  const done = (item, output_index) => ({ type: 'response.output_item.done', item, output_index })
  const terminal = (output) => ({
    type: 'response.completed',
    response: { id: 'resp_fixture', ...(output ? { output } : {}) },
  })
  const write = (stream, events) => {
    const bytes = new Uint8Array(encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')))
    for (let at = 0; at < bytes.length; at++) stream.write(bytes.subarray(at, at + 1))
  }
  for (const output of [undefined, [], [tool, message]]) {
    const stream = createSubscriptionStream(decode, encode)
    write(stream, [done(tool, 0), done(message, 1), done(message, 1)])
    assert.throws(() => stream.finish(), /before completion/)
    write(stream, [terminal(output)])
    const result = JSON.parse(decode(stream.finish()))
    assert.equal(result.answer, 'Żółw 🌍')
    assert.equal(result.searched, true)
    assert.equal(result.sources.length, 1)
  }
  const mixed = createSubscriptionStream(decode, encode)
  write(mixed, [done(tool, 0), terminal([tool, message])])
  assert.equal(JSON.parse(decode(mixed.finish())).answer, 'Żółw 🌍')
  const failed = createSubscriptionStream(decode, encode)
  write(failed, [
    done(message, 0),
    {
      type: 'response.failed',
      response: {
        error: { code: 'unsupported_value', param: 'tools[0].type', message: 'synthetic-private-response' },
      },
    },
  ])
  assert.deepEqual(JSON.parse(decode(failed.finish())), {
    error: 'subscription_incomplete',
    providerCode: 'unsupported_value',
    param: 'tools[0].type',
  })
  const excessive = createSubscriptionStream(decode, encode)
  assert.throws(
    () =>
      write(
        excessive,
        Array.from({ length: 33 }, (_, index) =>
          done(
            {
              id: `item_${index}`,
              type: 'reasoning',
            },
            index,
          ),
        ),
      ),
    /exceeds limit/,
  )
})

test('persona checks separate backend identity from genuine microphone output without injecting questions', async () => {
  const sent = [],
    observations = []
  const probes = createSubscriptionProbes({
    send: (message) => sent.push(message),
    delegate: async () => ({ answer: 'Tu Bursztyn. Jestem małym robotem.' }),
    diagnose: (event, fields) => observations.push({ event, ...fields() }),
  })
  await probes.run('probe', 'persona')
  assert.equal(sent.length, 0, 'a voice question must not be passed as an answer script')
  assert.equal(observations.at(-1).accepted, true)
  await probes.run('probe', 'listen-persona')
  probes.output({ role: 'assistant', transcript: 'Tu Bursztyn. Cześć!' })
  assert.equal(observations.at(-1).accepted, true)
  assert.equal(observations.at(-1).searched, false)
  probes.output({ role: 'assistant', transcript: 'Tu Bursztyn. Sprawdziłem status.openai.com.' })
  assert.equal(observations.at(-1).accepted, true)
  assert.equal(observations.at(-1).searched, true)
  probes.reset()
  const count = observations.length
  probes.output({ role: 'assistant', transcript: 'Ignored.' })
  assert.equal(observations.length, count)
})

test('passive microphone checks emit only fixed verdicts, keep listening, and reset without requests', async () => {
  const events = []
  const probes = createSubscriptionProbes({
    send: () => assert.fail('passive checks cannot speak'),
    delegate: () => assert.fail('passive checks cannot request a backend'),
    diagnose: (event, fields) => events.push({ event, ...fields() }),
    statistics: () => ({ socketPending: 1, tlsBuffered: 0 }),
  })
  for (const [name, text] of [
    ['english', 'Hello, nice to hear from you.'],
    ['polish', 'Cześć, miło cię słyszeć.'],
    ['search', 'The page is status dot openai dot com.'],
    ['followup', 'I checked OpenAI Status.'],
  ]) {
    await probes.run('probe', `listen-${name}`)
    probes.output({ role: 'user', transcript: text })
    probes.output({ role: 'assistant', transcript: 'An unrelated synthetic answer.' })
    assert.equal(events.at(-1).accepted, false)
    probes.output({ role: 'assistant', transcript: text })
    assert.equal(events.at(-1).accepted, true)
    assert.deepEqual(Object.keys(events.at(-1)), ['event', 'probe', 'accepted'])
  }
  const before = events.length
  probes.reset()
  probes.output({ role: 'assistant', transcript: 'OpenAI Status' })
  assert.equal(events.length, before)
  await probes.run('probe', 'control')
  assert.deepEqual(events.at(-1), { event: 'control.stats', socketPending: 1, tlsBuffered: 0 })
  assert.ok(!JSON.stringify(events).includes('synthetic answer'))
})

test('diagnostic reset preserves real delegation but cancels diagnostic work; control remains readable', async () => {
  const f = liveFixture(),
    events = []
  let tuner,
    samples = 0
  f.live.debug = {
    enabled: true,
    registerTuner(_owner, value) {
      tuner = value
    },
    unregisterTuner() {},
  }
  f.live.diagnose = (event, fields) => events.push({ event, ...(typeof fields === 'function' ? fields() : fields) })
  f.live.openControl = async (_id, _headers, receive) => {
    f.live.fixtureReceive = receive
    return {
      send: (message) => f.sent.push(message),
      close() {},
      statistics() {
        samples++
        return { socketPending: 1 }
      },
    }
  }
  await f.live.create(
    'v=0 offer',
    {},
    (event) => f.events.push(event),
    () => true,
  )
  f.live.activate()
  f.live.fixtureReceive({ type: 'session.started' })
  await tuner.set('probe', 'listen-followup')
  f.live.fixtureReceive({
    type: 'delegation.created',
    item: {
      id: 'real_request',
      type: 'delegation',
      target: 'client',
      content: [{ type: 'input_text', text: 'A fixed test question.' }],
    },
  })
  await tick()
  await tuner.set('probe', 'control')
  assert.equal(samples, 1)
  assert.equal(events.at(-1).socketPending, 1)
  await tuner.reset()
  assert.equal(f.cancels, 0)
  f.finish({ answer: 'The test answer.', searched: false })
  await tick()
  assert.ok(f.sent.some((message) => message.type === 'delegation.context.append'))
  const before = events.filter((event) => event.event === 'probe.output').length
  f.live.fixtureReceive({ type: 'turn.done', turn: { role: 'assistant', transcript: 'OpenAI Status' } })
  assert.equal(events.filter((event) => event.event === 'probe.output').length, before)
  const diagnostic = tuner.set('probe', 'minimal')
  await tick()
  await tuner.reset()
  assert.equal(f.cancels, 1)
  f.finish({ answer: 'OK', searched: false })
  await assert.rejects(diagnostic, /probe failed/)
  f.live.debug.enabled = false
  await assert.rejects(tuner.set('probe', 'control'), /unavailable/)
  assert.equal(samples, 1)
  f.live.dispose()
})
