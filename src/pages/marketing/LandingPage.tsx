import { MarketingLayout } from '../../components/marketing/MarketingLayout'
import { HeroSection } from '../../components/marketing/sections/HeroSection'
import { WhyChooseSection } from '../../components/marketing/sections/WhyChooseSection'
import { ComparisonSection } from '../../components/marketing/sections/ComparisonSection'
import { FeaturesSection } from '../../components/marketing/sections/FeaturesSection'
import { StepsSection } from '../../components/marketing/sections/StepsSection'
import { ReviewsSection } from '../../components/marketing/sections/ReviewsSection'
import { PricingTeaserSection } from '../../components/marketing/sections/PricingTeaserSection'

export function LandingPage() {
  return (
    <MarketingLayout>
      <HeroSection />
      <WhyChooseSection />
      <FeaturesSection />
      <ComparisonSection />
      <StepsSection />
      <ReviewsSection />
      <PricingTeaserSection />
    </MarketingLayout>
  )
}
