import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/app/i18n-provider'
import { DEFAULT_PREFERENCES, OPENAI_REASONING_EFFORTS } from '@/features/preferences/preference-model'
import { PreferencesPage } from '@/features/preferences/preferences-page'
import { usePreferences } from '@/features/preferences/use-preferences'

vi.mock('@/features/preferences/use-preferences', () => ({
  usePreferences: vi.fn(),
}))

describe('PreferencesPage', () => {
  function renderPreferences(overrides: Partial<ReturnType<typeof usePreferences>> = {}) {
    const state: ReturnType<typeof usePreferences> = {
      connection: 'connected',
      connected: true,
      busy: false,
      openaiAvailable: true,
      modeAvailable: true,
      realtimeVoiceAvailable: true,
      bargeInAvailable: true,
      voiceAvailable: true,
      pitchAvailable: true,
      styleAvailable: true,
      standbyAvailable: true,
      wwwAvailable: true,
      http: false,
      values: DEFAULT_PREFERENCES,
      readOnly: new Set(),
      operation: { status: 'idle' },
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      update: vi.fn(),
      save: vi.fn(async () => {}),
      clearWifi: vi.fn(async () => {}),
      ...overrides,
    }
    vi.mocked(usePreferences).mockReturnValue(state)

    const rendered = render(
      <I18nProvider>
        <PreferencesPage />
      </I18nProvider>
    )
    return { ...rendered, state }
  }

  it('shows the MCP server token as a password field', () => {
    renderPreferences()
    const token = screen.getByLabelText('Bearerトークン')
    expect(token).toHaveAttribute('name', 'mcp.token')
    expect(token).toHaveAttribute('type', 'password')
  })

  it('offers versioned Live and Mini labels and only Realtime voices in Mini mode', async () => {
    const user = userEvent.setup()
    const { state, unmount } = renderPreferences()
    await user.click(screen.getByRole('combobox', { name: '会話モード' }))
    expect(screen.getByRole('option', { name: 'GPT-Live 1' })).toBeVisible()
    await user.click(screen.getByRole('option', { name: 'GPT-Realtime 2.1 Mini' }))
    expect(state.update).toHaveBeenLastCalledWith('openailive.mode', 'realtime')
    unmount()
    renderPreferences({ values: { ...DEFAULT_PREFERENCES, 'openailive.mode': 'realtime' } })
    expect(screen.queryByRole('spinbutton', { name: '自動切断までの秒数' })).toBeNull()
    expect(screen.getByRole('combobox', { name: '音声で割り込み（実験的）' })).toBeEnabled()
    await user.click(screen.getByRole('combobox', { name: '声' }))
    expect(await screen.findByRole('option', { name: 'cedar' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'bossa' })).toBeNull()
    await user.click(screen.getByRole('option', { name: 'cedar' }))
  })

  it('edits standby seconds under OpenAI and disables it on older firmware', () => {
    const { state, unmount } = renderPreferences()
    const field = screen.getByRole('spinbutton', { name: '自動切断までの秒数' })
    expect(field).toHaveValue(60)
    fireEvent.change(field, { target: { value: '45' } })
    expect(state.update).toHaveBeenLastCalledWith('openailive.standbySeconds', '45')
    unmount()
    const invalid = renderPreferences({ values: { ...DEFAULT_PREFERENCES, 'openailive.standbySeconds': '0' } })
    expect((screen.getByRole('spinbutton', { name: '自動切断までの秒数' }) as HTMLInputElement).checkValidity()).toBe(
      false
    )
    invalid.unmount()
    renderPreferences({ standbyAvailable: false })
    expect(screen.getByRole('spinbutton', { name: '自動切断までの秒数' })).toBeDisabled()
  })

  it.each([false, true])('shares every form field with WWW last over HTTP=%s', (http) => {
    const { container } = renderPreferences({ http })
    const titles = [...container.querySelectorAll('form [data-slot="card-title"]')].map((node) => node.textContent)
    expect(titles).toEqual(['Wi-Fi', '外観', 'サーボ', '音声合成', 'AI', 'OpenAI', 'MCP Server', 'WWW'])
    const password = screen.getByLabelText('Wi-Fiアクセスパスワード')
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveAttribute('name', 'www.password')
    expect(password).toBeEnabled()
    expect(screen.getByLabelText('SSID')).toBeEnabled()
  })

  it('permits only WWW password entry during initial HTTP setup', () => {
    renderPreferences({
      http: true,
      readOnly: new Set(
        Object.keys(DEFAULT_PREFERENCES).filter((key) => key !== 'www.password') as (keyof typeof DEFAULT_PREFERENCES)[]
      ),
    })
    expect(screen.getByLabelText('SSID')).toBeDisabled()
    expect(screen.getByLabelText('Wi-Fiアクセスパスワード')).toBeEnabled()
  })

  it('places OpenAI between AI and MCP Server and edits device-provided values', async () => {
    const user = userEvent.setup()
    const { container, state } = renderPreferences({
      values: {
        ...DEFAULT_PREFERENCES,
        'openailive.backendModel': 'device-backend',
        'openailive.reasoningEffort': 'high',
      },
    })
    const titles = [...container.querySelectorAll('form [data-slot="card-title"]')].map((node) => node.textContent)
    expect(titles.slice(titles.indexOf('AI'), titles.indexOf('AI') + 3)).toEqual(['AI', 'OpenAI', 'MCP Server'])
    const model = screen.getByLabelText('モデル')
    expect(model).toHaveValue('device-backend')
    expect(model).toHaveAttribute('name', 'openailive.backendModel')
    fireEvent.change(model, { target: { value: 'new-backend' } })
    expect(state.update).toHaveBeenLastCalledWith('openailive.backendModel', 'new-backend')
    const effort = screen.getByRole('combobox', { name: '推論の強度' })
    expect(effort).toHaveTextContent('high')
    await user.click(effort)
    expect(screen.getAllByRole('option').map((node) => node.textContent)).toEqual([...OPENAI_REASONING_EFFORTS])
    await user.click(screen.getByRole('option', { name: 'none' }))
    expect(state.update).toHaveBeenLastCalledWith('openailive.reasoningEffort', 'none')
  })

  it('offers voice interruption off by default and disables it on older firmware', async () => {
    const user = userEvent.setup()
    const { state, unmount } = renderPreferences()
    const field = screen.getByRole('combobox', {
      name: '音声で割り込み（実験的）',
    })
    expect(field).toHaveTextContent('無効')
    await user.click(field)
    await user.click(screen.getByRole('option', { name: '有効' }))
    expect(state.update).toHaveBeenLastCalledWith('openailive.bargeIn', '1')
    unmount()
    renderPreferences({ bargeInAvailable: false })
    expect(screen.getByRole('combobox', { name: '音声で割り込み（実験的）' })).toBeDisabled()
    expect(screen.getByLabelText('モデル')).toBeEnabled()
  })

  it('edits Voice, Pitch and Style and disables them on older firmware', async () => {
    const user = userEvent.setup()
    const { state, unmount } = renderPreferences()
    const voice = screen.getByRole('combobox', { name: '声' })
    expect(voice).toHaveTextContent('marin')
    await user.click(voice)
    await user.click(await screen.findByRole('option', { name: 'cedar' }))
    expect(state.update).toHaveBeenLastCalledWith('openailive.voice', 'cedar')
    const pitch = screen.getByRole('slider', { name: 'ピッチ' })
    expect(pitch).toHaveValue('0')
    fireEvent.change(pitch, { target: { value: '-4' } })
    expect(state.update).toHaveBeenLastCalledWith('openailive.pitch', '-4')
    await user.click(screen.getByRole('combobox', { name: '話し方' }))
    await user.click(await screen.findByRole('option', { name: '穏やか' }))
    expect(state.update).toHaveBeenLastCalledWith('openailive.style', 'calm')
    unmount()
    renderPreferences({ voiceAvailable: false, pitchAvailable: false, styleAvailable: false })
    expect(screen.getByRole('combobox', { name: '声' })).toBeDisabled()
    expect(screen.getByRole('slider', { name: 'ピッチ' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '話し方' })).toBeDisabled()
  })

  it('requires a nonblank model and keeps the fields disabled while disconnected', () => {
    const { unmount } = renderPreferences({
      values: { ...DEFAULT_PREFERENCES, 'openailive.backendModel': '   ' },
    })
    expect((screen.getByLabelText('モデル') as HTMLInputElement).checkValidity()).toBe(false)
    unmount()
    renderPreferences({ connected: false })
    expect(screen.getByLabelText('モデル')).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '推論の強度' })).toBeDisabled()
  })

  it('does not block other settings when firmware does not advertise OpenAI preferences', () => {
    renderPreferences({ openaiAvailable: false })
    expect(screen.getByLabelText('モデル')).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '推論の強度' })).toBeDisabled()
    expect(screen.getByLabelText('SSID')).toBeEnabled()
    expect((screen.getByRole('form') as HTMLFormElement).checkValidity()).toBe(true)
  })
})
