// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0
// The HTTP VM is owned by its caller VM; audio, UI and TLS never share a queue.
export function createHttpProxy({ createWorker, normalize, decode, schedule, cancel, now }) {
  const worker = createWorker()
  let sequence = 0
  const pending = new Map()
  worker.onmessage = (message) => {
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
  }

  return (url, options) => {
    let cancelRequest
    const promise = new Promise((resolve, reject) => {
      if (pending.size >= 8) throw new Error('HTTPS request capacity')
      const request = normalize(url, options),
        id = ++sequence
      const started = now()
      const job = { resolve, reject }
      cancelRequest = (message = 'HTTPS request cancelled') => {
        if (!pending.delete(id)) return
        cancel(job.timer)
        try {
          worker.postMessage({ id, cancel: true })
        } catch {}
        reject(new Error(message))
      }
      job.timer = schedule(() => {
        cancelRequest('HTTPS request timed out')
      }, request.timeoutMs)
      pending.set(id, job)
      try {
        worker.postMessage({ id, started, request })
      } catch (error) {
        pending.delete(id)
        cancel(job.timer)
        reject(error)
      }
    })
    promise.cancel = () => cancelRequest?.()
    return promise
  }
}
