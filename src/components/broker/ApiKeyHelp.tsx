import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink } from 'lucide-react'

const VIEWPORT_PADDING = 8
const GAP = 8
const Z_INDEX = 130
const WIDTH = 320

type Coords = { left: number; top: number; placement: 'top' | 'bottom' }

/**
 * Text link ("How to get your API key") shown beside an API key field label. Opens (hover, focus or click) a popover with numbered steps and a
 * link to the exchange's API page. Unlike `InfoTooltip` the popover is interactive so the link can be clicked.
 * `title` doubles as the link text and the popover heading.
 */
export function ApiKeyHelp({
  title,
  steps,
  linkLabel,
  href,
}: {
  title: string
  steps: readonly string[]
  linkLabel: string
  href: string
}) {
  const popoverId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<Coords | null>(null)

  const cancelClose = useCallback(() => window.clearTimeout(closeTimer.current), [])
  const openNow = useCallback(() => {
    cancelClose()
    setOpen(true)
  }, [cancelClose])
  const closeSoon = useCallback(() => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => {
      setOpen(false)
      setCoords(null)
    }, 160)
  }, [cancelClose])

  useEffect(() => cancelClose, [cancelClose])

  const reposition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(WIDTH, window.innerWidth - VIEWPORT_PADDING * 2)
    const height = popoverRef.current?.offsetHeight ?? 240
    const left = Math.max(
      VIEWPORT_PADDING,
      Math.min(window.innerWidth - VIEWPORT_PADDING - width, rect.left + rect.width / 2 - width / 2),
    )
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING
    const placement = spaceBelow >= height + GAP || spaceBelow >= rect.top ? 'bottom' : 'top'
    const top = placement === 'bottom' ? rect.bottom + GAP : rect.top - GAP
    setCoords(prev =>
      prev && prev.left === left && prev.top === top && prev.placement === placement ? prev : { left, top, placement },
    )
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    reposition()
    const frame = requestAnimationFrame(reposition)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, reposition])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        setCoords(null)
      }
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
      setCoords(null)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  const popover = open
    ? createPortal(
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-label={title}
          onMouseEnter={openNow}
          onMouseLeave={closeSoon}
          style={{
            position: 'fixed',
            left: coords?.left ?? 0,
            top: coords?.top ?? 0,
            width: Math.min(WIDTH, window.innerWidth - VIEWPORT_PADDING * 2),
            zIndex: Z_INDEX,
            visibility: coords ? 'visible' : 'hidden',
            transform: coords?.placement === 'top' ? 'translateY(-100%)' : undefined,
          }}
          className="rounded-xl border border-neutral-200 bg-white p-4 text-left text-xs font-normal leading-relaxed text-neutral-900 shadow-xl dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-50"
        >
          <p className="text-sm font-semibold">{title}</p>
          <ol className="mt-2 space-y-2">
            {steps.map((step, index) => (
              <li key={step} className="flex gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-400 text-[0.65rem] font-semibold text-neutral-950">
                  {index + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-green-400 px-3 py-1.5 text-xs font-semibold text-neutral-950 transition-colors hover:bg-green-500"
          >
            {linkLabel}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        </div>,
        document.body,
      )
    : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
        onFocus={openNow}
        onClick={() => (open ? setOpen(false) : openNow())}
        className="shrink-0 rounded text-xs font-medium text-green-500 underline underline-offset-2 transition-colors hover:text-green-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-400 dark:text-green-400 dark:hover:text-green-300"
      >
        {title}
      </button>
      {popover}
    </>
  )
}
