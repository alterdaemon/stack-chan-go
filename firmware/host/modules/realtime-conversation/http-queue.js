// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0
import { httpFailureMetadata } from './http-options.js'

export function createHttpQueue({ execute, post, schedule, elapsed, onIdle }) {
  let tail = Promise.resolve(),
    queued = 0,
    lastReceived,
    lastNotified
  let progressDropped = 0
  function notifyIdle(id, observation) {
    return Promise.resolve()
      .then(() => {
        if (queued || id !== lastReceived || id === lastNotified) return
        // The caller may terminate this VM as soon as this message arrives.
        // Send outside the queue's async finally and any JS try/catch so XS
        // has already released their native exception frames before teardown.
        onIdle(id, progressDropped, observation)
        lastNotified = id
      })
      .catch(() => {
        // IPC pressure must not strand an otherwise idle Worker indefinitely.
        // The Timer only registers a reaction: its callback must return before
        // another acknowledgement can trigger external Worker termination.
        try {
          schedule(() => notifyIdle(id, observation), 25)
        } catch {}
      })
  }
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
    lastReceived = id
    if (queued >= 8) {
      try {
        post({ id, error: 'HTTPS request capacity' })
      } catch {}
      return
    }
    queued++
    const job = { cancelled: false }
    jobs.set(id, job)
    let idleID, observation
    const remaining = () => (job.cancelled ? 0 : request.timeoutMs - elapsed(started))
    tail = tail.then(async () => {
      try {
        const timeoutMs = remaining()
        if (timeoutMs <= 0) return
        let message
        try {
          message = {
            id,
            ...(await execute(
              { ...request, timeoutMs },
              (cancelRequest) => {
                job.cancel = cancelRequest
                if (job.cancelled) cancelRequest()
              },
              request.diagnostics
                ? (progress) => {
                    try {
                      post({ id, progress })
                    } catch {
                      progressDropped++
                    }
                  }
                : undefined,
            )),
          }
        } catch (error) {
          message = { id, error: String(error), ...httpFailureMetadata(error) }
        }
        if (request.diagnostics) {
          observation = httpFailureMetadata(message)
          if (message.errorCode) observation.errorCode = message.errorCode
          else delete observation.errorCode
        }
        if (progressDropped) message.progressDropped = progressDropped
        await reply(message, remaining)
      } finally {
        queued--
        jobs.delete(id)
        if (!queued) idleID = lastReceived
      }
    })
    // Notification failures are handled on a separate chain so they cannot
    // poison the processing tail or keep later HTTPS requests from starting.
    return onIdle ? tail.then(() => (idleID === undefined ? undefined : notifyIdle(idleID, observation))) : tail
  }
}
