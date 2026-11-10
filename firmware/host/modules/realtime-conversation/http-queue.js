// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0

export function createHttpQueue({ execute, post, schedule, elapsed }) {
  let tail = Promise.resolve(),
    queued = 0
  const jobs = new Map()
  function reply(message, remaining) {
    return new Promise((resolve) => {
      const send = () => {
        const left = remaining()
        if (left <= 0) return resolve()
        try {
          post(message)
          resolve()
        } catch {
          try {
            schedule(send, Math.min(25, left))
          } catch {
            resolve()
          }
        }
      }
      send()
    })
  }
  return ({ id, started, request, cancel }) => {
    if (cancel) {
      const job = jobs.get(id)
      if (job) {
        job.cancelled = true
        job.cancel?.()
      }
      return
    }
    if (queued >= 8) {
      try {
        post({ id, error: 'HTTPS request capacity' })
      } catch {}
      return
    }
    queued++
    const job = { cancelled: false }
    jobs.set(id, job)
    const remaining = () => (job.cancelled ? 0 : request.timeoutMs - elapsed(started))
    tail = tail.then(async () => {
      try {
        const timeoutMs = remaining()
        if (timeoutMs <= 0) return
        let message
        try {
          message = {
            id,
            ...(await execute({ ...request, timeoutMs }, (cancelRequest) => {
              job.cancel = cancelRequest
              if (job.cancelled) cancelRequest()
            })),
          }
        } catch (error) {
          message = { id, error: String(error) }
        }
        await reply(message, remaining)
      } finally {
        queued--
        jobs.delete(id)
      }
    })
    return tail
  }
}
