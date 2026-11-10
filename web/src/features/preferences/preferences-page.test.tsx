import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/app/i18n-provider'
import { PreferencesPage } from '@/features/preferences/preferences-page'
import { DEFAULT_PREFERENCES, OPENAI_REASONING_EFFORTS } from '@/features/preferences/preference-model'
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
