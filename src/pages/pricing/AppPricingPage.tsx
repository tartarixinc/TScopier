import { Link, useNavigate } from 'react-router-dom'
import { AuthBrandLogo } from '../../components/auth/AuthBrandLogo'
import { PricingSocialProof } from '../../components/marketing/pricing/PricingSocialProof'
import { PricingPlansSection } from '../../components/marketing/sections/PricingPlansSection'
import { PlanComparisonSection } from '../../components/marketing/sections/PlanComparisonSection'
import { PricingFaqSection } from '../../components/marketing/sections/PricingFaqSection'
import { PageShell } from '../../components/layout/PageShell'

export function AppPricingPage() {
  const navigate = useNavigate()

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-y-contain bg-white dark:bg-neutral-950">
      <header className="sticky top-0 z-20 flex shrink-0 items-center justify-between border-b border-neutral-200/55 bg-white/95 px-6 py-4 backdrop-blur dark:border-neutral-800/50 dark:bg-neutral-950/95 pt-[calc(1rem+env(safe-area-inset-top,0px)+var(--app-banner-h,0px))]">
        <Link to="/" className="flex items-center" aria-label="UniCopier">
          <AuthBrandLogo className="h-8 w-auto" />
        </Link>
        <button
          type="button"
          onClick={() => navigate('/dashboard', { replace: true })}
          className="text-sm font-medium text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors"
        >
          Not now
        </button>
      </header>

      <PageShell maxWidth="xl" spacing="none" className="pb-16">
        <PricingSocialProof variant="app">
          <PricingPlansSection variant="app" />
          <PlanComparisonSection variant="app" />
          <PricingFaqSection variant="app" />
        </PricingSocialProof>
      </PageShell>
    </div>
  )
}
