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
      subscriptionAvailable: false,
      codexVoiceAvailable: true,
      codexModelAvailable: true,
      codexEffortAvailable: true,
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

  it('places Security after WWW and before Save in Wi-Fi API-key mode without linking it to Save', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ state: 'ready', slot: 5 }) }))
    vi.stubGlobal('fetch', fetch)
    const { state } = renderPreferences({ http: true })
    expect(await screen.findByText('Ready — BLOCK_KEY5 (HMAC_UP)')).toBeVisible()
    const password = screen.getByLabelText('Wi-Fiアクセスパスワード')
    const security = screen.getByLabelText('Secure storage')
    const save = screen.getByRole('button', { name: '設定を保存' })
    expect(password.compareDocumentPosition(security) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(security.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.submit(save.closest('form')!)
    expect(state.save).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('does not expose hardware setup over BLE', () => {
    renderPreferences({ http: false })
    expect(screen.queryByLabelText('Secure storage')).toBeNull()
  })

  it('keeps shared prompt and OpenAI controls in subscription mode and hides API overrides', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ state: 'signed-out', signedIn: false, volatile: true }) }))
    )
    renderPreferences({
      subscriptionAvailable: true,
      http: true,
      values: {
        ...DEFAULT_PREFERENCES,
        'openailive.auth': 'chatgpt',
        'openailive.mode': 'realtime-full',
        'ai.context': 'Speak Polish.',
      },
    })
    expect(screen.getByRole('combobox', { name: 'AI connection' })).toBeVisible()
    expect(await screen.findByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible()
    expect(screen.getByLabelText('システムロール')).toHaveValue('Speak Polish.')
    expect(screen.getByRole('combobox', { name: '声' })).toHaveTextContent('cove')
    expect(screen.getByRole('slider', { name: 'ピッチ' })).toBeVisible()
    expect(screen.getByRole('spinbutton', { name: '自動切断までの秒数' })).toBeVisible()
    expect(screen.queryByLabelText('OpenAI API key')).toBeNull()
    expect(screen.queryByRole('combobox', { name: '会話モード' })).toBeNull()
    expect(screen.getByRole('combobox', { name: '推論の強度' })).toHaveTextContent('medium')
    expect(screen.getByLabelText('モデル')).toHaveValue('gpt-6.1-terra')
    expect(screen.getAllByText('OpenAI', { exact: true }).length).toBe(1)
    vi.unstubAllGlobals()
  })

  it('offers qualified Codex voices and edits only the subscription voice', async () => {
    const user = userEvent.setup()
    const { state } = renderPreferences({
      subscriptionAvailable: true,
      http: false,
      values: {
        ...DEFAULT_PREFERENCES,
        'openailive.auth': 'chatgpt',
        'openailive.voice': 'marin',
        'openailive.realtimeVoice': 'cedar',
      },
    })
    await user.click(screen.getByRole('combobox', { name: '声' }))
    expect(await screen.findByRole('option', { name: 'cove' })).toBeVisible()
    expect(await screen.findByRole('option', { name: 'viola' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'marin' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'cedar' })).toBeNull()
    await user.click(await screen.findByRole('option', { name: 'juniper' }))
    expect(state.update).toHaveBeenLastCalledWith('openailive.codexVoice', 'juniper')
    expect(state.values['openailive.voice']).toBe('marin')
    expect(state.values['openailive.realtimeVoice']).toBe('cedar')
  })

  it('edits subscription reasoning settings without writing API model or effort', async () => {
    const user = userEvent.setup()
    const { state } = renderPreferences({
      subscriptionAvailable: true,
      values: {
        ...DEFAULT_PREFERENCES,
        'openailive.auth': 'chatgpt',
        'openailive.backendModel': 'saved-api-model',
        'openailive.reasoningEffort': 'high',
      },
    })
    const model = screen.getByLabelText('モデル')
    expect(model).toHaveAttribute('id', 'openailive.codexModel')
    fireEvent.change(model, { target: { value: 'gpt-6-luna' } })
    expect(state.update).toHaveBeenLastCalledWith('openailive.codexModel', 'gpt-6-luna')
    await user.click(screen.getByRole('combobox', { name: '推論の強度' }))
    await user.click(await screen.findByRole('option', { name: 'low' }))
    expect(state.update).toHaveBeenLastCalledWith('openailive.codexEffort', 'low')
    expect(state.values['openailive.backendModel']).toBe('saved-api-model')
    expect(state.values['openailive.reasoningEffort']).toBe('high')
  })

  it('directs a subscribed BLE device to Wi-Fi without showing an API key or browser sign-in', () => {
    renderPreferences({
      subscriptionAvailable: true,
      http: false,
      values: { ...DEFAULT_PREFERENCES, 'openailive.auth': 'chatgpt' },
    })
    expect(screen.getByText('Open the robot’s Wi-Fi Settings page to sign in to ChatGPT or sign out.')).toBeVisible()
    expect(screen.queryByLabelText('OpenAI API key')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue with ChatGPT' })).toBeNull()
  })

  it('shows the MCP server token as a password field', () => {
    renderPreferences()
    const token = screen.getByLabelText('Bearerトークン')
    expect(token).toHaveAttribute('name', 'mcp.token')
    expect(token).toHaveAttribute('type', 'password')
  })

  it.each([
    ['realtime', 'GPT-Realtime 2.1 Mini'],
    ['realtime-full', 'GPT-Realtime 2.1'],
  ])('offers all three versioned choices and selects %s', async (mode, label) => {
    const user = userEvent.setup()
    const { state } = renderPreferences()
    await user.click(screen.getByRole('combobox', { name: '会話モード' }))
    expect(await screen.findByRole('option', { name: 'GPT-Live 1' })).toBeVisible()
    expect(await screen.findByRole('option', { name: 'GPT-Realtime 2.1' })).toBeVisible()
    expect(await screen.findByRole('option', { name: 'GPT-Realtime 2.1 Mini' })).toBeVisible()
    await user.click(await screen.findByRole('option', { name: label }))
    expect(state.update).toHaveBeenLastCalledWith('openailive.mode', mode)
  })

  it.each(['realtime', 'realtime-full'])('uses Realtime voices and hides Live standby for %s', async (mode) => {
    const user = userEvent.setup()
    const { state } = renderPreferences({ values: { ...DEFAULT_PREFERENCES, 'openailive.mode': mode } })
    expect(screen.queryByRole('spinbutton', { name: '自動切断までの秒数' })).toBeNull()
    expect(screen.getByRole('combobox', { name: '音声で割り込み（実験的）' })).toBeEnabled()
    await user.click(screen.getByRole('combobox', { name: '声' }))
    expect(await screen.findByRole('option', { name: 'cedar' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'bossa' })).toBeNull()
    await user.click(await screen.findByRole('option', { name: 'cedar' }))
    expect(state.update).toHaveBeenLastCalledWith('openailive.realtimeVoice', 'cedar')
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

  it.each([false, true])('keeps shared field order and appends Security only over HTTP=%s', (http) => {
    const { container } = renderPreferences({ http })
    const titles = [...container.querySelectorAll('form [data-slot="card-title"]')].map((node) => node.textContent)
    expect(titles).toEqual([
      'Wi-Fi',
      '外観',
      'サーボ',
      '音声合成',
      'AI',
      'OpenAI',
      'MCP Server',
      'WWW',
      ...(http ? ['Security'] : []),
    ])
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
    await user.click(await screen.findByRole('option', { name: 'none' }))
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
    await user.click(await screen.findByRole('option', { name: '有効' }))
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
