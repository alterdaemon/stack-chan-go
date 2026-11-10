import { useCallback, useEffect, useRef, useState } from 'react'

import {
  DEFAULT_PREFERENCES,
  isPreferenceKey,
  isLiveVoicePreference,
  OPENAI_REASONING_EFFORTS,
  type PreferenceKey,
  type PreferenceValues,
} from '@/features/preferences/preference-model'
import { type OperationState } from '@/features/operations/operation-state'
import { AppError, toAppError } from '@/lib/errors/app-error'
import {
  BlePreferenceClient,
  type PreferenceClient,
  type PreferenceValue,
} from '@/services/preferences/ble-preference-client'
import { HttpPreferenceClient, isDeviceSettings } from '@/services/preferences/http-preference-client'

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting'
type ClientFactory = (onValue: (value: PreferenceValue) => void) => PreferenceClient
const defaultClientFactory: ClientFactory = (onValue) =>
  isDeviceSettings() ? new HttpPreferenceClient(onValue) : new BlePreferenceClient({ deviceName: 'STK', onValue })

export function usePreferences(clientFactory: ClientFactory = defaultClientFactory) {
  const http = isDeviceSettings()
  const [connection, setConnection] = useState<ConnectionState>('disconnected')
  const [values, setValues] = useState<PreferenceValues>(DEFAULT_PREFERENCES)
  const [readOnly, setReadOnly] = useState<Set<PreferenceKey>>(() => new Set())
  const [operation, setOperation] = useState<OperationState>({ status: 'idle' })
  const currentValues = useRef<Partial<PreferenceValues>>({})
  const dirty = useRef(new Set<PreferenceKey>())
  const readOnlyRef = useRef(new Set<PreferenceKey>())
  const valueHandler = useRef<(value: PreferenceValue) => void>(() => {})
  const client = useRef<PreferenceClient | undefined>(undefined)

  valueHandler.current = ({ prop, value, readOnly: isReadOnly = false }) => {
    if (!isPreferenceKey(prop)) return
    const normalized = String(value)
    currentValues.current[prop] = normalized
    const nextReadOnly = new Set(readOnlyRef.current)
    if (isReadOnly) {
      nextReadOnly.add(prop)
      dirty.current.delete(prop)
    } else {
      nextReadOnly.delete(prop)
    }
    readOnlyRef.current = nextReadOnly
    setReadOnly(nextReadOnly)
    if (!dirty.current.has(prop)) setValues((current) => ({ ...current, [prop]: normalized }))
  }

  if (!client.current) client.current = clientFactory((value) => valueHandler.current(value))

  useEffect(() => {
    const activeClient = client.current
    if (!activeClient) return
    activeClient.onDisconnected = () => {
      setConnection('disconnected')
      setOperation({
        status: 'cancelled',
        message: '接続が切れました。保存されていない項目を確認してください。',
      })
      currentValues.current = {}
      dirty.current.clear()
      readOnlyRef.current = new Set()
      setReadOnly(new Set())
    }
    return () => {
      activeClient.onDisconnected = undefined
      if (activeClient.isConnected()) activeClient.disconnect().catch(() => {})
    }
  }, [])

  const connect = useCallback(async () => {
    const activeClient = client.current
    if (!activeClient) return
    // A new device must advertise these fields before they become editable.
    for (const key of [
      'openailive.backendModel',
      'openailive.reasoningEffort',
      'openailive.bargeIn',
      'openailive.voice',
      'openailive.pitch',
      'openailive.style',
      'openailive.standbySeconds',
      'www.password',
    ] as const) {
      delete currentValues.current[key]
      dirty.current.delete(key)
    }
    setValues((current) => ({
      ...current,
      'openailive.backendModel': '',
      'openailive.reasoningEffort': '',
      'openailive.bargeIn': '0',
      'openailive.voice': 'marin',
      'openailive.pitch': '0',
      'openailive.style': 'default',
      'openailive.standbySeconds': '60',
      'www.password': '',
    }))
    setConnection('connecting')
    setOperation({ status: 'pending', message: http ? 'Wi-Fiで接続しています' : 'BLEデバイスを検索しています' })
    try {
      await activeClient.connect()
      setConnection('connected')
      setOperation({ status: 'success', result: undefined, message: 'ｽﾀｯｸﾁｬﾝへ接続しました' })
    } catch (error) {
      setConnection('disconnected')
      setOperation({ status: 'error', error: toAppError(error, 'ble-connect') })
    }
  }, [http])

  useEffect(() => {
    if (http) void connect()
  }, [http, connect])

  const disconnect = useCallback(async () => {
    const activeClient = client.current
    if (!activeClient) return
    setConnection('disconnecting')
    try {
      await activeClient.disconnect()
      setConnection('disconnected')
      setOperation({ status: 'cancelled', message: http ? 'Wi-Fi接続を切断しました' : 'BLE接続を切断しました' })
    } catch (error) {
      setConnection(activeClient.isConnected() ? 'connected' : 'disconnected')
      setOperation({ status: 'error', error: toAppError(error, 'ble-disconnect') })
    }
  }, [http])

  const update = useCallback((key: PreferenceKey, value: string) => {
    if (
      readOnlyRef.current.has(key) ||
      ([
        'openailive.bargeIn',
        'openailive.voice',
        'openailive.pitch',
        'openailive.style',
        'openailive.standbySeconds',
      ].includes(key) &&
        currentValues.current[key] === undefined)
    )
      return
    if (currentValues.current[key] === value) dirty.current.delete(key)
    else dirty.current.add(key)
    setValues((current) => ({ ...current, [key]: value }))
  }, [])

  const savePayload = useCallback(
    async (payload: Partial<PreferenceValues>, successMessage: string) => {
      const activeClient = client.current
      if (!activeClient?.isConnected()) return
      const entries = Object.entries(payload).filter(
        ([key, value]) => !readOnlyRef.current.has(key as PreferenceKey) && (key !== 'www.password' || value !== '')
      )
      const model = payload['openailive.backendModel']
      const effort = payload['openailive.reasoningEffort']
      if (payload['www.password'] && /[\u0000-\u001f\u007f]/.test(payload['www.password'])) {
        setOperation({
          status: 'error',
          error: new AppError('invalid-www-password', 'WWWのパスワードに制御文字は使用できません。'),
        })
        return
      }
      if (
        (model !== undefined && !model.trim()) ||
        entries.some(([key, value]) => !isLiveVoicePreference(key, value)) ||
        (effort !== undefined && !(OPENAI_REASONING_EFFORTS as readonly string[]).includes(effort)) ||
        (payload['openailive.bargeIn'] !== undefined && !['0', '1'].includes(payload['openailive.bargeIn']))
      ) {
        setOperation({
          status: 'error',
          error: new AppError('invalid-openai-settings', 'OpenAIの設定値を確認してください。'),
        })
        return
      }
      if (entries.length === 0) {
        setOperation({ status: 'cancelled', message: '変更する項目がありません。' })
        return
      }
      const batch = Object.fromEntries(entries)
      setOperation({ status: 'pending', message: '設定を保存しています' })
      try {
        await activeClient.send({ _batch: batch })
        for (const [key, value] of entries) {
          const preferenceKey = key as PreferenceKey
          currentValues.current[preferenceKey] = key === 'www.password' ? '' : value
          dirty.current.delete(preferenceKey)
        }
        if (batch['www.password']) {
          setValues((current) => ({ ...current, 'www.password': '' }))
          // A top-level navigation lets the browser ask for the new Basic Auth password.
          if (http) window.location.reload()
        }
        setOperation({ status: 'success', result: undefined, message: successMessage })
      } catch (error) {
        setOperation({ status: 'error', error: toAppError(error, 'preference-save') })
      }
    },
    [http]
  )

  const save = useCallback(() => {
    const payload: Partial<PreferenceValues> = {}
    for (const key of dirty.current) {
      if (!readOnlyRef.current.has(key) && currentValues.current[key] !== values[key]) {
        payload[key] = values[key]
      }
    }
    return savePayload(payload, '設定を送信しました。')
  }, [savePayload, values])

  const clearWifi = useCallback(async () => {
    dirty.current.add('wifi.ssid')
    dirty.current.add('wifi.password')
    setValues((current) => ({ ...current, 'wifi.ssid': '', 'wifi.password': '' }))
    await savePayload(
      { 'wifi.ssid': '', 'wifi.password': '' },
      'Wi-Fi設定を消去しました。再起動後はオフラインになります。'
    )
  }, [savePayload])

  return {
    connection,
    connected: connection === 'connected',
    busy: connection === 'connecting' || connection === 'disconnecting' || operation.status === 'pending',
    values,
    readOnly,
    openaiAvailable: currentValues.current['openailive.backendModel'] !== undefined,
    bargeInAvailable: currentValues.current['openailive.bargeIn'] !== undefined,
    voiceAvailable: currentValues.current['openailive.voice'] !== undefined,
    pitchAvailable: currentValues.current['openailive.pitch'] !== undefined,
    styleAvailable: currentValues.current['openailive.style'] !== undefined,
    standbyAvailable: currentValues.current['openailive.standbySeconds'] !== undefined,
    wwwAvailable: currentValues.current['www.password'] !== undefined,
    http,
    operation,
    connect,
    disconnect,
    update,
    save,
    clearWifi,
  }
}
