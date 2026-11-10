// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0
// The HTTP VM is owned by its caller VM; audio, UI and TLS never share a queue.
export function createHttpProxy({ createWorker, releaseWorker, normalize, decode, schedule, cancel, now }) {
  let worker, lastPosted, lastIdle
  let sequence = 0
  const pending = new Map()
  function release(created) {
    worker = undefined
    lastPosted = undefined
    lastIdle = undefined
    releaseWorker(created)
  }
  function releaseIdle(created) {
    if (releaseWorker && worker === created && !pending.size && lastIdle !== undefined && lastIdle === lastPosted)
      release(created)
  }
  function getWorker() {
    if (worker) return worker
    const created = createWorker()
    created.onmessage = (message) => {
      if (worker !== created) return
      // Caller deadlines do not prove that TLS/socket cleanup has completed.
      // Only the Worker's idle acknowledgement may release an active VM. An
      // older acknowledgement cannot retire a Worker with newly posted work.
      // A queue-expired request may have no reply: retain its acknowledgement
      // until the caller's later deadline removes the final pending request.
      if (message.idle !== undefined) {
        if (message.idle === lastPosted) lastIdle = message.idle
        releaseIdle(created)
        return
      }
      const job = pending.get(message.id)
      if (!job) return
      pending.delete(message.id)
      cancel(job.timer)
      if (message.error) job.reject(new Error(message.error))
      else
        job.resolve({
          status: message.status,
          ok: message.status >= 200 && message.status < 300,
          location: message.location,
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
        releaseIdle(activeWorker)
      }
      try {
        job.timer = schedule(() => cancelRequest('HTTPS request timed out'), request.timeoutMs)
        pending.set(id, job)
        activeWorker.postMessage({ id, started, request })
        lastPosted = id
        lastIdle = undefined
      } catch (error) {
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
