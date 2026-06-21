import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'
import clsx from 'clsx'
import { Input } from './Input'
import { Select } from './Select'

const VIEWPORT_PADDING = 8
const TOOLTIP_GAP = 6
const TOOLTIP_Z_INDEX = 120

type TooltipPlacement = 'top' | 'bottom'

type TooltipCoords = {
  left: number
  top: number
  placement: TooltipPlacement
}

function measureTooltipPosition(
  trigger: HTMLElement,
  tooltip: HTMLElement | null,
): TooltipCoords {
  const rect = trigger.getBoundingClientRect()
  const tooltipWidth = tooltip?.offsetWidth ?? 280
  const tooltipHeight = tooltip?.offsetHeight ?? 48

  const centerX = rect.left + rect.width / 2
  const halfWidth = tooltipWidth / 2
  const left = Math.max(
    VIEWPORT_PADDING + halfWidth,
    Math.min(window.innerWidth - VIEWPORT_PADDING - halfWidth, centerX),
  )

  const spaceAbove = rect.top - VIEWPORT_PADDING
  const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING
  const preferTop = spaceAbove >= tooltipHeight + TOOLTIP_GAP || spaceAbove >= spaceBelow
  const placement: TooltipPlacement = preferTop ? 'top' : 'bottom'
  const top =
    placement === 'top' ? rect.top - TOOLTIP_GAP : rect.bottom + TOOLTIP_GAP

  return { left, top, placement }
}

export function InfoTooltip({ text, className }: { text: string; className?: string }) {
  const trimmed = text.trim()
  const tooltipId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<TooltipCoords | null>(null)

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return
    const next = measureTooltipPosition(triggerRef.current, tooltipRef.current)
    setCoords((prev) => {
      if (
        prev &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.placement === next.placement
      ) {
        return prev
      }
      return next
    })
  }, [])

  const show = useCallback(() => setOpen(true), [])
  const hide = useCallback(() => {
    setOpen(false)
    setCoords(null)
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    const raf = requestAnimationFrame(updatePosition)

    const onScrollOrResize = () => updatePosition()
    window.addEventListener('resize', onScrollOrResize)
    window.addEventListener('scroll', onScrollOrResize, true)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onScrollOrResize)
      window.removeEventListener('scroll', onScrollOrResize, true)
    }
  }, [open, updatePosition, trimmed])

  if (!trimmed) return null

  const tooltipNode = open
    ? createPortal(
        <span
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          style={{
            position: 'fixed',
            left: coords?.left ?? 0,
            top: coords?.top ?? 0,
            zIndex: TOOLTIP_Z_INDEX,
            visibility: coords ? 'visible' : 'hidden',
            transform:
              coords?.placement === 'bottom'
                ? 'translate(-50%, 0)'
                : 'translate(-50%, -100%)',
          }}
          className="pointer-events-none w-max max-w-[min(22rem,calc(100vw-2rem))] whitespace-pre-line rounded-md border border-neutral-200 bg-white px-2.5 py-2 text-left text-xs font-normal leading-relaxed text-neutral-600 shadow-lg dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
        >
          {trimmed}
        </span>,
        document.body,
      )
    : null

  return (
    <>
      <span className={clsx('inline-flex shrink-0 align-middle', className)}>
        <button
          ref={triggerRef}
          type="button"
          tabIndex={0}
          aria-describedby={open ? tooltipId : undefined}
          onMouseEnter={show}
          onMouseLeave={hide}
          onFocus={show}
          onBlur={hide}
          className="inline-flex items-center justify-center rounded-full text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          aria-label={trimmed}
        >
          <Info className="w-3.5 h-3.5" aria-hidden />
        </button>
      </span>
      {tooltipNode}
    </>
  )
}

export function ConfigTitle({
  children,
  info,
  className,
  variant = 'medium',
}: {
  children: ReactNode
  info?: string
  className?: string
  variant?: 'medium' | 'semibold'
}) {
  return (
    <p
      className={clsx(
        'inline-flex items-center gap-1.5',
        variant === 'semibold'
          ? 'text-sm font-semibold text-neutral-900 dark:text-neutral-50'
          : 'text-sm font-medium text-neutral-800 dark:text-neutral-100',
        className,
      )}
    >
      <span>{children}</span>
      {info ? <InfoTooltip text={info} /> : null}
    </p>
  )
}

/** Title text for toggle rows (span, not paragraph). */
export function ConfigToggleLabel({
  children,
  info,
  className,
}: {
  children: ReactNode
  info?: string
  className?: string
}) {
  return (
    <span
      className={clsx(
        'text-sm font-medium text-neutral-800 dark:text-neutral-100 inline-flex items-center gap-1.5',
        className,
      )}
    >
      {children}
      {info ? <InfoTooltip text={info} /> : null}
    </span>
  )
}

export function FieldLabelWithInfo({ label, hint }: { label: string; hint?: string }) {
  return (
    <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300 inline-flex items-center gap-1.5">
      <span>{label}</span>
      {hint ? <InfoTooltip text={hint} /> : null}
    </label>
  )
}

export function ConfigureInput(props: ComponentProps<typeof Input>) {
  return <Input {...props} hintInTooltip />
}

export function ConfigureSelect(props: ComponentProps<typeof Select>) {
  return <Select {...props} hintInTooltip />
}
