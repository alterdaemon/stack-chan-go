import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SecureStorage } from './secure-storage'

const response = (value: object, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
})
afterEach(() => vi.unstubAllGlobals())
describe('independent secure storage setup', () => {
  it('requires permanent confirmation and never submits the surrounding form', async () => {
    const submit = vi.fn((event) => event.preventDefault())
    const ready = vi.fn()
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
      response(init?.method === 'POST' ? { state: 'ready', slot: 5 } : { state: 'setup-required', slot: 5 })
    )
    vi.stubGlobal('fetch', fetch)
    render(
      <form onSubmit={submit}>
        <SecureStorage onReady={ready} />
      </form>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Set up secure storage' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('BLOCK_KEY5')
    expect(screen.getByRole('alertdialog')).toHaveTextContent('cannot be erased')
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }))
    expect(fetch).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Set up secure storage' }))
    fireEvent.click(screen.getByRole('button', { name: 'Set up permanently' }))
    expect(await screen.findByText('Ready — BLOCK_KEY5 (HMAC_UP)')).toBeVisible()
    expect(submit).not.toHaveBeenCalled()
    expect(ready).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetch.mock.calls[1][1]?.body as string)).toEqual({
      action: 'setup',
      slot: 5,
      confirmation: 'BLOCK_KEY5_HMAC_UP_PERMANENT',
    })
    expect(screen.queryByRole('button', { name: 'Set up secure storage' })).toBeNull()
  })

  it('uses the actual existing slot without a setup request', async () => {
    const fetch = vi.fn(async () => response({ state: 'ready', slot: 2 }))
    vi.stubGlobal('fetch', fetch)
    render(<SecureStorage />)
    expect(await screen.findByText('Ready — BLOCK_KEY2 (HMAC_UP)')).toBeVisible()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Set up secure storage' })).toBeNull()
  })

  it.each(['slot-occupied', 'protection-locked', 'coding-error', 'hmac-error', 'setup-failed'])(
    'blocks %s without a write',
    async (reason) => {
      const fetch = vi.fn(async () => response({ state: 'blocked', slot: 5, reason }))
      vi.stubGlobal('fetch', fetch)
      render(<SecureStorage />)
      expect(await screen.findByText('Setup blocked')).toBeVisible()
      expect(screen.getByRole('alert')).toBeVisible()
      expect(screen.queryByRole('button', { name: 'Set up secure storage' })).toBeNull()
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  )

  it('recovers a lost response with GET only and never retries programming', async () => {
    let reads = 0
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('connection lost')
      return response(++reads === 1 ? { state: 'setup-required', slot: 5 } : { state: 'ready', slot: 5 })
    })
    const ready = vi.fn()
    vi.stubGlobal('fetch', fetch)
    render(<SecureStorage onReady={ready} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Set up secure storage' }))
    fireEvent.click(screen.getByRole('button', { name: 'Set up permanently' }))
    expect(await screen.findByText('Ready — BLOCK_KEY5 (HMAC_UP)')).toBeVisible()
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('retains unknown status after lost POST and GET rather than claiming success', async () => {
    let first = true
    const fetch = vi.fn(async () => {
      if (first) {
        first = false
        return response({ state: 'setup-required', slot: 5 })
      }
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', fetch)
    render(<SecureStorage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Set up secure storage' }))
    fireEvent.click(screen.getByRole('button', { name: 'Set up permanently' }))
    expect(await screen.findByText('Setup result unknown. Check status before taking further action.')).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check status' })).toBeEnabled())
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(screen.queryByRole('button', { name: 'Set up secure storage' })).toBeNull()
  })

  it('requires the saved WWW password and does not read or write in bootstrap', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    render(<SecureStorage passwordRequired />)
    expect(screen.getByRole('status')).toHaveTextContent('Set and save the WWW password')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows unsupported capability and aborts requests on unmount', async () => {
    const fetch = vi.fn(async () => response({ state: 'unsupported' }, 404))
    vi.stubGlobal('fetch', fetch)
    const view = render(<SecureStorage />)
    expect(await screen.findByText('This firmware does not support secure storage setup.')).toBeVisible()
    const init = fetch.mock.calls[0] as unknown as [string, RequestInit]
    view.unmount()
    expect((init[1].signal as AbortSignal).aborted).toBe(true)
  })
})
