import { createContext, useContext, useEffect, useState } from 'react'

export type PromoOffsetValue = {
  height: number
  setHeight: (height: number) => void
}

export const PromoOffsetContext = createContext<PromoOffsetValue>({ height: 0, setHeight: () => {} })

export function useReportPromoHeight(): (height: number) => void {
  return useContext(PromoOffsetContext).setHeight
}

/** Distance in px from the top of the viewport to where the fixed nav should start. 0 when there is no banner. */
export function useMarketingHeaderTop(): number {
  const { height } = useContext(PromoOffsetContext)
  const [top, setTop] = useState(height)

  useEffect(() => {
    let frame = 0
    const update = () => {
      frame = 0
      setTop(Math.max(0, height - window.scrollY))
    }
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [height])

  return height === 0 ? 0 : top
}
