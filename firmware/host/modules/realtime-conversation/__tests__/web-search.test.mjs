import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebSearchTool, summarizeWebSearchResponse } from '../web-search.js'

test('search summaries bound answer and sources and reject answers without a completed search', () => {
  const response = {
    status: 'completed',
    output: [
      { type: 'web_search_call', status: 'completed' },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'word '.repeat(3000),
            annotations: Array.from({ length: 12 }, (_, i) => ({
              type: 'url_citation',
              url: `https://example.com/${i}`,
              title: 'title',
            })),
          },
        ],
      },
    ],
  }
  const result = summarizeWebSearchResponse(JSON.stringify(response))
  assert.equal(result.answer.length, 3000)
  assert.equal(result.sources.length, 6)
  response.output.shift()
  assert.equal(summarizeWebSearchResponse(JSON.stringify(response)).error, 'search_not_performed')
  response.status = 'incomplete'
  assert.equal(summarizeWebSearchResponse(JSON.stringify(response)).error, 'search_incomplete')
})

test('only one search request can run and cancellation reaches its HTTPS request', async () => {
  let complete,
    cancel,
    requests = 0,
    cancelled = 0
  const tool = createWebSearchTool({
    apiKey: 'test-only',
    model: 'backend',
    fetch(_url, init) {
      requests++
      assert.equal(init.responseFormat, 'web-search')
      const promise = new Promise((resolve) => {
        complete = resolve
      })
      promise.cancel = () => {
        cancelled++
      }
      return promise
    },
  })
  let stopped = false
  const context = {
    isCancelled: () => stopped,
    onCancel(fn) {
      cancel = fn
      return () => {}
    },
  }
  const first = tool.execute({ query: 'current fact' }, context)
  assert.equal((await tool.execute({ query: 'other fact' }, context)).error, 'search_busy')
  assert.equal(requests, 1)
  stopped = true
  cancel()
  complete({ ok: true, text: async () => '{"answer":"late","sources":[]}' })
  assert.equal((await first).error, 'search_cancelled')
  assert.equal(cancelled, 1)
})
