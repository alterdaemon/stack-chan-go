import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

type Status = {
  state: string
  signedIn: boolean
  account?: string
  volatile?: boolean
  url?: string
  code?: string
  expiresAt?: number
}

export function SubscriptionAuth({ disabled = false }: { disabled?: boolean }) {
  const [status, setStatus] = useState<Status>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (disabled) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const response = await fetch('/api/subscription', {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'X-Stackchan-Settings': '1' },
          signal: controller.signal,
        })
        if (!response.ok) throw new Error()
        const next: Status = await response.json()
        if (controller.signal.aborted) return
        setStatus(next)
        setError('')
        if (['pending', 'authorizing'].includes(next.state)) timer = setTimeout(read, 1500)
      } catch {
        if (!controller.signal.aborted)
          setError('Unable to read sign-in status. Check the robot connection and WWW password.')
      }
    }
    void read()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [disabled, revision])

  async function action(action: 'start' | 'cancel' | 'logout') {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/subscription', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-Stackchan-Settings': '1',
        },
        body: JSON.stringify({ action }),
      })
      if (!response.ok) throw new Error()
      setStatus(await response.json())
      setRevision((value) => value + 1)
    } catch {
      setError('Sign-in request failed. Check the robot connection and WWW password.')
    } finally {
      setBusy(false)
    }
  }
  const pending = status && ['pending', 'authorizing'].includes(status.state)
  return (
    <div className="grid gap-3 sm:col-span-2" aria-label="ChatGPT subscription authentication">
      <p role="status">
        {status?.signedIn
          ? `Signed in: ${status.account ?? 'ChatGPT account'}`
          : pending
            ? 'Waiting for OpenAI sign-in…'
            : status?.state === 'expired'
              ? 'Sign-in expired. Try again.'
              : status?.state === 'error'
                ? 'Sign-in failed. Try again.'
                : 'Sign in to ChatGPT on this robot.'}
      </p>
      {status?.state === 'storage-unavailable' && (
        <p role="alert">Secure sign-in storage needs setup on this robot before you can sign in.</p>
      )}
      {status?.state === 'storage-error' && (
        <p role="alert">Secure sign-in storage failed. Retry sign-out before signing in again.</p>
      )}
      {pending && status.url === 'https://auth.openai.com/codex/device' && status.code && (
        <p>
          Open{' '}
          <a className="underline" href={status.url} target="_blank" rel="noopener noreferrer">
            OpenAI sign-in
          </a>{' '}
          and enter <strong>{status.code}</strong>. Return here after approval.
        </p>
      )}
      <div>
        <Button
          type="button"
          disabled={disabled || busy || status?.state === 'storage-unavailable'}
          onClick={() =>
            void action(status?.signedIn || status?.state === 'storage-error' ? 'logout' : pending ? 'cancel' : 'start')
          }
        >
          {status?.state === 'storage-error'
            ? 'Retry sign-out'
            : status?.signedIn
              ? 'Sign out'
              : pending
                ? 'Cancel sign-in'
                : 'Continue with ChatGPT'}
        </Button>
      </div>
      {status?.volatile && <p className="text-xs text-muted-foreground">Sign-in lasts until the robot restarts.</p>}
      {status?.signedIn && status.volatile === false && (
        <p className="text-xs text-muted-foreground">Sign-in is saved securely on this robot and survives restarts.</p>
      )}
      <p className="text-xs text-muted-foreground">
        Authentication runs on the robot. Enter your account password only on OpenAI’s website. Save settings to use
        this connection on the next manual start.
      </p>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
