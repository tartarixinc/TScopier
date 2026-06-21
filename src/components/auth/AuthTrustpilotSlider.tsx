import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { Quote } from 'lucide-react'
import { TrustpilotBadge, TrustpilotStars } from './TrustpilotStars'

export interface AuthReview {
  headline?: string
  quote: string
  author: string
  role?: string
}

interface AuthTrustpilotSliderProps {
  reviews: AuthReview[]
  trustpilotLabel: string
}

const ROTATE_MS = 7000
const SLIDE_MS = 500

export function AuthTrustpilotSlider({ reviews, trustpilotLabel }: AuthTrustpilotSliderProps) {
  const [active, setActive] = useState(0)
  const [reduceMotion, setReduceMotion] = useState(false)
  const count = reviews.length

  useEffect(() => {
    setReduceMotion(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  }, [])

  const goTo = useCallback(
    (index: number) => {
      if (count === 0) return
      setActive(((index % count) + count) % count)
    },
    [count],
  )

  useEffect(() => {
    if (count <= 1 || reduceMotion) return
    const id = window.setInterval(() => {
      setActive(prev => (prev + 1) % count)
    }, ROTATE_MS)
    return () => window.clearInterval(id)
  }, [count, reduceMotion])

  if (count === 0) return null

  return (
    <div className="flex w-full max-w-lg flex-col items-center text-center">
      <span className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-100 text-teal-700 dark:bg-teal-950/80 dark:text-teal-400">
        <Quote className="h-6 w-6" strokeWidth={1.75} aria-hidden />
      </span>

      <div
        className="relative min-h-[12rem] w-full overflow-hidden sm:min-h-[11rem]"
        aria-live="polite"
        aria-atomic="true"
      >
        <div
          className={clsx('flex', !reduceMotion && 'ease-out')}
          style={{
            transform: `translateX(-${active * 100}%)`,
            transition: reduceMotion ? 'none' : `transform ${SLIDE_MS}ms ease-out`,
          }}
        >
          {reviews.map((item, index) => (
            <blockquote
              key={`${item.author}-${index}`}
              className="w-full shrink-0 px-1"
              aria-hidden={index !== active}
            >
              {item.headline ? (
                <p className="text-base font-semibold leading-snug tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-lg">
                  {item.headline}
                </p>
              ) : null}
              <p
                className={clsx(
                  'leading-relaxed text-neutral-700 dark:text-neutral-300',
                  item.headline
                    ? 'mt-3 text-sm font-normal sm:text-base'
                    : 'text-base font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-lg',
                )}
              >
                &ldquo;{item.quote}&rdquo;
              </p>
              <footer className="mt-5">
                <p className="text-base font-medium text-neutral-900 dark:text-neutral-100">
                  {item.author}
                </p>
                {item.role ? (
                  <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                    {item.role}
                  </p>
                ) : null}
              </footer>
            </blockquote>
          ))}
        </div>
      </div>

      <div className="mt-10 flex min-h-[4.5rem] flex-col items-center justify-start gap-3">
        <TrustpilotStars />
        <TrustpilotBadge label={trustpilotLabel} />
      </div>

      {count > 1 ? (
        <div
          className="mt-8 flex items-center justify-center gap-2"
          role="tablist"
          aria-label="Reviews"
        >
          {reviews.map((item, index) => (
            <button
              key={`${item.author}-${index}`}
              type="button"
              role="tab"
              aria-selected={index === active}
              aria-label={`Review ${index + 1}`}
              onClick={() => goTo(index)}
              className={clsx(
                'h-2 rounded-full transition-all duration-300',
                index === active
                  ? 'w-6 bg-teal-600 dark:bg-teal-400'
                  : 'w-2 bg-neutral-300 hover:bg-neutral-400 dark:bg-neutral-600 dark:hover:bg-neutral-500',
              )}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
