import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubscriptionAuth } from './subscription-auth'

afterEach(() => vi.unstubAllGlobals())
describe('robot-owned ChatGPT authentication', () => {
  it('links to separate setup and refreshes readiness without authorizing automatically', async () => {
    let ready = false
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        state: ready ? 'signed-out' : 'storage-unavailable',
        signedIn: false,
        volatile: false,
      }),
    }))
    vi.stubGlobal('fetch', fetch)
    const view = render(<SubscriptionAuth storageRevision={0} />)
    expect(await screen.findByRole('link', { name: 'Security → Secure storage' })).toHaveAttribute(
      'href',
      '#secure-storage'
    )
    expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeDisabled()
    ready = true
    view.rerender(<SubscriptionAuth storageRevision={1} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeEnabled())
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true)
  })
  it.each([
    ['signed-out', 'Continue with ChatGPT', 'start'],
    ['expired', 'Continue with ChatGPT', 'start'],
    ['error', 'Continue with ChatGPT', 'start'],
    ['pending', 'Cancel sign-in', 'cancel'],
    ['signed-in', 'Sign out', 'logout'],
  ])('renders %s and sends only the selected action', async (state, button, action) => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        state,
        signedIn: state === 'signed-in',
        account: 'Test account',
        volatile: true,
      }),
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
  it('shows saved authentication without claiming volatile sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          state: 'signed-in',
          signedIn: true,
          volatile: false,
        }),
      }))
    )
    render(<SubscriptionAuth />)
    expect(await screen.findByText('Sign-in is saved securely on this robot and survives restarts.')).toBeVisible()
    expect(screen.queryByText('Sign-in lasts until the robot restarts.')).toBeNull()
  })
  it('disables sign-in when protected storage is not provisioned', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        state: 'storage-unavailable',
        signedIn: false,
        volatile: false,
      }),
    }))
    vi.stubGlobal('fetch', fetch)
    render(<SubscriptionAuth />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Secure sign-in storage needs setup')
    expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeDisabled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('retries local deletion after a storage error instead of starting authorization', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        state: 'storage-error',
        signedIn: false,
        volatile: false,
      }),
    }))
    vi.stubGlobal('fetch', fetch)
    render(<SubscriptionAuth />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry sign-out' }))
    await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(1))
    const [, request] = fetch.mock.calls[1] as unknown as [string, RequestInit]
    expect(JSON.parse(request.body as string)).toEqual({ action: 'logout' })
  })
})
