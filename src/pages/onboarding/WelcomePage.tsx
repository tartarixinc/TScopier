import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, Gift, Link2 } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Alert } from '../../components/ui/Alert'
import { Card } from '../../components/ui/Card'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { useAuth } from '../../context/AuthContext'
import { useUserProfile } from '../../context/UserProfileContext'
import { saveUserProfile } from '../../lib/userProfile'
import {
  captureReferralFromUrl,
  clearStoredReferralCode,
  loadStoredReferralCode,
  normalizeReferralCode,
  referralCodeLooksValid,
} from '../../lib/referralCapture'

async function applyReferralCode(accessToken: string, referralCode: string, source: string) {
  const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/apply-referral-code`
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      referral_code: referralCode,
      source,
    }),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string; already_applied?: boolean }
  if (!res.ok && data.error) throw new Error(data.error)
  return data
}

export function WelcomePage() {
  const navigate = useNavigate()
  const { user, session } = useAuth()
  const { profile, refreshProfile } = useUserProfile()
  const [referralCode, setReferralCode] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    const fromUrl = captureReferralFromUrl(window.location.search)
    const fromStore = loadStoredReferralCode()
    const code = fromUrl ?? fromStore
    if (code) setReferralCode(code)
  }, [])

  const normalizedCode = useMemo(
    () => normalizeReferralCode(referralCode),
    [referralCode],
  )
  const canApplyCode = referralCodeLooksValid(normalizedCode)

  const finishOnboarding = async () => {
    if (!user) return
    setError('')
    setSaving(true)
    try {
      await saveUserProfile(user.id, {
        ...profile,
        onboarding_completed_at: new Date().toISOString(),
      })
      if (session?.access_token && canApplyCode) {
        const source = window.location.search.includes('ref=') ? 'signup_url' : 'onboarding'
        await applyReferralCode(session.access_token, normalizedCode, source)
        clearStoredReferralCode()
        setSuccess('Referral code applied successfully.')
      }
      await refreshProfile()
      navigate('/dashboard', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not finish onboarding.')
    } finally {
      setSaving(false)
    }
  }

  const skipReferral = async () => {
    setReferralCode('')
    clearStoredReferralCode()
    await finishOnboarding()
  }

  return (
    <PageShell maxWidth="sm">
      <PageHeader
        title="Welcome to TSCopier"
        subtitle="One last step before your dashboard."
      />

      <div className="mt-6 space-y-4">
        {error ? <Alert variant="error">{error}</Alert> : null}
        {success ? <Alert variant="success">{success}</Alert> : null}

        <Card padding="lg" className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300">
              <Gift className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">Referral bonus</h2>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                Have a referral code? Enter it now to connect your account to your referrer.
              </p>
            </div>
          </div>

          <Input
            label="Referral code (optional)"
            value={referralCode}
            onChange={(e) => setReferralCode(normalizeReferralCode(e.target.value))}
            placeholder="e.g. TSCJOHN4"
          />

          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4" />
              <span className="font-medium">Code tips</span>
            </div>
            <p className="mt-1">Codes use letters, numbers, underscores, or dashes and are applied once.</p>
          </div>
        </Card>

        <Card padding="lg" className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            Continue to your dashboard
          </div>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            You can manage channels, connect brokers, and configure copier settings after this step.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button onClick={() => void finishOnboarding()} loading={saving}>
              Continue
            </Button>
            <Button variant="ghost" onClick={() => void skipReferral()} disabled={saving}>
              Skip code
            </Button>
          </div>
        </Card>
      </div>
    </PageShell>
  )
}

