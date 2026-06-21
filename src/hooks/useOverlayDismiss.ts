import { useCallback, useRef, type RefObject } from 'react'

/**
 * Dismiss a modal only when both pointerdown and click land on the backdrop.
 * Prevents closing when the user drag-selects text in an input and releases outside.
 */
export function useOverlayDismiss(
  overlayRef: RefObject<HTMLElement | null>,
  backdropRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
) {
  const pointerDownTarget = useRef<EventTarget | null>(null)

  const isBackdropTarget = useCallback(
    (target: EventTarget | null) =>
      target === overlayRef.current || target === backdropRef.current,
    [overlayRef, backdropRef],
  )

  const onOverlayMouseDown = useCallback((event: React.MouseEvent) => {
    pointerDownTarget.current = event.target
  }, [])

  const onOverlayClick = useCallback(
    (event: React.MouseEvent) => {
      if (isBackdropTarget(event.target) && isBackdropTarget(pointerDownTarget.current)) {
        onDismiss()
      }
      pointerDownTarget.current = null
    },
    [isBackdropTarget, onDismiss],
  )

  return { onOverlayMouseDown, onOverlayClick }
}
