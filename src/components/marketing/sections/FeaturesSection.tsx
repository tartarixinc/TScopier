import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useReducedMotion } from 'framer-motion'
import { useT } from '../../../context/LocaleContext'
import { APP_CANVAS, APP_CARD, APP_SECTION_LABEL } from '../../../lib/appSurface'
import { FeatureShowcasePanel } from '../features/FeatureShowcasePanel'
import { FeatureVisual } from '../features/FeatureVisual'
import { ScrollReveal } from '../ScrollReveal'

const WHEEL_THRESHOLD = 55
const STEP_COOLDOWN_MS = 520
const HEADER_OFFSET = 72

function useIsNarrow(breakpointPx = 1024) {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < breakpointPx : false,
  )

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`)
    const sync = () => setNarrow(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [breakpointPx])

  return narrow
}

function FeaturesStacked() {
  const l = useT().landing.features

  return (
    <section id="features" className={clsx('scroll-mt-28 py-16 sm:py-24', APP_CANVAS)}>
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <ScrollReveal className="mx-auto max-w-2xl text-center">
          <p className={clsx('inline-flex items-center gap-2', APP_SECTION_LABEL)}>
            <span className="h-2 w-2 bg-green-400" aria-hidden />
            {l.eyebrow}
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-neutral-950 sm:text-4xl dark:text-white">
            {l.title}
          </h2>
          <p className="mt-4 text-neutral-600 dark:text-neutral-300">{l.subtitle}</p>
        </ScrollReveal>

        <div className="mt-12 space-y-8">
          {l.showcases.map((showcase, index) => (
            <ScrollReveal key={showcase.visual} delay={0.04 * index} y={36}>
              <FeatureShowcasePanel
                eyebrow={showcase.eyebrow}
                title={showcase.title}
                description={showcase.description}
                reverse={index % 2 === 1}
                visual={<FeatureVisual id={showcase.visual} />}
              />
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  )
}

/**
 * True scroll hijack: when this stage is pinned in the viewport, wheel/touch
 * advances feature cards and the page does not move until the first/last card.
 */
function FeaturesScrollHijack() {
  const l = useT().landing.features
  const count = l.showcases.length
  const sectionRef = useRef<HTMLElement>(null)
  const [active, setActive] = useState(0)
  const [pinned, setPinned] = useState(false)

  const activeRef = useRef(0)
  const pinnedRef = useRef(false)
  const cooldownRef = useRef(false)
  const accRef = useRef(0)
  const touchYRef = useRef<number | null>(null)

  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    pinnedRef.current = pinned
  }, [pinned])

  const goTo = (index: number) => {
    const next = Math.min(count - 1, Math.max(0, index))
    if (next === activeRef.current) return
    activeRef.current = next
    setActive(next)
    cooldownRef.current = true
    window.setTimeout(() => {
      cooldownRef.current = false
      accRef.current = 0
    }, STEP_COOLDOWN_MS)
  }

  const snapSectionIntoView = () => {
    const el = sectionRef.current
    if (!el) return
    const top = window.scrollY + el.getBoundingClientRect().top - HEADER_OFFSET
    window.scrollTo({ top, behavior: 'auto' })
  }

  const inPinZone = () => {
    const el = sectionRef.current
    if (!el) return false
    const rect = el.getBoundingClientRect()
    return rect.top <= HEADER_OFFSET + 8 && rect.bottom >= window.innerHeight * 0.55
  }

  const approachingFromAbove = () => {
    const el = sectionRef.current
    if (!el) return false
    const rect = el.getBoundingClientRect()
    return rect.top > HEADER_OFFSET && rect.top < window.innerHeight * 0.72
  }

  const approachingFromBelow = () => {
    const el = sectionRef.current
    if (!el) return false
    const rect = el.getBoundingClientRect()
    return rect.bottom < window.innerHeight - 8 && rect.bottom > window.innerHeight * 0.28
  }

  useEffect(() => {
    const onScroll = () => {
      const nextPinned = inPinZone()
      if (nextPinned !== pinnedRef.current) {
        pinnedRef.current = nextPinned
        setPinned(nextPinned)
        if (nextPinned) snapSectionIntoView()
      }
    }

    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  useEffect(() => {
    const stepFromDelta = (delta: number) => {
      const goingDown = delta > 0
      const idx = activeRef.current

      // Pull the section into pin before hijacking card steps.
      if (!inPinZone()) {
        if (goingDown && approachingFromAbove()) {
          snapSectionIntoView()
          pinnedRef.current = true
          setPinned(true)
          return true
        }
        if (!goingDown && approachingFromBelow()) {
          snapSectionIntoView()
          pinnedRef.current = true
          setPinned(true)
          return true
        }
        return false
      }

      if (goingDown && idx < count - 1) {
        accRef.current += delta
        if (!cooldownRef.current && accRef.current >= WHEEL_THRESHOLD) {
          goTo(idx + 1)
        }
        return true
      }

      if (!goingDown && idx > 0) {
        accRef.current += delta
        if (!cooldownRef.current && accRef.current <= -WHEEL_THRESHOLD) {
          goTo(idx - 1)
        }
        return true
      }

      // Boundary card — release page scroll.
      accRef.current = 0
      return false
    }

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return
      const handled = stepFromDelta(event.deltaY)
      if (handled) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    const onTouchStart = (event: TouchEvent) => {
      touchYRef.current = event.touches[0]?.clientY ?? null
    }

    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY
      if (y == null || touchYRef.current == null) return
      const delta = touchYRef.current - y
      touchYRef.current = y
      const handled = stepFromDelta(delta)
      if (handled) event.preventDefault()
    }

    const onTouchEnd = () => {
      touchYRef.current = null
      accRef.current = 0
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (!inPinZone()) return
      if (event.key === 'ArrowDown' || event.key === 'PageDown') {
        if (activeRef.current < count - 1) {
          event.preventDefault()
          goTo(activeRef.current + 1)
        }
      } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
        if (activeRef.current > 0) {
          event.preventDefault()
          goTo(activeRef.current - 1)
        }
      }
    }

    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [count])

  const progress = count <= 1 ? 100 : ((active + 1) / count) * 100

  return (
    <section
      id="features"
      ref={sectionRef}
      className={clsx(
        'relative scroll-mt-20',
        APP_CANVAS,
        pinned && 'z-20',
      )}
    >
      <div className="flex min-h-[calc(100dvh-4.5rem)] flex-col px-5 py-10 sm:px-8 lg:px-10">
        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col">
          <div className="shrink-0">
            <p className={clsx('inline-flex items-center gap-2', APP_SECTION_LABEL)}>
              <span className="h-2 w-2 bg-green-400" aria-hidden />
              {l.eyebrow}
            </p>
            <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
              <div className="max-w-2xl">
                <h2 className="text-3xl font-semibold tracking-tight text-neutral-950 sm:text-4xl dark:text-white">
                  {l.title}
                </h2>
                <p className="mt-3 max-w-xl text-sm leading-relaxed text-neutral-600 sm:text-base dark:text-neutral-300">
                  {l.subtitle}
                </p>
              </div>
              <p className="tabular-nums text-sm font-medium text-neutral-500 dark:text-neutral-400">
                <span className="text-neutral-950 dark:text-white">
                  {String(active + 1).padStart(2, '0')}
                </span>
                <span className="mx-1.5 text-neutral-300 dark:text-neutral-600">/</span>
                {String(count).padStart(2, '0')}
              </p>
            </div>
            <div className="mt-5 h-1 overflow-hidden rounded-full bg-neutral-200/80 dark:bg-neutral-800">
              <div
                className="h-full rounded-full bg-green-400 transition-[width] duration-500 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          <div className="mt-8 grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)] lg:gap-10">
            <div className={clsx('flex min-h-0 flex-col overflow-hidden p-4 sm:p-5', APP_CARD)}>
              <ol className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain">
                {l.showcases.map((showcase, index) => {
                  const isActive = index === active
                  return (
                    <li key={showcase.visual}>
                      <button
                        type="button"
                        onClick={() => goTo(index)}
                        className={clsx(
                          'w-full rounded-2xl px-3.5 py-3 text-start transition-colors',
                          isActive
                            ? 'bg-[#ECEEF2] dark:bg-neutral-900'
                            : 'hover:bg-neutral-50 dark:hover:bg-white/5',
                        )}
                        aria-current={isActive ? 'step' : undefined}
                      >
                        <div className="flex items-start gap-3">
                          <span
                            className={clsx(
                              'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums',
                              isActive
                                ? 'bg-green-400 text-neutral-950'
                                : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
                            )}
                          >
                            {String(index + 1).padStart(2, '0')}
                          </span>
                          <span className="min-w-0">
                            <span
                              className={clsx(
                                'block text-[11px] font-semibold uppercase tracking-wide',
                                isActive
                                  ? 'text-green-600 dark:text-green-400'
                                  : 'text-neutral-400 dark:text-neutral-500',
                              )}
                            >
                              {showcase.eyebrow}
                            </span>
                            <span
                              className={clsx(
                                'mt-1 block text-sm font-semibold leading-snug sm:text-base',
                                isActive
                                  ? 'text-neutral-950 dark:text-white'
                                  : 'text-neutral-600 dark:text-neutral-300',
                              )}
                            >
                              {showcase.title}
                            </span>
                            <span
                              className={clsx(
                                'mt-2 block overflow-hidden text-sm leading-relaxed text-neutral-600 transition-[max-height,opacity] duration-300 dark:text-neutral-300',
                                isActive ? 'max-h-44 opacity-100' : 'max-h-0 opacity-0',
                              )}
                            >
                              {showcase.description}
                            </span>
                          </span>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ol>
            </div>

            <div className="relative min-h-[22rem] lg:min-h-0">
              {l.showcases.map((showcase, index) => {
                const isActive = index === active
                return (
                  <div
                    key={showcase.visual}
                    className={clsx(
                      'absolute inset-0 transition-[opacity,transform] duration-500 ease-out',
                      isActive
                        ? 'z-10 translate-y-0 opacity-100'
                        : 'pointer-events-none z-0 translate-y-4 opacity-0',
                    )}
                    aria-hidden={!isActive}
                  >
                    <div className={clsx('flex h-full flex-col overflow-hidden p-3 sm:p-4', APP_CARD)}>
                      <div className="marketing-feature-visual min-h-0 flex-1 overflow-hidden rounded-xl">
                        <FeatureVisual id={showcase.visual} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

export function FeaturesSection() {
  const reduceMotion = useReducedMotion()
  const narrow = useIsNarrow(1024)

  if (reduceMotion || narrow) return <FeaturesStacked />
  return <FeaturesScrollHijack />
}
