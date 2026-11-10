// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0

import { createClosingClient, guardSocketCallbacks, requestHttps } from 'realtimeConversation/http-core'
import { createHttpQueue } from 'realtimeConversation/http-queue'
import { summarizeWebSearchResponse } from 'realtimeConversation/web-search'
import tlsCache from 'ssl/cache'
import TextDecoder from 'text/decoder'
import Time from 'time'
import Timer from 'timer'

const CheckedTCP = guardSocketCallbacks(device.network.https.client.socket.TCP.io)
const platform = {
  createClient: ({ certificate, ...options }) =>
    createClosingClient(device.network.https.client.io, {
      ...device.network.https.client,
      ...options,
      socket: {
        ...device.network.https.client.socket,
        TCP: { ...device.network.https.client.socket.TCP, io: CheckedTCP },
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
  onIdle: (id) => self.postMessage({ idle: id }),
  schedule: platform.schedule,
  elapsed: (started) => Time.delta(started, Time.ticks),
  async execute(request, setCancel) {
    // The SDK session cache keys only by host, without the trust anchor.
    if (request.certificate) tlsCache.deleteSessionID()
    try {
      const response = await requestHttps(request, platform, setCancel)
      if (request.responseFormat === 'web-search' && response.status >= 200 && response.status < 300) {
        const summary = summarizeWebSearchResponse(new TextDecoder().decode(response.body))
        response.body = ArrayBuffer.fromString(JSON.stringify(summary))
      }
      return response
    } finally {
      if (request.certificate) tlsCache.deleteSessionID()
    }
  },
})
