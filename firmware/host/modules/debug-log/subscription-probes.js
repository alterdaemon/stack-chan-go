// SPDX-License-Identifier: Apache-2.0
// Fixed USB-only probes, loaded on demand outside the conversation implementation.
export function detachedBackendProbe({ credentials, fetch, random, diagnose }) {
  let cancelled = false,
    request
  const promise = (async () => {
    const grant = await credentials()
    if (cancelled) throw new Error('Diagnostic session ended')
    const uuid = () => {
      const bytes = new Uint8Array(random())
      if (bytes.length !== 16) throw new Error('Invalid diagnostic identity')
      bytes[6] = (bytes[6] & 15) | 64
      bytes[8] = (bytes[8] & 63) | 128
      const h = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    }
    request = fetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${grant.accessToken}`,
        'ChatGPT-Account-ID': grant.accountId,
        originator: 'stack-chan-go',
        'session-id': uuid(),
        'thread-id': uuid(),
        'Content-Type': 'application/json',
        'User-Agent': 'stack-chan-go/2.1.0-R5',
        Accept: 'text/event-stream',
      },
      responseFormat: 'subscription-response',
      timeoutMs: 45000,
      body: JSON.stringify({
        model: 'gpt-6.1-terra',
        instructions: 'Answer briefly.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Say OK.' }] }],
        store: false,
        stream: true,
      }),
    })
    const response = await request
    if (cancelled || !response.ok) throw new Error('Detached subscription probe failed')
    const result = JSON.parse(await response.text())
    if (cancelled || result.error || typeof result.answer !== 'string' || !/\bOK\b/i.test(result.answer))
      throw new Error('Detached subscription probe failed')
    diagnose?.('probe.detached', () => ({ status: response.status, accepted: true }))
  })()
  promise.cancel = () => {
    cancelled = true
    request?.cancel?.()
  }
  return promise
}

export function runApiLiveProbe(send, name, language) {
  if (name !== 'probe' || !['english', 'polish'].includes(language)) throw new RangeError('Invalid API Live probe')
  // Public Live dialect differs from Codex's private speakable append.
  send({
    type: 'session.commentary.append',
    delegation_id: null,
    content:
      language === 'english'
        ? 'Say exactly: Hello. This is a voice test.'
        : 'Powiedz dokładnie: Cześć. To jest test głosu.',
  })
}

export function createSubscriptionProbes({ send, delegate, diagnose }) {
  let speech
  return {
    async run(name, value) {
      if (name !== 'probe') throw new RangeError('Invalid subscription probe')
      if (value === 'handoff') {
        // Codex methods_common.rs maps a text input to an unchanneled
        // session.context.append. Let the voice agent create the delegation.
        send({
          type: 'session.context.append',
          content: [
            {
              type: 'input_text',
              text: 'Ask your client assistant to search the web for the official OpenAI status page. Report its current status and cite the URL.',
            },
          ],
        })
        return
      }
      if (value === 'english' || value === 'polish') {
        speech = value
        send({
          type: 'session.context.append',
          channel: 'speakable',
          content: [
            {
              type: 'input_text',
              text:
                value === 'english'
                  ? 'Say exactly: Hello. This is a voice test.'
                  : 'Powiedz dokładnie: Cześć. To jest test głosu.',
            },
          ],
        })
        return
      }
      if (value === 'rejection') {
        try {
          await delegate('Say OK.', true)
        } catch (error) {
          if (![401, 403].includes(error.status)) throw error
          diagnose?.('probe.rejection', () => ({ status: error.status, accepted: true }))
          return
        }
        throw new Error('Invalid diagnostic token was not rejected')
      }
      if (value === 'minimal' || value === 'minimal-isolated') {
        const result = await delegate('Say OK.', value)
        if (!result || !/\bOK\b/i.test(result.answer)) throw new Error('Minimal subscription probe failed')
        return
      }
      const prompts = {
        reasoning: 'Calculate 17 multiplied by 19. Give only the decimal integer.',
        search: 'Search the web for the official OpenAI status page. Report what it says and cite its URL.',
      }
      if (!Object.hasOwn(prompts, value)) throw new RangeError('Invalid subscription probe')
      const result = await delegate(prompts[value])
      if (
        !result ||
        (value === 'reasoning' && !/\b323\b/.test(result.answer)) ||
        (value === 'search' && result.searched !== true)
      )
        throw Object.assign(new Error('Subscription probe failed'), { code: 'subscription_backend_error' })
    },
    output(turn) {
      if (!speech || turn.role !== 'assistant') return
      diagnose?.('probe.output', () => ({
        probe: speech,
        accepted: (speech === 'english' ? /voice test/i : /test głosu/i).test(turn.transcript),
      }))
      speech = undefined
    },
    reset() {
      speech = undefined
    },
  }
}
