import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Star, X } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import {
  fetchSocialTraderReviews,
  saveSocialTraderReview,
  SOCIAL_REVIEW_MAX_LENGTH,
  type SocialTraderReview,
  validateSocialReview,
} from '../../lib/socialReviews'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'

const RATING_TONES: Record<number, string> = {
  1: 'text-red-600 dark:text-red-400',
  2: 'text-orange-600 dark:text-orange-400',
  3: 'text-amber-500 dark:text-amber-300',
  4: 'text-blue-600 dark:text-blue-400',
  5: 'text-green-500 dark:text-green-400',
}

const REVIEW_LOAD_ERROR = 'Unable to load reviews. Please try again.'

function Stars({ rating, label }: { rating: number; label: string }) {
  const rounded = Math.round(rating)
  return (
    <span className={clsx('inline-flex items-center gap-0.5', RATING_TONES[rounded] ?? 'text-neutral-400')} aria-label={label}>
      {[1, 2, 3, 4, 5].map(star => <Star key={star} aria-hidden="true" className={clsx('h-4 w-4', star <= rounded && 'fill-current')} />)}
    </span>
  )
}

function ReviewModal({ traderName, traderUserId, existing, onClose, onSaved }: {
  traderName: string
  traderUserId: string
  existing: SocialTraderReview | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [rating, setRating] = useState(existing?.rating ?? 0)
  const [text, setText] = useState(existing?.reviewText ?? '')
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const validation = validateSocialReview(rating, text)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose()
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled])')
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = ''
      document.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [onClose, submitting])

  const selectByKeyboard = (event: React.KeyboardEvent, star: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1
    setRating(Math.min(5, Math.max(1, star + delta)))
  }

  const submit = async () => {
    if (submittingRef.current || validation) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      await saveSocialTraderReview(supabase, { traderUserId, rating, reviewText: text })
      await onSaved()
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save your review.')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-70 flex items-end justify-center p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="trader-review-title">
      <button type="button" className="absolute inset-0 bg-neutral-950/60" aria-label="Close review dialog" disabled={submitting} onClick={onClose} />
      <div ref={dialogRef} className="relative max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900 sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <div><h2 id="trader-review-title" className="text-lg font-semibold">{existing ? 'Edit your review' : 'Rate trader'}</h2><p className="mt-1 text-sm text-neutral-500">{traderName}</p></div>
          <button ref={closeRef} type="button" className="rounded-lg p-2 hover:bg-neutral-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-400 dark:hover:bg-neutral-800" aria-label="Close" disabled={submitting} onClick={onClose}><X className="h-5 w-5" /></button>
        </div>
        <div className="space-y-4 p-5">
          {saved ? <Alert variant="success">Your review was saved.</Alert> : null}
          {error ? <Alert variant="error">{error}</Alert> : null}
          <fieldset disabled={submitting || saved}>
            <legend className="text-sm font-medium">Rating</legend>
            <div className="mt-2 flex gap-2" role="radiogroup" aria-label="Trader rating">
              {[1, 2, 3, 4, 5].map(star => (
                <button key={star} type="button" role="radio" aria-checked={rating === star} aria-label={`${star} star${star === 1 ? '' : 's'}`}
                  onClick={() => setRating(star)} onKeyDown={event => selectByKeyboard(event, star)}
                  className={clsx('rounded-lg p-2 transition-transform hover:scale-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-400', rating > 0 ? RATING_TONES[rating] : RATING_TONES[star], rating === star && 'bg-neutral-100 ring-2 ring-current dark:bg-neutral-800')}>
                  <Star className={clsx('h-7 w-7', rating >= star && 'fill-current')} />
                </button>
              ))}
            </div>
          </fieldset>
          <label className="block text-sm font-medium">Written review
            <textarea rows={5} maxLength={SOCIAL_REVIEW_MAX_LENGTH} disabled={submitting || saved} value={text} onChange={event => setText(event.target.value)}
              className="mt-2 w-full resize-y rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-green-400 dark:border-neutral-700 dark:bg-neutral-950" placeholder="Describe your experience with this trader." />
            <span className="mt-1 block text-end text-xs text-neutral-500">{text.length}/{SOCIAL_REVIEW_MAX_LENGTH}</span>
          </label>
          {!saved && validation && (rating > 0 || text.length > 0) ? <p className="text-sm text-red-600 dark:text-red-400">{validation}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={submitting} onClick={onClose}>{saved ? 'Done' : 'Cancel'}</Button>
            {!saved ? <Button type="button" loading={submitting} disabled={Boolean(validation) || submitting} onClick={() => void submit()}>{existing ? 'Save changes' : 'Submit review'}</Button> : null}
          </div>
        </div>
      </div>
    </div>, document.body,
  )
}

export function TraderReviews({ traderUserId, traderName, isSelf, averageRating, reviewCount, expanded = false }: {
  traderUserId: string
  traderName: string
  isSelf: boolean
  averageRating: number | null
  reviewCount: number
  expanded?: boolean
}) {
  const [reviews, setReviews] = useState<SocialTraderReview[]>([])
  const [loading, setLoading] = useState(expanded)
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [opening, setOpening] = useState(false)
  const [summary, setSummary] = useState({ average: averageRating, count: reviewCount })
  const ownReview = useMemo(() => reviews.find(review => review.isOwn) ?? null, [reviews])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await fetchSocialTraderReviews(supabase, traderUserId)
      setReviews(next)
      setSummary({ average: next.length ? next.reduce((sum, review) => sum + review.rating, 0) / next.length : null, count: next.length })
      setError(null)
      return true
    } catch {
      setReviews([])
      setError(REVIEW_LOAD_ERROR)
      return false
    } finally {
      setLoading(false)
    }
  }, [traderUserId])

  useEffect(() => {
    if (!expanded) return
    void Promise.resolve().then(refresh)
  }, [expanded, refresh])

  const openReview = async () => {
    if (opening) return
    setOpening(true)
    const loaded = await refresh()
    setOpening(false)
    if (loaded) setModalOpen(true)
  }

  const action = (
    <button type="button" disabled={isSelf || opening} aria-busy={opening} onClick={() => void openReview()}
      className="inline-flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-neutral-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-400 disabled:cursor-not-allowed disabled:opacity-70 dark:hover:bg-neutral-800"
      aria-label={isSelf ? `Your rating: ${summary.average?.toFixed(1) ?? 'not rated'}` : `${ownReview ? 'Edit rating for' : 'Rate'} ${traderName}`}>
      <Stars rating={summary.average ?? 0} label={summary.average == null ? 'Not rated' : `${summary.average.toFixed(1)} out of 5`} />
      <span>{summary.average == null ? 'No ratings' : summary.average.toFixed(1)} ({summary.count})</span>
      {!isSelf ? <span className="font-medium text-teal-700 dark:text-teal-300">{opening ? 'Loading reviews…' : ownReview ? 'Edit review' : 'Rate trader'}</span> : null}
    </button>
  )

  const loadError = error ? (
    <div className="mt-2 space-y-2">
      <Alert variant="error">{error}</Alert>
      {!isSelf ? <Button type="button" size="sm" variant="secondary" loading={opening} onClick={() => void openReview()}>Retry loading reviews</Button> : null}
    </div>
  ) : null

  return (
    <>
      {expanded ? <Card>
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">Trader reviews</h2>{action}</div>
        {loading ? <p className="mt-4 text-sm text-neutral-500">Loading reviews…</p> : null}
        {loadError}
        {!loading && !error && reviews.length === 0 ? <p className="mt-4 text-sm text-neutral-500">No written reviews yet.</p> : null}
        {!loading && reviews.length ? <ul className="mt-4 divide-y divide-neutral-100 dark:divide-neutral-800">{reviews.map(review => <li key={review.reviewId} className="py-3">
          <div className="flex flex-wrap items-center gap-2"><Stars rating={review.rating} label={`${review.rating} out of 5`} /><span className="text-sm font-medium">{review.reviewerDisplayName ?? 'Private reviewer'}</span>{review.reviewerUsername ? <span className="text-xs text-neutral-500">@{review.reviewerUsername}</span> : null}{review.isOwn ? <span className="text-xs text-neutral-500">Your review</span> : null}</div>
          <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-300">{review.reviewText}</p>
        </li>)}</ul> : null}
      </Card> : <div>{action}{loadError}</div>}
      {modalOpen && !isSelf ? <ReviewModal traderName={traderName} traderUserId={traderUserId} existing={ownReview} onClose={() => setModalOpen(false)} onSaved={async () => { await refresh() }} /> : null}
    </>
  )
}
