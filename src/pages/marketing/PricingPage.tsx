import { useEffect } from 'react'
import { MarketingLayout } from '../../components/marketing/MarketingLayout'
import { PricingSocialProof } from '../../components/marketing/pricing/PricingSocialProof'
import { PricingPlansSection } from '../../components/marketing/sections/PricingPlansSection'
import { PlanComparisonSection } from '../../components/marketing/sections/PlanComparisonSection'
import { PricingFaqSection } from '../../components/marketing/sections/PricingFaqSection'
import { trackMarketingEvent } from '../../lib/analytics'

export function PricingPage() {
  useEffect(() => {
    trackMarketingEvent('pricing_page_view')
  }, [])

  return (
    <MarketingLayout>
      <PricingSocialProof>
        <PricingPlansSection />
        <PlanComparisonSection />
        <PricingFaqSection />
      </PricingSocialProof>
    </MarketingLayout>
  )
}
