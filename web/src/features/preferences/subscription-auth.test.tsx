import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubscriptionAuth } from './subscription-auth'

afterEach(() => vi.unstubAllGlobals())
describe('robot-owned ChatGPT authentication', () => {
  it.each([
    ['signed-out', 'Continue with ChatGPT', 'start'],
    ['expired', 'Continue with ChatGPT', 'start'],
    ['error', 'Continue with ChatGPT', 'start'],
    ['pending', 'Cancel sign-in', 'cancel'],
    ['signed-in', 'Sign out', 'logout'],
  ])('renders %s and sends only the selected action', async (state, button, action) => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ state, signedIn: state === 'signed-in', account: 'Test account', volatile: true }),
    }))
    vi.stubGlobal('fetch', fetch)
    render(<SubscriptionAuth />)
    const control = await screen.findByRole('button', { name: button })
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    fireEvent.click(control)
    await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(1))
    const request = fetch.mock.calls[1] as unknown as [string, RequestInit]
    expect(request[0]).toBe('/api/subscription')
    expect(JSON.parse(request[1].body as string)).toEqual({ action })
    expect(request[1].credentials).toBe('same-origin')
  })
  it('accepts only the fixed OpenAI sign-in URL and explains volatile credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          state: 'pending',
          signedIn: false,
          volatile: true,
          code: 'TEST-CODE',
          url: 'https://attacker.test',
        }),
      }))
    )
    render(<SubscriptionAuth />)
    await screen.findByRole('button', { name: 'Cancel sign-in' })
    expect(screen.queryByRole('link', { name: 'OpenAI sign-in' })).toBeNull()
    expect(screen.getByText('Sign-in lasts until the robot restarts.')).toBeVisible()
  })
})
