// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0

// Realtime function -> hosted Responses search. No audio or full history is copied.
// https://developers.openai.com/api/docs/guides/tools-web-search
export function createWebSearchTool({ fetch, apiKey, model, reasoningEffort, onEvent }) {
  let pending = false
  return {
    name: 'search_web',
    description: 'Search the internet for current facts. Return a short answer with sources. Use only when needed.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A self-contained search question, including necessary context.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute({ query }, context) {
      if (typeof query !== 'string' || !query.trim() || query.length > 1024) return { error: 'invalid_query' }
      if (pending) return { error: 'search_busy' }
      if (context.isCancelled()) return { error: 'search_cancelled' }
      pending = true
      onEvent?.({ type: 'local.search.started', call_id: context.callId })
      let unsubscribe
      try {
        const request = fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeoutMs: 45000,
          responseFormat: 'web-search',
          body: JSON.stringify({
            model,
            ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
            instructions:
              'Search for the requested facts. Answer briefly in the question language and cite your sources.',
            input: query.trim(),
            tools: [{ type: 'web_search', search_context_size: 'low' }],
            tool_choice: 'required',
            max_output_tokens: 2048,
            store: false,
          }),
        })
        unsubscribe = context.onCancel(() => request.cancel?.())
        const response = await request
        if (!response.ok) return { error: 'search_http_error', status: response.status }
        const text = await response.text()
        if (context.isCancelled()) return { error: 'search_cancelled' }
        if (typeof text !== 'string' || text.length > 8192) return { error: 'search_response_limit' }
        return JSON.parse(text)
      } finally {
        unsubscribe?.()
        pending = false
        onEvent?.({ type: 'local.search.finished', call_id: context.callId })
      }
    },
  }
}

// Runs in the HTTP worker before crossing back to the UI VM.
export function summarizeWebSearchResponse(text) {
  const result = JSON.parse(text)
  if (result.status !== 'completed') return { error: 'search_incomplete' }
  if (!result.output?.some((item) => item.type === 'web_search_call' && item.status === 'completed'))
    return { error: 'search_not_performed' }
  let answer = ''
  const sources = []
  for (const item of result.output ?? []) {
    if (item.type !== 'message') continue
    for (const part of item.content ?? []) {
      if (part.type !== 'output_text') continue
      if (typeof part.text === 'string') answer = (answer + part.text).slice(0, 3000)
      for (const citation of part.annotations ?? []) {
        if (sources.length >= 6) break
        if (
          citation.type !== 'url_citation' ||
          typeof citation.url !== 'string' ||
          !/^https?:\/\//.test(citation.url) ||
          citation.url.length > 512 ||
          sources.some((source) => source.url === citation.url)
        )
          continue
        sources.push({ url: citation.url, title: String(citation.title ?? '').slice(0, 100) })
      }
    }
  }
  return answer ? { answer, sources } : { error: 'search_empty' }
}
