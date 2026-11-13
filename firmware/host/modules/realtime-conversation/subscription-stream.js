export function subscriptionErrorMetadata(text) {
  if (typeof text !== 'string' || text.length > 4096) return {}
  try {
    const source = JSON.parse(text)?.error
    const result = {}
    const code = source?.code ?? source?.type
    if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(code) && !/sk_|bearer|password|secret/i.test(code))
      result.providerCode = code
    if (
      typeof source?.param === 'string' &&
      /^(?:session|delegation|model|audio|tools|reasoning|input|instructions|store|stream|tool_choice)(?:[.[\]a-z0-9_]){0,96}$/i.test(
        source.param,
      )
    )
      result.param = source.param
    return result
  } catch {
    return {}
  }
}

// Subscription Responses SSE is reduced in the existing HTTP worker before IPC.
export function createSubscriptionStream(decode, encode) {
  let pending = '',
    carry = new Uint8Array(),
    result,
    terminal = false,
    answer = '',
    answerBytes = 0,
    searched = false
  const sources = [],
    items = new Set()
  function acceptOnce(item, index) {
    if (!item || typeof item !== 'object') throw new Error('Invalid subscription completion')
    const key = typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(item.id) ? item.id : index
    if (typeof key !== 'string' && (!Number.isInteger(key) || key < 0 || key >= 128))
      throw new Error('Invalid subscription completion')
    if (items.has(key)) return
    if (items.size >= 32) throw new Error('Subscription event exceeds limit')
    items.add(key)
    acceptItem(item)
  }
  function acceptItem(item) {
    if (item.type === 'web_search_call') {
      if (item.status !== 'completed') throw new Error('Subscription search incomplete')
      searched = true
    }
    if (item.type !== 'message' || item.phase === 'commentary') return
    if (item.role !== undefined && item.role !== 'assistant') throw new Error('Invalid subscription completion')
    if (item.status !== undefined && item.status !== 'completed') throw new Error('Invalid subscription completion')
    for (const part of item.content ?? []) {
      if (part.type !== 'output_text') continue
      if (typeof part.text === 'string') {
        for (const character of part.text) {
          const point = character.codePointAt(0)
          const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
          if (answerBytes + size > 3000) break
          answer += character
          answerBytes += size
        }
      }
      for (const citation of part.annotations ?? []) {
        if (sources.length >= 6) break
        if (
          citation.type !== 'url_citation' ||
          typeof citation.url !== 'string' ||
          !/^https?:\/\/[A-Za-z0-9][^\s]*$/.test(citation.url) ||
          citation.url.length > 512 ||
          sources.some((source) => source.url === citation.url)
        )
          continue
        let url
        try {
          url = encodeURI(citation.url)
        } catch {
          continue
        }
        if (url.length > 512) continue
        sources.push({ url, title: String(citation.title ?? '').slice(0, 100) })
      }
    }
  }
  function event(text) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') return
    const value = JSON.parse(data)
    if (['response.failed', 'response.incomplete', 'error'].includes(value.type)) {
      terminal = true
      result = {
        error: 'subscription_incomplete',
        ...subscriptionErrorMetadata(JSON.stringify({ error: value.error ?? value.response?.error ?? value })),
      }
    } else if (value.type === 'response.output_item.done') {
      acceptOnce(value.item, value.output_index)
    } else if (value.type === 'response.completed') {
      terminal = true
      const response = value.response
      if (
        !response ||
        typeof response !== 'object' ||
        Array.isArray(response) ||
        (response.status !== undefined && response.status !== 'completed')
      )
        throw new Error('Invalid subscription completion')
      if (Array.isArray(response.output))
        for (let index = 0; index < response.output.length; index++) acceptOnce(response.output[index], index)
      else if (!items.size) throw new Error('Invalid subscription completion')

      result =
        !searched && sources.length
          ? { error: 'search_missing_tool' }
          : !answer.trim()
            ? { error: 'subscription_empty' }
            : searched && !sources.length
              ? { error: 'search_missing_sources' }
              : { answer, sources: searched ? sources : [], searched }
    }
  }
  return {
    get complete() {
      return terminal
    },
    write(bytes) {
      if (terminal) return
      let input = bytes
      if (carry.length) {
        input = new Uint8Array(carry.length + bytes.length)
        input.set(carry)
        input.set(bytes, carry.length)
      }
      let end = input.length
      if (end) {
        let start = end - 1
        while (start > 0 && (input[start] & 0xc0) === 0x80) start--
        const first = input[start]
        const required = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4
        if (end - start < required) end = start
      }
      carry = input.slice(end)
      if (carry.length > 3) throw new Error('Invalid subscription UTF-8')
      pending += decode(input.subarray(0, end)).replace(/\r/g, '')
      let delimiter = pending.indexOf('\n\n')
      while (delimiter >= 0) {
        if (delimiter > 32768) throw new Error('Subscription event exceeds limit')
        event(pending.slice(0, delimiter))
        pending = pending.slice(delimiter + 2)
        if (terminal) {
          pending = ''
          carry = new Uint8Array()
          break
        }
        delimiter = pending.indexOf('\n\n')
      }
      if (pending.length > 32768) throw new Error('Subscription event exceeds limit')
    },
    finish() {
      if (carry.length || pending.trim() || !terminal) throw new Error('Subscription stream ended before completion')
      return encode(JSON.stringify(result))
    },
  }
}
