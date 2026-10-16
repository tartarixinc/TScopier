import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { MarketingLayout } from '../../components/marketing/MarketingLayout'
import { HeroSection } from '../../components/marketing/sections/HeroSection'
import { StatsSection } from '../../components/marketing/sections/StatsSection'
import { IntegrationsSection } from '../../components/marketing/sections/IntegrationsSection'
import { ProductShowcaseSection } from '../../components/marketing/sections/ProductShowcaseSection'
import { WhyChooseSection } from '../../components/marketing/sections/WhyChooseSection'
import { ComparisonSection } from '../../components/marketing/sections/ComparisonSection'
import { FeaturesSection } from '../../components/marketing/sections/FeaturesSection'
import { StepsSection } from '../../components/marketing/sections/StepsSection'
import { FaqSection } from '../../components/marketing/sections/FaqSection'
import { ReviewsSection } from '../../components/marketing/sections/ReviewsSection'
import { captureReferralFromUrl } from '../../lib/referralCapture'
import { trackMarketingEvent } from '../../lib/analytics'

export function LandingPage() {
  const location = useLocation()

  useEffect(() => {
    const ref = captureReferralFromUrl(location.search)
    trackMarketingEvent('landing_page_view', {
      referral_in_url: ref != null,
    })
  }, [location.search])

  return (
    <MarketingLayout>
      <HeroSection />
      <StatsSection />
      <IntegrationsSection />
      <ProductShowcaseSection />
      <WhyChooseSection />
      <FeaturesSection />
      <ComparisonSection />
      <StepsSection />
      <FaqSection />
      <ReviewsSection />
    </MarketingLayout>
  )
}
