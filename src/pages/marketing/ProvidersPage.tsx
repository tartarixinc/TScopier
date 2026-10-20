import { useEffect } from 'react'
import { MarketingLayout } from '../../components/marketing/MarketingLayout'
import { ProviderHeroSection } from '../../components/marketing/providers/ProviderHeroSection'
import { ProviderStepsSection } from '../../components/marketing/providers/ProviderStepsSection'
import { ProviderEarningsCalculator } from '../../components/marketing/providers/ProviderEarningsCalculator'
import { ProviderToolkitSection } from '../../components/marketing/providers/ProviderToolkitSection'
import { ProviderFaqSection, ProviderFinalCta } from '../../components/marketing/providers/ProviderFaqAndCta'
import { useProviderPage } from '../../components/marketing/providers/helpers'
import { captureReferralFromUrl } from '../../lib/referralCapture'
import { trackMarketingEvent } from '../../lib/analytics'

/** Marketing page for signal providers: a different pitch from the trader-focused landing page. */
export function ProvidersPage() {
  const { seoTitle } = useProviderPage()

  useEffect(() => {
    const ref = captureReferralFromUrl(window.location.search)
    trackMarketingEvent('providers_page_view', { referral_in_url: ref != null })
  }, [])

  useEffect(() => {
    const previous = document.title
    document.title = seoTitle
    return () => {
      document.title = previous
    }
  }, [seoTitle])

  return (
    <MarketingLayout darkHero>
      <ProviderHeroSection />
      <ProviderStepsSection />
      <ProviderEarningsCalculator />
      <ProviderToolkitSection />
      <ProviderFaqSection />
      <ProviderFinalCta />
    </MarketingLayout>
  )
}
