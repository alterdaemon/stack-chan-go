import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { usePreferences } from '@/features/preferences/use-preferences'
import { type PreferenceKey } from '@/features/preferences/preference-model'
import { type PreferenceClient, type PreferenceValue } from '@/services/preferences/ble-preference-client'

describe('usePreferences', () => {
  it('changes WWW password over BLE without HTTP authentication and clears the field after saving', async () => {
    let notify: (value: PreferenceValue) => void = () => {}
    const send = vi.fn(async () => {})
    const { result } = renderHook(() =>
      usePreferences((onValue) => {
        notify = onValue
        return { connect: async () => {}, disconnect: async () => {}, isConnected: () => true, send }
      })
    )
    act(() => notify({ prop: 'www.password', value: '' }))
    expect(result.current.wwwAvailable).toBe(true)
    act(() => result.current.update('www.password', 'new-password'))
    await act(() => result.current.save())
    expect(send).toHaveBeenCalledWith({ _batch: { 'www.password': 'new-password' } })
    expect(result.current.values['www.password']).toBe('')
    send.mockClear()
    await act(() => result.current.save())
    expect(send).not.toHaveBeenCalled()
  })

  it('receives OpenAI defaults and saves only changed provider fields', async () => {
    let notify: (value: PreferenceValue) => void = () => {}
    const send = vi.fn(async () => {})
    const { result } = renderHook(() =>
      usePreferences((onValue) => {
        notify = onValue
        return { connect: async () => {}, disconnect: async () => {}, isConnected: () => true, send }
      })
    )
    expect(result.current.openaiAvailable).toBe(false)
    act(() => {
      notify({ prop: 'openailive.backendModel', value: 'firmware-backend' })
      notify({ prop: 'openailive.reasoningEffort', value: 'medium' })
    })
    expect(result.current.values['openailive.backendModel']).toBe('firmware-backend')
    expect(result.current.openaiAvailable).toBe(true)
    expect(result.current.values['openailive.reasoningEffort']).toBe('medium')
    await act(() => result.current.save())
    expect(send).not.toHaveBeenCalled()
    act(() => {
      result.current.update('openailive.backendModel', 'saved-backend')
      result.current.update('openailive.reasoningEffort', 'none')
    })
    await act(() => result.current.save())
    expect(send).toHaveBeenCalledWith({
      _batch: { 'openailive.backendModel': 'saved-backend', 'openailive.reasoningEffort': 'none' },
    })
    send.mockClear()
    await act(() => result.current.save())
    expect(send).not.toHaveBeenCalled()
  })

  it.each<[PreferenceKey, string]>([
    ['openailive.backendModel', ''],
    ['openailive.backendModel', '   '],
    ['openailive.reasoningEffort', 'unsupported'],
  ])('rejects invalid OpenAI preference %s=%j before sending', async (key, value) => {
    const send = vi.fn(async () => {})
    const { result } = renderHook(() =>
      usePreferences(() => ({ connect: async () => {}, disconnect: async () => {}, isConnected: () => true, send }))
    )
    act(() => result.current.update(key, value))
    await act(() => result.current.save())
    expect(send).not.toHaveBeenCalled()
    expect(result.current.operation.status).toBe('error')
  })

  it('does not carry OpenAI support or unsaved edits to a device that does not advertise it', async () => {
    let notify: (value: PreferenceValue) => void = () => {}
    const send = vi.fn(async () => {})
    const { result } = renderHook(() =>
      usePreferences((onValue) => {
        notify = onValue
        return { connect: async () => {}, disconnect: async () => {}, isConnected: () => true, send }
      })
    )
    await act(() => result.current.connect())
    act(() => notify({ prop: 'openailive.backendModel', value: 'first-backend' }))
    act(() => result.current.update('openailive.backendModel', 'unsaved-backend'))
    expect(result.current.openaiAvailable).toBe(true)
    await act(() => result.current.disconnect())
    await act(() => result.current.connect())
    expect(result.current.openaiAvailable).toBe(false)
    expect(result.current.values['openailive.backendModel']).toBe('')
    await act(() => result.current.save())
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps remote values, dirty fields, and batched save in application state', async () => {
    let connected = false
    let notify: (value: PreferenceValue) => void = () => {}
    const send = vi.fn(async () => {})
    const client: PreferenceClient = {
      connect: async () => {
        connected = true
      },
      disconnect: async () => {
        connected = false
      },
      isConnected: () => connected,
      send,
    }
    const { result } = renderHook(() =>
      usePreferences((onValue) => {
        notify = onValue
        return client
      })
    )

    await act(() => result.current.connect())
    expect(result.current.connected).toBe(true)
    act(() => notify({ prop: 'wifi.ssid', value: 'stackchan' }))
    expect(result.current.values['wifi.ssid']).toBe('stackchan')
    act(() => result.current.update('wifi.ssid', 'new-network'))
    act(() => notify({ prop: 'wifi.ssid', value: 'stale-remote' }))
    expect(result.current.values['wifi.ssid']).toBe('new-network')
    await act(() => result.current.save())
    expect(send).toHaveBeenCalledWith({ _batch: { 'wifi.ssid': 'new-network' } })
  })

  it('does not edit fields marked read-only by the device', () => {
    let notify: (value: PreferenceValue) => void = () => {}
    const client: PreferenceClient = {
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      send: async () => {},
    }
    const { result } = renderHook(() =>
      usePreferences((onValue) => {
        notify = onValue
        return client
      })
    )
    act(() => notify({ prop: 'driver.type', value: 'fixed', readOnly: true }))
    act(() => result.current.update('driver.type', 'changed'))
    expect(result.current.values['driver.type']).toBe('fixed')
  })

  it('loads and saves the MCP server token', async () => {
    let notify: (value: PreferenceValue) => void = () => {}
    const send = vi.fn(async () => {})
    const client: PreferenceClient = {
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      send,
    }
    const { result } = renderHook(() =>
      usePreferences((onValue) => {
        notify = onValue
        return client
      })
    )

    act(() => notify({ prop: 'mcp.token', value: 'old-token' }))
    expect(result.current.values['mcp.token']).toBe('old-token')

    act(() => result.current.update('mcp.token', 'new-token'))
    await act(() => result.current.save())

    expect(send).toHaveBeenCalledWith({ _batch: { 'mcp.token': 'new-token' } })
  })

  it('does not save a field reverted to its current device value', async () => {
    let notify: (value: PreferenceValue) => void = () => {}
    const send = vi.fn(async () => {})
    const client: PreferenceClient = {
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      send,
    }
    const { result } = renderHook(() =>
      usePreferences((onValue) => {
        notify = onValue
        return client
      })
    )
    act(() => notify({ prop: 'wifi.ssid', value: 'stackchan' }))
    act(() => result.current.update('wifi.ssid', 'new-network'))
    act(() => result.current.update('wifi.ssid', 'stackchan'))

    await act(() => result.current.save())

    expect(send).not.toHaveBeenCalled()
    expect(result.current.operation).toMatchObject({ status: 'cancelled' })
  })

  it('keeps cleared Wi-Fi fields retryable when the immediate save fails', async () => {
    let notify: (value: PreferenceValue) => void = () => {}
    const send = vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce(undefined)
    const client: PreferenceClient = {
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      send,
    }
    const { result } = renderHook(() =>
      usePreferences((onValue) => {
        notify = onValue
        return client
      })
    )
    act(() => {
      notify({ prop: 'wifi.ssid', value: 'stackchan' })
      notify({ prop: 'wifi.password', value: 'secret' })
    })

    await act(() => result.current.clearWifi())
    expect(result.current.operation.status).toBe('error')

    await act(() => result.current.save())
    expect(send).toHaveBeenNthCalledWith(1, { _batch: { 'wifi.ssid': '', 'wifi.password': '' } })
    expect(send).toHaveBeenNthCalledWith(2, { _batch: { 'wifi.ssid': '', 'wifi.password': '' } })
    expect(result.current.operation.status).toBe('success')
  })

  it('contains disconnect failures during unmount cleanup', async () => {
    const disconnect = vi.fn(async () => {
      throw new Error('adapter already closed')
    })
    const client: PreferenceClient = {
      connect: async () => {},
      disconnect,
      isConnected: () => true,
      send: async () => {},
    }
    const { unmount } = renderHook(() => usePreferences(() => client))

    unmount()
    await Promise.resolve()

    expect(disconnect).toHaveBeenCalledOnce()
  })
})
