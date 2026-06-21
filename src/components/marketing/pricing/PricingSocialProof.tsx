import type { ReactNode } from 'react'
import { useT } from '../../../context/LocaleContext'
import { interpolate } from '../../../i18n/interpolate'
import { formatPricingSocialProofTimeAgo, pricingSocialProofCountryFlag } from '../../../lib/pricingSocialProof'
import { usePricingSocialProof } from '../../../hooks/usePricingSocialProof'
import { PricingSocialProofBanner } from './PricingSocialProofBanner'
import { PricingPurchaseToast } from './PricingPurchaseToast'

interface PricingSocialProofProps {
  children: ReactNode
  variant?: 'marketing' | 'app'
}

export function PricingSocialProof({ children, variant = 'marketing' }: PricingSocialProofProps) {
  const t = useT()
  const sp = t.landing.pricingSocialProof
  const pt = t.pricing
  const { purchaseCount, activeToast, toastVisible, reduceMotion } = usePricingSocialProof()

  const bannerMessage = interpolate(sp.banner, { count: String(purchaseCount) })

  const toastMessage = activeToast
    ? interpolate(sp.purchaseToast, {
        country: activeToast.country,
        plan: activeToast.plan === 'advanced' ? pt.advanced.name : pt.basic.name,
      })
    : ''

  const toastTimeAgo = activeToast
    ? formatPricingSocialProofTimeAgo(activeToast.timeAgo, {
        justNow: sp.timeAgoJustNow,
        oneMinute: sp.timeAgoOneMinute,
      })
    : ''

  return (
    <>
      <PricingSocialProofBanner message={bannerMessage} variant={variant} />
      {children}
      <PricingPurchaseToast
        message={toastMessage}
        timeAgo={toastTimeAgo}
        flag={activeToast ? pricingSocialProofCountryFlag(activeToast.country) : ''}
        visible={toastVisible && activeToast != null}
        reduceMotion={reduceMotion}
      />
    </>
  )
}
