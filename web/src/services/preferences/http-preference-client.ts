import { AppError } from '@/lib/errors/app-error'
import type { PreferenceClient, PreferenceValue } from './ble-preference-client'

export const isDeviceSettings = () =>
  document.querySelector('meta[name="stackchan-settings-transport"]')?.getAttribute('content') === 'http'

export class HttpPreferenceClient implements PreferenceClient {
  onDisconnected?: () => void
  private connected = false

  constructor(private readonly onValue: (value: PreferenceValue) => void) {}

  async connect() {
    const response = await fetch('/api/preferences', { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) throw new AppError('http-connect', `HTTP ${response.status}`)
    const values: PreferenceValue[] = await response.json()
    for (const value of values) this.onValue(value)
    this.connected = true
  }

  async disconnect() {
    this.connected = false
  }

  isConnected() {
    return this.connected
  }

  async send(payload: { _batch: Record<string, string> }) {
    const response = await fetch('/api/preferences', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Stackchan-Settings': '1' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new AppError('http-save', `HTTP ${response.status}`)
  }
}
