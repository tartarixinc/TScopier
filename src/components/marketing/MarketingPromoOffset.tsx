import { useMemo, useState, type ReactNode } from 'react'
import { PromoOffsetContext } from '../../hooks/useMarketingPromoOffset'

/**
 * The promo banner sits in normal flow above the page, while the floating nav is `fixed`. The banner reports its
 * height here so the nav can start below it and slide up to the top edge as the page scrolls.
 */
export function MarketingPromoOffsetProvider({ children }: { children: ReactNode }) {
  const [height, setHeight] = useState(0)
  const value = useMemo(() => ({ height, setHeight }), [height])
  return <PromoOffsetContext.Provider value={value}>{children}</PromoOffsetContext.Provider>
}
