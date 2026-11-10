import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpPreferenceClient, isDeviceSettings } from './http-preference-client'

afterEach(() => {
  vi.unstubAllGlobals()
  document.querySelector('meta[name="stackchan-settings-transport"]')?.remove()
})

describe('HTTP preference transport', () => {
  it('is selected only by the device page marker', () => {
    expect(isDeviceSettings()).toBe(false)
    const meta = document.createElement('meta')
    meta.name = 'stackchan-settings-transport'
    meta.content = 'http'
    document.head.append(meta)
    expect(isDeviceSettings()).toBe(true)
  })

  it('loads device values and flags and sends the same preference batch', async () => {
    const values = [
      { prop: 'driver.type', value: 'm5stackchan', readOnly: true },
      { prop: 'www.password', value: '' },
    ]
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(values)))
      .mockResolvedValueOnce(new Response('{"ok":true}'))
    vi.stubGlobal('fetch', fetch)
    const notify = vi.fn()
    const client = new HttpPreferenceClient(notify)
    await client.connect()
    expect(notify.mock.calls.map(([value]) => value)).toEqual(values)
    expect(client.isConnected()).toBe(true)
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/preferences', { cache: 'no-store', credentials: 'same-origin' })
    const payload = { _batch: { 'openailive.reasoningEffort': 'high' } }
    await client.send(payload)
    expect(fetch).toHaveBeenLastCalledWith('/api/preferences', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Stackchan-Settings': '1' },
      body: JSON.stringify(payload),
    })
    await client.disconnect()
    expect(client.isConnected()).toBe(false)
  })

  it('reports rejected authentication and writes as failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))
    const notify = vi.fn()
    const client = new HttpPreferenceClient(notify)
    await expect(client.connect()).rejects.toThrow('HTTP 401')
    expect(client.isConnected()).toBe(false)
    expect(notify).not.toHaveBeenCalled()
    await expect(client.send({ _batch: {} })).rejects.toThrow('HTTP 401')
  })
})
