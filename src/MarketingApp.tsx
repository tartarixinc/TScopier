import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { LocaleProvider } from './context/LocaleContext'
import { LandingPage } from './pages/marketing/LandingPage'
import { ReferralLandingRedirect } from './pages/marketing/ReferralLandingRedirect'
import { appUrl } from './lib/site'
import { GoogleAnalyticsRouteTracker } from './components/analytics/GoogleAnalyticsRouteTracker'

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
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/:referralCode" element={<ReferralLandingRedirect />} />
            <Route path="*" element={<MarketingCatchAll />} />
          </Routes>
        </BrowserRouter>
      </LocaleProvider>
    </AuthProvider>
  )
}
