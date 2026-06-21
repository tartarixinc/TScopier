import { PricingSocialProof } from '../../components/marketing/pricing/PricingSocialProof'
import { PricingPlansSection } from '../../components/marketing/sections/PricingPlansSection'
import { PlanComparisonSection } from '../../components/marketing/sections/PlanComparisonSection'
import { PricingFaqSection } from '../../components/marketing/sections/PricingFaqSection'
import { PageShell } from '../../components/layout/PageShell'

export function AppPricingPage() {
  return (
    <PageShell maxWidth="xl" spacing="none">
      <PricingSocialProof variant="app">
        <PricingPlansSection variant="app" />
        <PlanComparisonSection variant="app" />
        <PricingFaqSection variant="app" />
      </PricingSocialProof>
    </PageShell>
  )
}
