// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0
// The HTTP VM is owned by its caller VM; audio, UI and TLS never share a queue.
export function createHttpProxy({ createWorker, releaseWorker, normalize, decode, schedule, cancel, now, diagnose }) {
  let worker, lastPosted, lastIdle
  let sequence = 0
  const pending = new Map()
  function release(created) {
    worker = undefined
    lastPosted = undefined
    lastIdle = undefined
    releaseWorker(created)
    diagnose?.('worker.released')
  }
  function releaseIdle(created) {
    if (releaseWorker && worker === created && !pending.size && lastIdle !== undefined && lastIdle === lastPosted)
      release(created)
  }
  function getWorker() {
    if (worker) return worker
    const created = createWorker()
    diagnose?.('worker.created')
    created.onmessage = (message) => {
      if (worker !== created) return
      // Caller deadlines do not prove that TLS/socket cleanup has completed.
      // Only the Worker's idle acknowledgement may release an active VM. An
      // older acknowledgement cannot retire a Worker with newly posted work.
      // A queue-expired request may have no reply: retain its acknowledgement
      // until the caller's later deadline removes the final pending request.
      if (message.idle !== undefined) {
        diagnose?.('worker.idle', () => ({ request: message.idle }))
        if (message.idle === lastPosted) lastIdle = message.idle
        releaseIdle(created)
        return
      }
      const job = pending.get(message.id)
      if (!job) return
      const metadata = {
        status: message.status,
        errorCode: message.errorCode,
        phase: message.phase,
        received: message.received,
      }
      diagnose?.(message.error ? 'job.failed' : 'job.response', () => ({ request: message.id, ...metadata }))
      pending.delete(message.id)
      cancel(job.timer)
      if (message.error) job.reject(Object.assign(new Error(message.error), metadata))
      else
        job.resolve({
          status: message.status,
          ok: message.status >= 200 && message.status < 300,
          location: message.location,
          headers: message.headers,
          text: async () => decode(message.body),
        })
      releaseIdle(created)
    }
    worker = created
    return worker
  }

  return (url, options) => {
    let cancelRequest
    const promise = new Promise((resolve, reject) => {
      if (pending.size >= 8) throw new Error('HTTPS request capacity')
      const request = normalize(url, options),
        id = ++sequence
      const kind =
        request.host === 'auth.openai.com'
          ? 'auth'
          : request.host === 'chatgpt.com'
            ? request.path.startsWith('/backend-api/codex/realtime/calls')
              ? 'call'
              : 'backend'
            : 'other'
      const activeWorker = getWorker()
      const started = now()
      const job = { resolve, reject }
      cancelRequest = (message = 'HTTPS request cancelled') => {
        if (!pending.delete(id)) return
        cancel(job.timer)
        if (worker === activeWorker && lastIdle !== lastPosted) {
          try {
            activeWorker.postMessage({ id, cancel: true })
          } catch {}
        }
        reject(new Error(message))
        diagnose?.('job.cancelled', () => ({
          request: id,
          kind,
          reason: message === 'HTTPS request timed out' ? 'timeout' : 'cancelled',
        }))
        releaseIdle(activeWorker)
      }
      try {
        job.timer = schedule(() => cancelRequest('HTTPS request timed out'), request.timeoutMs)
        pending.set(id, job)
        activeWorker.postMessage({ id, started, request })
        diagnose?.('job.posted', () => ({ request: id, kind }))
        lastPosted = id
        lastIdle = undefined
      } catch (error) {
        diagnose?.('job.failed', () => ({ request: id, kind, reason: 'post' }))
        pending.delete(id)
        if (job.timer !== undefined) cancel(job.timer)
        // A reused Worker may still be cleaning up work whose caller timed out.
        if (releaseWorker && lastPosted === undefined) release(activeWorker)
        else releaseIdle(activeWorker)
        reject(error)
      }
    })
    promise.cancel = () => cancelRequest?.()
    return promise
  }
}
