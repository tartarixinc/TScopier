import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { LocaleProvider } from './context/LocaleContext'
import { LandingPage } from './pages/marketing/LandingPage'
import { PricingPage } from './pages/marketing/PricingPage'
import { RiskDisclaimerPage } from './pages/marketing/RiskDisclaimerPage'
import { TermsOfServicePage } from './pages/marketing/TermsOfServicePage'
import { PrivacyPolicyPage } from './pages/marketing/PrivacyPolicyPage'
import { CookiePolicyPage } from './pages/marketing/CookiePolicyPage'
import { ReferralLandingRedirect } from './pages/marketing/ReferralLandingRedirect'
import { appUrl } from './lib/site'
import { GoogleAnalyticsRouteTracker } from './components/analytics/GoogleAnalyticsRouteTracker'
import { CookieConsentBanner } from './components/marketing/CookieConsentBanner'

function MarketingCatchAll() {
  if (typeof window !== 'undefined') {
    window.location.href = appUrl('/dashboard')
  }
  return null
}

export default function MarketingApp() {
  return (
    <AuthProvider>
      <LocaleProvider>
        <BrowserRouter>
          <GoogleAnalyticsRouteTracker />
          <CookieConsentBanner />
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/pricing" element={<PricingPage />} />
            <Route path="/risk-disclaimer" element={<RiskDisclaimerPage />} />
            <Route path="/terms" element={<TermsOfServicePage />} />
            <Route path="/privacy" element={<PrivacyPolicyPage />} />
            <Route path="/cookie-policy" element={<CookiePolicyPage />} />
            <Route path="/:referralCode" element={<ReferralLandingRedirect />} />
            <Route path="*" element={<MarketingCatchAll />} />
          </Routes>
        </BrowserRouter>
      </LocaleProvider>
    </AuthProvider>
  )
}
