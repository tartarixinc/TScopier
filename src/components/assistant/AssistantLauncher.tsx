import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Minus, Sparkles, X } from 'lucide-react'
import clsx from 'clsx'
import { useAuth } from '../../context/AuthContext'
import { useAssistant } from '../../context/useAssistant'
import { useT } from '../../context/LocaleContext'
import { useLiveChat } from '../../context/LiveChatContext'

export type AssistantLauncherPosition = {
  x: number
  y: number
}

type AssistantLauncherProps = {
  visible: boolean
  minimized: boolean
  position: AssistantLauncherPosition | null
  onVisibleChange: (visible: boolean) => void
  onMinimizedChange: (minimized: boolean) => void
  onPositionChange: (position: AssistantLauncherPosition) => void
}

type DragState = {
  pointerId: number
  startPointerX: number
  startPointerY: number
  startX: number
  startY: number
  hasMoved: boolean
}

const EDGE_MARGIN = 12
const DEFAULT_RIGHT = 20
const DEFAULT_BOTTOM = 96
const DRAG_THRESHOLD_PX = 4

function getViewportSize() {
  const viewport = window.visualViewport
  return {
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  }
}

function clampPosition(
  next: AssistantLauncherPosition,
  size: { width: number; height: number },
): AssistantLauncherPosition {
  const viewport = getViewportSize()
  const maxX = Math.max(EDGE_MARGIN, viewport.width - size.width - EDGE_MARGIN)
  const maxY = Math.max(EDGE_MARGIN, viewport.height - size.height - EDGE_MARGIN)
  return {
    x: Math.min(Math.max(next.x, EDGE_MARGIN), maxX),
    y: Math.min(Math.max(next.y, EDGE_MARGIN), maxY),
  }
}

function positionsMatch(a: AssistantLauncherPosition, b: AssistantLauncherPosition) {
  return Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y)
}

export function AssistantLauncher({
  visible,
  minimized,
  position,
  onVisibleChange,
  onMinimizedChange,
  onPositionChange,
}: AssistantLauncherProps) {
  const { user } = useAuth()
  const { open, openAssistant } = useAssistant()
  const { visibility: liveChatVisibility } = useLiveChat()
  const t = useT()
  const a = t.nav.assistant
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const suppressNextClickRef = useRef(false)

  const getCurrentPosition = useCallback((): AssistantLauncherPosition => {
    if (position) return position
    const rect = rootRef.current?.getBoundingClientRect()
    const width = rect?.width ?? (minimized ? 48 : 288)
    const height = rect?.height ?? (minimized ? 48 : 72)
    const viewport = getViewportSize()
    return clampPosition(
      {
        x: viewport.width - width - DEFAULT_RIGHT,
        y: viewport.height - height - DEFAULT_BOTTOM,
      },
      { width, height },
    )
  }, [minimized, position])

  const clampCurrentPosition = useCallback(() => {
    const element = rootRef.current
    if (!element || typeof window === 'undefined') return
    const rect = element.getBoundingClientRect()
    const next = position
      ? clampPosition(position, rect)
      : getCurrentPosition()
    if (!position || !positionsMatch(position, next)) {
      onPositionChange(next)
    }
  }, [getCurrentPosition, onPositionChange, position])

  useEffect(() => {
    if (!visible || open || liveChatVisibility === 'maximized') return
    clampCurrentPosition()
  }, [clampCurrentPosition, liveChatVisibility, minimized, open, visible])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = () => clampCurrentPosition()
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
    }
  }, [clampCurrentPosition])

  const handleOpen = (event?: ReactMouseEvent<HTMLElement>) => {
    event?.stopPropagation()
    if (suppressNextClickRef.current || dragRef.current?.hasMoved) {
      suppressNextClickRef.current = false
      return
    }
    openAssistant()
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-assistant-launcher-control="true"]')) return
    const element = rootRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const current = position ?? { x: rect.left, y: rect.top }
    const clamped = clampPosition(current, rect)
    if (!position || !positionsMatch(position, clamped)) {
      onPositionChange(clamped)
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startX: clamped.x,
      startY: clamped.y,
      hasMoved: false,
    }
    element.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const element = rootRef.current
    if (!element) return
    const dx = event.clientX - drag.startPointerX
    const dy = event.clientY - drag.startPointerY
    if (!drag.hasMoved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
      drag.hasMoved = true
    }
    if (!drag.hasMoved) return
    event.preventDefault()
    const rect = element.getBoundingClientRect()
    onPositionChange(clampPosition({ x: drag.startX + dx, y: drag.startY + dy }, rect))
  }

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    rootRef.current?.releasePointerCapture(event.pointerId)
    if (drag.hasMoved) {
      suppressNextClickRef.current = true
      window.setTimeout(() => {
        suppressNextClickRef.current = false
      }, 250)
    }
    dragRef.current = null
  }

  if (!user || !visible || open || liveChatVisibility === 'maximized') return null

  const style: CSSProperties | undefined = position
    ? {
        left: position.x,
        top: position.y,
      }
    : undefined

  if (minimized) {
    return (
      <div
        ref={rootRef}
        style={style}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onClick={handleOpen}
        className={clsx(
          'fixed z-40 touch-none select-none',
          !position && 'bottom-[calc(5.75rem+env(safe-area-inset-bottom,0px))] end-3 sm:bottom-[calc(6rem+env(safe-area-inset-bottom,0px))] sm:end-5',
        )}
      >
        <button
          type="button"
          aria-label={a.ariaLabel}
          title={a.title}
          onClick={handleOpen}
          className={clsx(
            'inline-flex h-12 w-12 cursor-grab items-center justify-center rounded-full border border-teal-200 bg-white text-teal-700 shadow-lg shadow-neutral-900/10 active:cursor-grabbing',
            'transition hover:-translate-y-0.5 hover:border-teal-300 hover:bg-teal-50 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 focus:ring-offset-white',
            'dark:border-teal-900/70 dark:bg-neutral-900 dark:text-teal-300 dark:shadow-black/30 dark:hover:bg-teal-950/50 dark:focus:ring-offset-neutral-950',
          )}
        >
          <Sparkles className="h-5 w-5" aria-hidden />
        </button>
        <button
          type="button"
          data-assistant-launcher-control="true"
          aria-label="Close UniCopier Assistant launcher"
          title="Close"
          onClick={event => {
            event.stopPropagation()
            onVisibleChange(false)
          }}
          className={clsx(
            'absolute -end-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-500 shadow-sm',
            'transition hover:bg-neutral-100 hover:text-neutral-800 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 focus:ring-offset-white',
            'dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:focus:ring-offset-neutral-950',
          )}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      style={style}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onClick={handleOpen}
      className={clsx(
        'fixed z-40 w-[min(calc(100vw-1.5rem),18rem)] touch-none select-none sm:w-72',
        !position && 'bottom-[calc(5.75rem+env(safe-area-inset-bottom,0px))] end-3 sm:bottom-[calc(6rem+env(safe-area-inset-bottom,0px))] sm:end-5',
      )}
    >
      <button
        type="button"
        aria-label={a.ariaLabel}
        onClick={handleOpen}
        className={clsx(
          'group flex w-full cursor-grab items-center gap-3 rounded-xl border border-neutral-200 bg-white p-3 pe-20 text-start shadow-lg shadow-neutral-900/10 active:cursor-grabbing',
          'transition hover:-translate-y-0.5 hover:border-teal-200 hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 focus:ring-offset-white',
          'dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-black/30 dark:hover:border-teal-900/80 dark:focus:ring-offset-neutral-950',
        )}
      >
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300"
          aria-hidden
        >
          <Sparkles className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {a.title}
          </span>
          <span className="mt-0.5 block text-xs leading-5 text-neutral-500 dark:text-neutral-400">
            How can I help with your trades today?
          </span>
        </span>
      </button>
      <button
        type="button"
        data-assistant-launcher-control="true"
        aria-label="Minimize UniCopier Assistant launcher"
        title="Minimize"
        onClick={event => {
          event.stopPropagation()
          onMinimizedChange(true)
        }}
        className={clsx(
          'absolute end-10 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-neutral-400',
          'transition hover:bg-neutral-100 hover:text-neutral-700 focus:outline-none focus:ring-2 focus:ring-teal-500',
          'dark:hover:bg-neutral-800 dark:hover:text-neutral-200',
        )}
      >
        <Minus className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        data-assistant-launcher-control="true"
        aria-label="Close UniCopier Assistant launcher"
        title="Close"
        onClick={event => {
          event.stopPropagation()
          onVisibleChange(false)
        }}
        className={clsx(
          'absolute end-2.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-neutral-400',
          'transition hover:bg-neutral-100 hover:text-neutral-700 focus:outline-none focus:ring-2 focus:ring-teal-500',
          'dark:hover:bg-neutral-800 dark:hover:text-neutral-200',
        )}
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  )
}
