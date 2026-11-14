// SPDX-License-Identifier: Apache-2.0
// Fixed USB-only probes, loaded on demand outside the conversation implementation.
export function createSubscriptionProbes({ send, delegate, diagnose }) {
  let speech
  return {
    async run(name, value) {
      if (name !== 'probe') throw new RangeError('Invalid subscription probe')
      if (value === 'english' || value === 'polish') {
        speech = value
        send({
          type: 'session.context.append',
          channel: 'final',
          content: [
            {
              type: 'input_text',
              text:
                value === 'english'
                  ? 'For this diagnostic only, say exactly: Hello. This is a voice test.'
                  : 'Na potrzeby tego testu powiedz dokładnie: Cześć. To jest test głosu.',
            },
          ],
        })
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
