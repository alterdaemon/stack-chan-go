import assert from 'node:assert/strict'
import test from 'node:test'
import { SubscriptionAuth } from '../subscription-auth.js'
import { parseSubscriptionCall, SubscriptionLive, subscriptionAppends } from '../subscription-live.js'
import { createSubscriptionStream } from '../subscription-stream.js'

const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
const reply = (value, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(value),
})
function authFixture() {
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
  const auth = new SubscriptionAuth({
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
  return {
    auth,
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
  const text = 'Zażółć🌍'.repeat(120),
    events = subscriptionAppends(text, 'd1')
  assert.equal(events.map((x) => x.content[0].text).join(''), text)
  assert.ok(events.every((x) => new TextEncoder().encode(x.content[0].text).length <= 500))
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
          headers: { 'openai-session-id': 'rtc_call' },
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
  )
  await Promise.resolve()
  current = false
  await assert.rejects(start, /cancelled/)
  assert.equal(f.sent[0].type, 'session.close')
  assert.equal(f.closes, 1)
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
    fetch: async () => ({ ok: true, headers: { 'openai-session-id': 'rtc_orphan' }, text: async () => 'invalid SDP' }),
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
