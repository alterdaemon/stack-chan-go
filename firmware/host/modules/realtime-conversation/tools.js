// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0

// Only completed function items are actionable. Terminal response snapshots
// intentionally omit output, so retain items until response.completed.
export default class ToolRunner {
  #tools
  #platform
  #send
  #error
  #notify
  #responses = new Map()
  #active = new Map()
  #seen = new Set()
  #closed = false
  #serial = 0
  #timeout
  #protocol

  constructor(tools, { platform, send, onError, onResult, timeout = 30000, protocol = 'live' }) {
    if (!Array.isArray(tools) || tools.length > 32) throw new TypeError('Invalid tools')
    if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError('Invalid tool timeout')
    this.#tools = new Map()
    this.definitions = tools.map((tool) => {
      if (
        !tool ||
        typeof tool.name !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) ||
        this.#tools.has(tool.name) ||
        typeof tool.execute !== 'function' ||
        !tool.parameters ||
        tool.parameters.type !== 'object'
      )
        throw new TypeError('Invalid tool definition')
      this.#tools.set(tool.name, tool.execute)
      return JSON.parse(
        JSON.stringify({
          type: 'function',
          name: tool.name,
          description: tool.description ?? '',
          parameters: tool.parameters,
          ...(protocol === 'realtime' ? {} : { strict: tool.strict ?? true }),
        }),
      )
    })
    this.#platform = platform
    this.#send = send
    this.#error = onError
    this.#notify = onResult
    this.#timeout = timeout
    this.#protocol = protocol
  }

  receive(envelope) {
    if (this.#protocol === 'realtime') {
      let event = envelope
      if (event.type === 'response.done')
        event = { ...event, type: event.response?.status === 'completed' ? 'response.completed' : 'response.cancelled' }
      envelope = { type: 'response.event', delegation_id: 'realtime', event }
    }
    if (this.#closed || envelope.type !== 'response.event') return
    const event = envelope.event,
      delegation = envelope.delegation_id
    if (!event || typeof delegation !== 'string') return
    if (event.type === 'response.created') {
      const id = event.response?.id
      if (typeof id !== 'string') throw new Error('Missing tool response ID')
      if (this.#responses.has(id)) return
      if (this.#responses.size >= 8) throw new Error('Too many tool responses')
      this.#responses.set(id, { id, delegation, calls: new Map(), terminal: false, cancelled: false, waits: new Set() })
      this.#active.set(delegation, id)
      return
    }
    const id = event.response?.id ?? event.response_id ?? this.#active.get(delegation)
    const response = this.#responses.get(id)
    if (!response || response.delegation !== delegation) return
    if (['response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type)) {
      this.#retire(response, true)
      return
    }
    if (response.terminal) return
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      const item = event.item
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string')
        throw new Error('Invalid completed function call')
      if (this.#seen.has(item.call_id)) return
      // A bounded session-wide ledger prevents replaying operations.
      if (this.#seen.size >= 256 || response.calls.size >= 16) throw new Error('Tool call limit exceeded')
      this.#seen.add(item.call_id)
      response.calls.set(item.call_id, { callId: item.call_id, name: item.name, arguments: item.arguments })
    } else if (event.type === 'response.completed') {
      response.terminal = true
      void this.#run(response)
    }
  }

  async #execute(response, call) {
    this.#diagnose('start', response, call)
    const cancellations = new Set()
    const cancelWork = () => {
      for (const cancel of cancellations) {
        try {
          cancel()
        } catch {}
      }
      cancellations.clear()
    }
    const context = {
      callId: call.callId,
      responseId: response.id,
      delegationId: response.delegation,
      isCancelled: () => this.#closed || response.cancelled || timedOut,
      onCancel: (cancel) => {
        if (context.isCancelled()) cancel()
        else cancellations.add(cancel)
        return () => cancellations.delete(cancel)
      },
    }
    let timer,
      finish,
      timedOut = false
    const stop = new Promise((resolve) => {
      finish = resolve
    })
    const cancelExecution = () => {
      this.#diagnose('cancel', response, call)
      cancelWork()
      finish({ error: 'tool_cancelled' })
    }
    response.waits.add(cancelExecution)
    timer = this.#platform.setTimeout(() => {
      this.#diagnose('timeout', response, call)
      timedOut = true
      cancelWork()
      finish({ error: 'tool_timeout' })
    }, this.#timeout)
    const operation = Promise.resolve().then(async () => {
      if (context.isCancelled()) return { error: 'tool_cancelled' }
      const execute = this.#tools.get(call.name)
      if (!execute) return { error: 'unknown_tool' }
      let args
      try {
        if (typeof call.arguments !== 'string' || call.arguments.length > 16384) throw new Error()
        args = JSON.parse(call.arguments)
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error()
      } catch {
        return { error: 'invalid_arguments' }
      }
      try {
        const value = await execute(args, context)
        this.#diagnose('result', response, call, value)
        const output = typeof value === 'string' ? value : JSON.stringify(value)
        if (typeof output !== 'string' || output.length > 8192) return { error: 'invalid_tool_output' }
        return { output }
      } catch {
        this.#diagnose('failure', response, call, { error: 'tool_execution_failed' })
        return { error: 'tool_execution_failed' }
      }
    })
    try {
      return await Promise.race([operation, stop])
    } finally {
      this.#platform.clearTimeout(timer)
      response.waits.delete(cancelExecution)
      cancellations.clear()
    }
  }

  async #run(response) {
    try {
      const calls = Array.from(response.calls.values())
      const results = await Promise.all(calls.map((call) => this.#execute(response, call)))
      if (this.#closed || response.cancelled) return
      for (let i = 0; i < calls.length; i++) {
        if (this.#closed || response.cancelled) return
        const call = calls[i],
          result = results[i]
        call.sent = true
        this.#send({
          type: this.#protocol === 'realtime' ? 'conversation.item.create' : 'response.item.create',
          event_id: `tool_result_${++this.#serial}`,
          item: {
            type: 'function_call_output',
            call_id: call.callId,
            output: result.output ?? JSON.stringify({ error: result.error }),
          },
        })
        this.#notify?.({
          name: call.name,
          callId: call.callId,
          responseId: response.id,
          delegationId: response.delegation,
          ...result,
        })
      }
      if (calls.length && !this.#closed && !response.cancelled)
        this.#send({ type: 'response.create', event_id: `tool_continue_${++this.#serial}` })
    } catch (error) {
      if (!this.#closed) this.#error(error)
    } finally {
      this.#retire(response)
    }
  }

  #retire(response, reportCancellation = false) {
    if (response.cancelled) return
    response.cancelled = true
    // Cancel local work before any send can throw, and retire ownership even
    // when the transport is already failing.
    for (const finish of response.waits) finish({ error: 'tool_cancelled' })
    this.#responses.delete(response.id)
    if (this.#active.get(response.delegation) === response.id) this.#active.delete(response.delegation)
    if (reportCancellation && !this.#closed) {
      for (const call of response.calls.values()) {
        if (call.sent) continue
        call.sent = true
        this.#send({
          type: this.#protocol === 'realtime' ? 'conversation.item.create' : 'response.item.create',
          event_id: `tool_cancel_${++this.#serial}`,
          item: {
            type: 'function_call_output',
            call_id: call.callId,
            output: JSON.stringify({ error: 'tool_cancelled' }),
          },
        })
      }
    }
  }
  cancelPending(reportCancellation = false) {
    for (const response of this.#responses.values()) this.#retire(response, reportCancellation)
  }
  close() {
    this.#closed = true
    this.cancelPending()
    this.#tools.clear()
    this.#seen.clear()
  }

  #diagnose(event, response, call, result) {
    if (!this.#platform.debug?.enabled) return
    this.#platform.debug.event('tool', event, {
      response_id: response.id,
      call_id: call.callId,
      tool: call.name,
      errorCode: result?.error,
      status: result?.status,
    })
  }
}
