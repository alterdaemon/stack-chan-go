// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0

import { createClosingClient, drainTLSSocket, guardSocketCallbacks, requestHttps } from 'realtimeConversation/http-core'
import { createHttpQueue } from 'realtimeConversation/http-queue'
import { createSubscriptionStream } from 'realtimeConversation/subscription-stream'
import { summarizeWebSearchResponse } from 'realtimeConversation/web-search'
import tlsCache from 'ssl/cache'
import TextDecoder from 'text/decoder'
import Time from 'time'
import Timer from 'timer'

const decoder = new TextDecoder('utf-8', { fatal: true })
const CheckedTCP = guardSocketCallbacks(device.network.https.client.socket.TCP.io)
let tlsDrains = 0
const DrainingTLS = drainTLSSocket(
  device.network.https.client.socket.io,
  (callback, delay) => Timer.set(callback, delay),
  (timer) => Timer.clear(timer),
  () => tlsDrains++,
)
const platform = {
  createSubscriptionStream: (observe) =>
    createSubscriptionStream(
      (bytes) => decoder.decode(bytes),
      (text) => ArrayBuffer.fromString(text),
      observe,
    ),
  createClient: ({ certificate, drainTLS, statistics, ...options }) =>
    createClosingClient(device.network.https.client.io, {
      ...device.network.https.client,
      ...options,
      socket: {
        ...device.network.https.client.socket,
        io: drainTLS ? DrainingTLS : device.network.https.client.socket.io,
        TCP: {
          ...device.network.https.client.socket.TCP,
          io: statistics ? guardSocketCallbacks(device.network.https.client.socket.TCP.io, statistics) : CheckedTCP,
        },
        tls: { ...device.network.https.client.socket.tls, ...(certificate ? { ca: certificate } : {}) },
      },
    }),
  schedule: (fn, ms) => Timer.set(fn, ms),
  cancel: (timer) => Timer.clear(timer),
}
self.onmessage = createHttpQueue({
  post: (message) => self.postMessage(message),
  // requestHttps resolves only after its deferred HTTP/TLS close. This also
  // acknowledges queued requests that expired without executing HTTPS.
  onIdle: (id, progressDropped, observation) =>
    self.postMessage({ idle: id, ...observation, ...(progressDropped ? { progressDropped } : {}) }),
  schedule: platform.schedule,
  elapsed: (started) => Time.delta(started, Time.ticks),
  async execute(request, setCancel, progress) {
    tlsDrains = 0
    // The SDK session cache keys only by host, without the trust anchor.
    if (request.certificate) tlsCache.deleteSessionID()
    try {
      const response = await requestHttps(request, platform, setCancel, progress)
      if (request.responseFormat === 'web-search' && response.status >= 200 && response.status < 300) {
        const summary = summarizeWebSearchResponse(new TextDecoder().decode(response.body))
        response.body = ArrayBuffer.fromString(JSON.stringify(summary))
      }
      return { ...response, tlsDrains }
    } catch (error) {
      error.tlsDrains = tlsDrains
      throw error
    } finally {
      if (request.certificate) tlsCache.deleteSessionID()
    }
  },
})
