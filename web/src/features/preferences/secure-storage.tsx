import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

type Status = {
  state: 'ready' | 'setup-required' | 'blocked' | 'unsupported' | 'unknown'
  slot?: number
  reason?: string
}
const headers = { 'Content-Type': 'application/json', 'X-Stackchan-Settings': '1' }
async function decode(response: Response): Promise<Status> {
  if (response.status === 404) return { state: 'unsupported' }
  if (!response.ok) throw new Error('Unable to read secure storage')
  const value = await response.json()
  if (
    !value ||
    !['ready', 'setup-required', 'blocked', 'unsupported', 'unknown'].includes(value.state) ||
    (value.state === 'ready' && (!Number.isInteger(value.slot) || value.slot < 0 || value.slot > 5))
  )
    throw new Error('Invalid secure storage status')
  return value
}
async function read(signal: AbortSignal) {
  return decode(
    await fetch('/api/security/storage', { credentials: 'same-origin', cache: 'no-store', headers, signal })
  )
}
const reasons: Record<string, string> = {
  'slot-occupied': 'BLOCK_KEY5 is occupied or incompatible. It will not be overwritten.',
  'protection-locked': 'Hardware protection prevents secure key setup.',
  'coding-error': 'The device reports an eFuse coding error. Setup is blocked.',
  'hmac-error': 'The hardware key check failed. Setup is blocked.',
  'setup-failed': 'Setup could not be verified. No automatic repair or retry will run.',
  'entropy-unavailable': 'A connected Wi-Fi radio is required for key generation.',
}

export function SecureStorage({
  disabled = false,
  passwordRequired = false,
  onReady,
}: {
  disabled?: boolean
  passwordRequired?: boolean
  onReady?: () => void
}) {
  const [status, setStatus] = useState<Status>()
  const [dialog, setDialog] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const request = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    request.current = controller
    setStatus(undefined)
    setError('')
    setBusy(false)
    setDialog(false)
    if (!disabled && !passwordRequired) {
      void read(controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setStatus(value)
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError('Unable to read status. Check the robot connection and WWW password.')
        })
    }
    return () => controller.abort()
  }, [disabled, passwordRequired, revision])

  async function setup() {
    const signal = request.current?.signal
    if (!signal || signal.aborted || disabled || passwordRequired || busy || status?.state !== 'setup-required') return
    setBusy(true)
    setError('')
    try {
      const value = await decode(
        await fetch('/api/security/storage', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers,
          signal,
          body: JSON.stringify({ action: 'setup', slot: 5, confirmation: 'BLOCK_KEY5_HMAC_UP_PERMANENT' }),
        })
      )
      if (signal.aborted) return
      setStatus(value)
      if (value.state === 'ready') onReady?.()
    } catch {
      if (signal.aborted) return
      setStatus({ state: 'unknown' })
      setError('Setup result was not received. Checking hardware status; setup will not be retried automatically.')
      try {
        const value = await read(signal)
        if (!signal.aborted) {
          setStatus(value)
          if (value.state === 'ready') {
            setError('')
            onReady?.()
          }
        }
      } catch {
        /* Keep the uncertain result; only a read-only status check can be repeated. */
      }
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }

  return (
    <div id="secure-storage" className="grid gap-3 sm:col-span-2" aria-label="Secure storage">
      <p className="font-medium">Secure storage</p>
      <p role="status">
        {passwordRequired
          ? 'Set and save the WWW password before setting up secure storage.'
          : disabled
            ? 'Connect to the robot to read secure storage status.'
            : busy
              ? 'Setting up… Keep the robot powered until verification finishes.'
              : status?.state === 'ready'
                ? `Ready — BLOCK_KEY${status.slot} (HMAC_UP)`
                : status?.state === 'setup-required'
                  ? 'Not set up'
                  : status?.state === 'blocked'
                    ? 'Setup blocked'
                    : status?.state === 'unsupported'
                      ? 'This firmware does not support secure storage setup.'
                      : status?.state === 'unknown'
                        ? 'Setup result unknown. Check status before taking further action.'
                        : error
                          ? 'Status unavailable'
                          : 'Checking hardware status…'}
      </p>
      {status?.reason && reasons[status.reason] && <p role="alert">{reasons[status.reason]}</p>}
      {status?.state === 'setup-required' && (
        <>
          <p className="text-sm">Setup permanently uses BLOCK_KEY5 for a generic HMAC device root key.</p>
          <div>
            <Button type="button" disabled={disabled || busy || passwordRequired} onClick={() => setDialog(true)}>
              Set up secure storage
            </Button>
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {(error || status?.state === 'unknown' || status?.state === 'blocked') && (
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || busy || passwordRequired}
            onClick={() => setRevision((value) => value + 1)}
          >
            Check status
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Only features using protected storage encrypt their data. Existing API-key preferences remain unchanged and
        unencrypted.
      </p>
      <AlertDialog open={dialog} onOpenChange={setDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Set up secure storage permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This reserves BLOCK_KEY5 for a generic HMAC_UP device root key. The protected key cannot be erased,
              replaced or assigned another purpose. Other software features can derive separate keys from it. Existing
              API-key preferences are not encrypted by this setup. Keep the robot powered until setup finishes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <AlertDialogAction type="button" disabled={busy} onClick={() => void setup()}>
              Set up permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
