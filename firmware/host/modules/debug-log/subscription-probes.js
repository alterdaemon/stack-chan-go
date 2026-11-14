// SPDX-License-Identifier: Apache-2.0
// Fixed USB-only probes, loaded on demand outside the conversation implementation.
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
      if (value === 'minimal') {
        const result = await delegate('Say OK.', 'minimal')
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
