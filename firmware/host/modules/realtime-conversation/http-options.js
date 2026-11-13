// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0
// Keep the OpenAI-compatible HTTPS POST contract independent of the backend.
// Only fixed local categories cross the diagnostic boundary, never exception text.
const failureCodes = Object.freeze({
  'HTTPS request cancelled': 'https_cancelled',
  'HTTPS request timed out': 'https_timeout',
  'HTTPS connection failed': 'https_connection',
  'HTTPS write failed': 'https_write',
  'HTTPS request failed': 'https_transport',
  'HTTPS response exceeds limit': 'https_limit',
  'HTTPS short read': 'https_short_read',
  'Invalid subscription completion': 'subscription_completion',
  'Subscription search incomplete': 'subscription_search_incomplete',
  'Invalid subscription UTF-8': 'subscription_utf8',
  'Subscription event exceeds limit': 'subscription_event_limit',
  'Subscription stream ended before completion': 'subscription_stream_incomplete',
})

export function httpFailureMetadata(error) {
  const metadata = {
    errorCode: Object.hasOwn(failureCodes, error?.message)
      ? failureCodes[error.message]
      : error instanceof SyntaxError
        ? 'subscription_event_json'
        : 'https_local',
  }
  if (['connect', 'write', 'sent', 'headers', 'read', 'finish'].includes(error?.phase)) metadata.phase = error.phase
  for (const name of ['written', 'expected'])
    if (Number.isInteger(error?.[name]) && error[name] >= 0 && error[name] <= 131072) metadata[name] = error[name]
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) metadata.status = error.status
  if (Number.isInteger(error?.received) && error.received >= 0 && error.received <= 2097152)
    metadata.received = error.received
  if (
    [
      'bad_response',
      'bad_state',
      'invalid_protocol',
      'date_validation_failed',
      'too_large',
      'tls_record_data',
      'tls_record_auth',
      'tls_finished_auth',
      'tls_certificate_auth',
      'tls_signature',
      'tls_cipher',
      'tls_compression',
      'tls_alert',
    ].includes(error?.reason)
  )
    metadata.reason = error.reason
  if (Number.isInteger(error?.code) && Math.abs(error.code) <= 2147483647) metadata.code = error.code
  if (Number.isInteger(error?.tlsDrains) && error.tlsDrains >= 0) metadata.tlsDrains = error.tlsDrains
  return metadata
}

export function normalizeRequest(url, options, encode, decodeCertificate) {
  const endpoint = /^https:\/\/([a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?(\/[^\s#]*)$/.exec(url)
  if (!endpoint || options?.method !== 'POST' || (endpoint[2] && (+endpoint[2] < 1 || +endpoint[2] > 65535)))
    throw new URIError('Invalid Live endpoint')
  const headers = []
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(String(value)))
      throw new TypeError('Invalid Live header')
    if (['connection', 'content-length'].includes(name.toLowerCase())) continue
    headers.push([name.toLowerCase(), String(value)])
  }
  const body = encode(String(options.body ?? ''))
  const encodedHeaders = encode(JSON.stringify(headers))
  if (typeof options.certificate === 'string' && options.certificate.length > 16384)
    throw new RangeError('Live HTTPS certificate exceeds limit')
  const certificate =
    typeof options.certificate === 'string' ? decodeCertificate(options.certificate) : options.certificate
  if (
    url.length > 4096 ||
    body.byteLength > 131072 ||
    encodedHeaders.byteLength > 16384 ||
    (certificate && certificate.byteLength > 16384)
  )
    throw new RangeError('Live HTTPS request exceeds limit')
  const requested = Number(options.timeoutMs ?? 45000)
  if (!Number.isFinite(requested)) throw new RangeError('Invalid Live HTTPS deadline')
  return {
    host: endpoint[1],
    port: +(endpoint[2] ?? 443),
    path: endpoint[3],
    headers,
    body,
    certificate,
    responseFormat: ['web-search', 'subscription-response'].includes(options.responseFormat)
      ? options.responseFormat
      : undefined,
    timeoutMs: Math.max(1000, Math.min(45000, requested)),
  }
}
