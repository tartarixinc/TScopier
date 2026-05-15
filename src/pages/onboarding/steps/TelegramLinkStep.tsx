import { useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { Card } from '../../../components/ui/Card'
import { Input } from '../../../components/ui/Input'
import { Button } from '../../../components/ui/Button'
import { Alert } from '../../../components/ui/Alert'
import { ShieldCheck, TriangleAlert as AlertTriangle } from 'lucide-react'

type Stage = 'phone' | 'code' | 'confirm_2fa' | 'done'

interface Props {
  onDone: (sessionId: string) => void
}

const EDGE_FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/telegram-auth`

export function TelegramLinkStep({ onDone }: Props) {
  const { session } = useAuth()
  const [stage, setStage] = useState<Stage>('phone')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [sessionRowId, setSessionRowId] = useState<string | null>(null)
  const [twoFaConfirmed, setTwoFaConfirmed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [requiresPassword, setRequiresPassword] = useState(false)

  const authHeaders = {
    'Authorization': `Bearer ${session?.access_token}`,
    'Content-Type': 'application/json',
  }

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ action: 'send_code', phone }),
      })
      const data = await res.json()

      if (!res.ok || data.error) {
        setError(data.error || 'Failed to send code')
        return
      }

      setStage('code')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const verifyCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          action: 'verify_code',
          phone,
          code,
          password: requiresPassword ? password : undefined,
        }),
      })
      const data = await res.json()

      if (!res.ok || data.error) {
        if (data.requires_password) {
          setRequiresPassword(true)
          setError('Two-step verification is enabled. Enter your Telegram password below.')
          setLoading(false)
          return
        }
        setError(data.error || 'Verification failed')
        return
      }

      // Worker persisted the session row; we just hold the id for handoff.
      setSessionRowId(data.session_id ?? null)
      setStage('confirm_2fa')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const finishLink = () => {
    if (!twoFaConfirmed) return
    setStage('done')
    if (sessionRowId) onDone(sessionRowId)
  }

  if (stage === 'done') {
    return (
      <Card>
        <div className="text-center py-4">
          <div className="w-12 h-12 bg-success-50 rounded-full flex items-center justify-center mx-auto mb-3">
            <svg className="w-6 h-6 text-success-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">Telegram connected</h2>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">Your session is saved and active.</p>
        </div>
      </Card>
    )
  }

  if (stage === 'confirm_2fa') {
    return (
      <Card>
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="w-5 h-5 text-teal-600" />
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">Secure your Telegram account</h2>
          </div>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Accounts without a Two-Step Verification password are auto-flagged by Telegram much faster.
            Set one in the Telegram app before you continue, then confirm below.
          </p>
        </div>

        <ol className="space-y-2.5 text-sm text-neutral-700 dark:text-neutral-300 mb-5 list-decimal list-inside">
          <li>Open the Telegram app on your phone.</li>
          <li>Go to <span className="font-medium">Settings → Privacy and Security → Two-Step Verification</span>.</li>
          <li>Set a password and a recovery email.</li>
        </ol>

        <label className="flex items-start gap-2.5 p-3 border border-neutral-200 dark:border-neutral-800 rounded-lg cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors">
          <input
            type="checkbox"
            checked={twoFaConfirmed}
            onChange={e => setTwoFaConfirmed(e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded border-neutral-300 text-teal-600 focus:ring-teal-500"
          />
          <span className="text-sm text-neutral-700 dark:text-neutral-300">
            I have set a Two-Step Verification password on this Telegram account.
          </span>
        </label>

        <Button
          type="button"
          onClick={finishLink}
          disabled={!twoFaConfirmed}
          className="w-full mt-5"
          size="lg"
        >
          Continue
        </Button>
      </Card>
    )
  }

  return (
    <Card>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">Link your Telegram</h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
          {stage === 'phone'
            ? 'Enter your phone number to receive a verification code.'
            : 'Enter the code Telegram sent you.'}
        </p>
      </div>

      <div className="mb-4 px-3 py-2.5 bg-warning-50 border border-warning-200 rounded-lg flex items-start gap-2.5">
        <AlertTriangle className="w-4 h-4 text-warning-600 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-warning-700 leading-relaxed">
          Use a phone number that has been active in the official Telegram app for at least 7 days.
          Brand-new numbers connected via API are very likely to be banned by Telegram.
        </p>
      </div>

      {error && <Alert className="mb-4 py-2.5">{error}</Alert>}

      {stage === 'phone' ? (
        <form onSubmit={sendCode} className="space-y-4">
          <Input
            label="Phone number"
            type="tel"
            placeholder="+1 234 567 8900"
            value={phone}
            onChange={e => setPhone(e.target.value)}
            hint="Include country code (e.g. +44 for UK)"
            required
            autoFocus
          />
          <Button type="submit" loading={loading} className="w-full" size="lg">
            Send verification code
          </Button>
        </form>
      ) : (
        <form onSubmit={verifyCode} className="space-y-4">
          <Input
            label="Verification code"
            type="text"
            placeholder="12345"
            value={code}
            onChange={e => setCode(e.target.value)}
            hint={`Code sent to ${phone}`}
            required
            autoFocus
          />
          {requiresPassword && (
            <Input
              label="Two-step verification password"
              type="password"
              placeholder="Your Telegram password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          )}
          <Button type="submit" loading={loading} className="w-full" size="lg">
            Verify and connect
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => { setStage('phone'); setError('') }}
          >
            Use a different number
          </Button>
        </form>
      )}
    </Card>
  )
}
