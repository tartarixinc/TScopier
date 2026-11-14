import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { MarketingLayout } from '../../components/marketing/MarketingLayout'
import { ScrollReveal } from '../../components/marketing/ScrollReveal'
import { HeroSection } from '../../components/marketing/sections/HeroSection'
// import { StatsSection } from '../../components/marketing/sections/StatsSection'
import { SupportedPlatformsSection } from '../../components/marketing/sections/SupportedPlatformsSection'
// import { CompletePictureSection } from '../../components/marketing/sections/CompletePictureSection'
// import { IntegrationsSection } from '../../components/marketing/sections/IntegrationsSection'
import { ProductShowcaseSection } from '../../components/marketing/sections/ProductShowcaseSection'
import { SellSignalsSection } from '../../components/marketing/sections/SellSignalsSection'
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

  // Arriving from another marketing page via "For Providers" (/#providers).
  useEffect(() => {
    if (!location.hash) return
    const id = decodeURIComponent(location.hash.slice(1))
    const t = window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 150)
    return () => window.clearTimeout(t)
  }, [location.hash])

  return (
    <MarketingLayout>
      {/* Hero stays static so the first viewport doesn’t fade in after paint. */}
      <HeroSection />
      <ScrollReveal>
        <SupportedPlatformsSection />
      </ScrollReveal>
      {/* Showcase / features / steps / reviews handle their own staggered reveals. */}
      <ProductShowcaseSection />
      <ScrollReveal>
        <WhyChooseSection />
      </ScrollReveal>
      <ScrollReveal>
        <SellSignalsSection />
      </ScrollReveal>
      <FeaturesSection />
      <ScrollReveal>
        <ComparisonSection />
      </ScrollReveal>
      <StepsSection />
      <ScrollReveal>
        <FaqSection />
      </ScrollReveal>
      <ReviewsSection />
    </MarketingLayout>
  )
}
