import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { APP_ORIGIN } from '../../lib/site'

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/email-unsubscribe`
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const LOGO_URL = '/unicopier_light.png'

type View =
  | 'loading'
  | 'confirm'
  | 'success'
  | 'already'
  | 'error'

const REASONS = [
  { value: 'too_frequent', label: 'Too many emails' },
  { value: 'not_relevant', label: 'Not relevant to me' },
  { value: 'no_longer_use', label: 'I no longer use UniCopier' },
  { value: 'other', label: 'Other reason' },
] as const

export function EmailUnsubscribePage() {
  const [params] = useSearchParams()
  const uid = params.get('uid') ?? ''
  const token = params.get('token') ?? ''
  const statusParam = params.get('status')
  const errorParam = params.get('error')

  const [view, setView] = useState<View>(() => {
    if (statusParam === 'success') return 'success'
    if (statusParam === 'already') return 'already'
    if (errorParam) return 'error'
    return 'loading'
  })
  const [reason, setReason] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [errorTitle, setErrorTitle] = useState('Invalid link')
  const [errorMessage, setErrorMessage] = useState(
    'This unsubscribe link is missing required parameters. Please use the link directly from your email.',
  )

  const canSubmit = useMemo(() => Boolean(uid && token), [uid, token])

  useEffect(() => {
    if (statusParam === 'success' || statusParam === 'already' || errorParam) return
    if (!uid || !token) {
      setView('error')
      return
    }

    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(
          `${FN_URL}?uid=${encodeURIComponent(uid)}&token=${encodeURIComponent(token)}&format=json`,
          {
            headers: {
              Accept: 'application/json',
              apikey: ANON_KEY,
              Authorization: `Bearer ${ANON_KEY}`,
            },
          },
        )
        const data = await res.json().catch(() => ({})) as {
          ok?: boolean
          already_unsubscribed?: boolean
          error?: string
        }
        if (cancelled) return
        if (!res.ok || !data.ok) {
          setErrorTitle(data.error === 'invalid_token' ? 'Link expired' : 'Invalid link')
          setErrorMessage(
            data.error === 'invalid_token'
              ? 'This unsubscribe link is invalid or has expired. Please use the most recent email you received.'
              : 'This unsubscribe link is missing required parameters. Please use the link directly from your email.',
          )
          setView('error')
          return
        }
        setView(data.already_unsubscribed ? 'already' : 'confirm')
      } catch {
        if (cancelled) return
        setErrorTitle('Something went wrong')
        setErrorMessage('We could not verify this link right now. Please try again in a moment.')
        setView('error')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [uid, token, statusParam, errorParam])

  useEffect(() => {
    if (!errorParam) return
    if (errorParam === 'expired') {
      setErrorTitle('Link expired')
      setErrorMessage(
        'This unsubscribe link is invalid or has expired. Please use the most recent email you received.',
      )
    } else if (errorParam === 'server') {
      setErrorTitle('Something went wrong')
      setErrorMessage("We couldn't process your request right now. Please try again in a moment.")
    } else {
      setErrorTitle('Invalid link')
      setErrorMessage(
        'This unsubscribe link is missing required parameters. Please use the link directly from your email.',
      )
    }
    setView('error')
  }, [errorParam])

  const handleUnsubscribe = async () => {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    try {
      const res = await fetch(FN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          apikey: ANON_KEY,
          Authorization: `Bearer ${ANON_KEY}`,
        },
        body: JSON.stringify({ uid, token, reason: reason || null }),
      })
      const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) {
        setErrorTitle(data.error === 'invalid_token' ? 'Link expired' : 'Something went wrong')
        setErrorMessage(
          data.error === 'invalid_token'
            ? 'This unsubscribe link is invalid or has expired.'
            : "We couldn't process your request right now. Please try again in a moment.",
        )
        setView('error')
        return
      }
      setView('success')
    } catch {
      setErrorTitle('Something went wrong')
      setErrorMessage("We couldn't process your request right now. Please try again in a moment.")
      setView('error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0f1b1a] px-4 py-6 font-sans antialiased">
      <div className="mb-8">
        <img src={LOGO_URL} alt="UniCopier" className="block h-8" />
      </div>

      <div className="w-full max-w-[440px] rounded-2xl bg-white px-8 py-10 shadow-[0_4px_24px_rgba(0,0,0,0.25),0_1px_3px_rgba(0,0,0,0.1)]">
        {view === 'loading' && (
          <>
            <h1 className="mb-2 text-center text-xl font-bold text-slate-900">Checking link…</h1>
            <p className="text-center text-sm leading-relaxed text-slate-500">
              Please wait while we verify your unsubscribe request.
            </p>
          </>
        )}

        {view === 'confirm' && (
          <>
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-amber-100">
              <svg viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7">
                <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                <line x1="12" y1="2" x2="12" y2="12" />
              </svg>
            </div>
            <h1 className="mb-2 text-center text-xl font-bold text-slate-900">Unsubscribe from emails?</h1>
            <p className="mb-6 text-center text-sm leading-relaxed text-slate-500">
              You&apos;ll stop receiving subscription reminders and campaign emails from UniCopier.
              Transactional emails (password resets, security alerts) will still be delivered.
            </p>
            <div className="mb-6">
              <span className="mb-2 block text-[13px] font-semibold text-slate-700">Help us improve (optional)</span>
              <div className="space-y-1.5">
                {REASONS.map((r) => (
                  <label
                    key={r.value}
                    className="flex cursor-pointer items-center rounded-lg border border-slate-200 px-3 py-2.5 transition hover:border-teal-600 hover:bg-teal-50"
                  >
                    <input
                      type="radio"
                      name="reason"
                      value={r.value}
                      checked={reason === r.value}
                      onChange={() => setReason(r.value)}
                      className="mr-2.5"
                    />
                    <span className="text-[13px] text-slate-700">{r.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleUnsubscribe()}
              className="block w-full rounded-lg bg-slate-900 px-6 py-3 text-center text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Unsubscribing…' : 'Unsubscribe me'}
            </button>
            <a
              href={APP_ORIGIN}
              className="mt-3 block w-full bg-transparent py-3 text-center text-sm font-semibold text-slate-500 transition hover:text-slate-900"
            >
              Never mind, take me back
            </a>
          </>
        )}

        {(view === 'success' || view === 'already') && (
          <>
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
              <svg viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h1 className="mb-2 text-center text-xl font-bold text-slate-900">
              {view === 'already' ? 'Already unsubscribed' : "You've been unsubscribed"}
            </h1>
            <p className="mb-6 text-center text-sm leading-relaxed text-slate-500">
              {view === 'already'
                ? "You're already unsubscribed from UniCopier campaign emails. No further action is needed."
                : "You won't receive any more campaign emails from UniCopier. If you change your mind, you can re-subscribe from your account settings."}
            </p>
            <div className="mb-6 h-px bg-slate-200" />
            <p className="text-center text-xs leading-relaxed text-slate-400">
              Changed your mind?{' '}
              <Link to="/settings" className="underline">
                Account settings
              </Link>
            </p>
          </>
        )}

        {view === 'error' && (
          <>
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-red-100">
              <svg viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>
            <h1 className="mb-2 text-center text-xl font-bold text-slate-900">{errorTitle}</h1>
            <p className="text-center text-sm leading-relaxed text-slate-500">{errorMessage}</p>
          </>
        )}
      </div>

      <div className="mt-8 text-center text-[11px] leading-relaxed text-slate-500">
        Tartarix Inc. · 131 Continental Dr, Suite 305, Newark, DE 19713 US
      </div>
    </div>
  )
}
