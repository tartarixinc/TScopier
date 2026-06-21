import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { LocaleProvider } from './context/LocaleContext'
import { UserProfileProvider } from './context/UserProfileContext'
import { SubscriptionProvider } from './context/SubscriptionContext'
import { AuthLayout } from './components/layout/AuthLayout'
import { VerifyEmailLayout } from './components/layout/VerifyEmailLayout'
import { AppShell } from './components/layout/AppShell'
import { ProtectedRoute } from './components/layout/ProtectedRoute'
import { EmailVerificationGate } from './components/layout/EmailVerificationGate'
import { SubscriptionGuard } from './components/layout/SubscriptionGuard'
import { PageLoader } from './components/layout/PageLoader'
import { ReferralCodeRedirect } from './pages/auth/ReferralCodeRedirect'
import { VerifyEmailPage } from './pages/auth/VerifyEmailPage'
import { AuthConfirmedPage } from './pages/auth/AuthConfirmedPage'
import { GoogleAnalyticsRouteTracker } from './components/analytics/GoogleAnalyticsRouteTracker'
import { CookieConsentBanner } from './components/marketing/CookieConsentBanner'
import { AppTopBannersProvider } from './context/AppTopBannersProvider'
import { AppTopBanners } from './components/layout/AppTopBanners'

const AppPricingPage = lazy(() =>
  import('./pages/pricing/AppPricingPage').then(m => ({ default: m.AppPricingPage })),
)
const AccountConfigPage = lazy(() =>
  import('./pages/dashboard/AccountConfigPage').then(m => ({ default: m.AccountConfigPage })),
)
const CopierEnginePage = lazy(() =>
  import('./pages/dashboard/CopierEnginePage').then(m => ({ default: m.CopierEnginePage })),
)
const CopierLogsPage = lazy(() =>
  import('./pages/dashboard/CopierLogsPage').then(m => ({ default: m.CopierLogsPage })),
)
const ManagementPage = lazy(() =>
  import('./pages/dashboard/ManagementPage').then(m => ({ default: m.ManagementPage })),
)
const Backtest = lazy(() =>
  import('./pages/dashboard/Backtest').then(m => ({ default: m.Backtest })),
)
const TradesPage = lazy(() =>
  import('./pages/dashboard/TradesPage').then(m => ({ default: m.TradesPage })),
)
const MarketNewsPage = lazy(() =>
  import('./pages/dashboard/MarketNewsPage').then(m => ({ default: m.MarketNewsPage })),
)
const EconomicCalendarPage = lazy(() =>
  import('./pages/dashboard/EconomicCalendarPage').then(m => ({ default: m.EconomicCalendarPage })),
)
const PerformancePage = lazy(() =>
  import('./pages/dashboard/PerformancePage').then(m => ({ default: m.PerformancePage })),
)
const PortfolioPage = lazy(() =>
  import('./pages/dashboard/PortfolioPage').then(m => ({ default: m.PortfolioPage })),
)
const AnalysisHubPage = lazy(() =>
  import('./pages/dashboard/AnalysisHubPage').then(m => ({ default: m.AnalysisHubPage })),
)
const SignalHistoryPage = lazy(() =>
  import('./pages/dashboard/SignalHistoryPage').then(m => ({ default: m.SignalHistoryPage })),
)
const SettingsPage = lazy(() =>
  import('./pages/dashboard/SettingsPage').then(m => ({ default: m.SettingsPage })),
)

// Support pages — same chunk, separate route entries
const AffiliateProgramPage = lazy(() =>
  import('./pages/dashboard/SupportMembershipPages').then(m => ({ default: m.AffiliateProgramPage })),
)
const BillingPage = lazy(() =>
  import('./pages/dashboard/SupportMembershipPages').then(m => ({ default: m.BillingPage })),
)
const ContactSupportPage = lazy(() =>
  import('./pages/dashboard/SupportMembershipPages').then(m => ({ default: m.ContactSupportPage })),
)
const FeatureRequestPage = lazy(() =>
  import('./pages/dashboard/SupportMembershipPages').then(m => ({ default: m.FeatureRequestPage })),
)
const PartnerWithUsPage = lazy(() =>
  import('./pages/dashboard/SupportMembershipPages').then(m => ({ default: m.PartnerWithUsPage })),
)

function LazyPage({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageLoader />}>{children}</Suspense>
}

function DashboardRouteAnchor() {
  return null
}

export default function App() {
  return (
    <AuthProvider>
      <LocaleProvider>
      <UserProfileProvider>
      <BrowserRouter>
      <AppTopBannersProvider>
      <SubscriptionProvider>
      <div className="flex h-[100dvh] min-h-0 flex-col overflow-hidden overscroll-none">
        <AppTopBanners />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden overscroll-none">
      <GoogleAnalyticsRouteTracker />
      <CookieConsentBanner />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />

          <Route path="/login" element={<AuthLayout />} />
          <Route path="/signup" element={<AuthLayout />} />
          <Route path="/forgot-password" element={<AuthLayout />} />
          <Route path="/reset-password" element={<AuthLayout />} />
          <Route path="/:referralCode" element={<ReferralCodeRedirect />} />

          <Route element={<VerifyEmailLayout />}>
            <Route path="/verify-email" element={<VerifyEmailPage />} />
            <Route path="/auth/confirmed" element={<AuthConfirmedPage />} />
          </Route>

          <Route
            element={
              <EmailVerificationGate />
            }
          >
          <Route
            element={
              <ProtectedRoute>
                <SubscriptionGuard>
                  <Outlet />
                </SubscriptionGuard>
              </ProtectedRoute>
            }
          >
            <Route path="/welcome" element={<Navigate to="/dashboard" replace />} />
            <Route element={<AppShell />}>
            <Route path="/pricing" element={<LazyPage><AppPricingPage /></LazyPage>} />
            <Route path="/dashboard/*" element={<DashboardRouteAnchor />} />
            <Route path="/brokers" element={<LazyPage><AccountConfigPage /></LazyPage>} />
            <Route path="/account-configuration" element={<Navigate to="/brokers" replace />} />
            <Route path="/account-trades" element={<LazyPage><TradesPage /></LazyPage>} />
            <Route path="/channels" element={<LazyPage><CopierEnginePage /></LazyPage>} />
            <Route path="/copier-engine" element={<Navigate to="/channels" replace />} />
            <Route path="/backtest" element={<LazyPage><Backtest /></LazyPage>} />
            <Route path="/copier-templates" element={<Navigate to="/backtest" replace />} />
            <Route path="/copier-logs" element={<LazyPage><CopierLogsPage /></LazyPage>} />
            <Route path="/activities" element={<LazyPage><ManagementPage /></LazyPage>} />
            <Route path="/management" element={<Navigate to="/activities" replace />} />
            <Route path="/manage-signals" element={<LazyPage><SignalHistoryPage /></LazyPage>} />
            <Route path="/signals" element={<Navigate to="/manage-signals" replace />} />
            <Route path="/updates" element={<Navigate to="/manage-signals" replace />} />
            <Route path="/signal-history" element={<Navigate to="/manage-signals" replace />} />
            <Route path="/market-news" element={<LazyPage><MarketNewsPage /></LazyPage>} />
            <Route path="/economic-calendar" element={<LazyPage><EconomicCalendarPage /></LazyPage>} />
            <Route path="/contact-support" element={<LazyPage><ContactSupportPage /></LazyPage>} />
            <Route path="/feature-request" element={<LazyPage><FeatureRequestPage /></LazyPage>} />
            <Route path="/partner-with-us" element={<LazyPage><PartnerWithUsPage /></LazyPage>} />
            <Route path="/affiliate-program" element={<LazyPage><AffiliateProgramPage /></LazyPage>} />
            <Route path="/billing" element={<LazyPage><BillingPage /></LazyPage>} />
            <Route path="/subscriptions" element={<Navigate to="/billing" replace />} />
            <Route path="/performance" element={<LazyPage><PerformancePage /></LazyPage>} />
            <Route path="/portfolio" element={<LazyPage><PortfolioPage /></LazyPage>} />
            <Route path="/analysis-hub" element={<LazyPage><AnalysisHubPage /></LazyPage>} />
            <Route path="/settings" element={<LazyPage><SettingsPage /></LazyPage>} />

            {/* Legacy redirects */}
            <Route path="/trades" element={<Navigate to="/account-trades" replace />} />
            <Route path="/onboarding" element={<Navigate to="/dashboard" replace />} />
            <Route path="/integrations" element={<Navigate to="/dashboard" replace />} />
            <Route path="/sentiments" element={<Navigate to="/market-news" replace />} />
            </Route>
          </Route>
          </Route>
        </Routes>
      </div>
        </div>
      </div>
      </SubscriptionProvider>
      </AppTopBannersProvider>
      </BrowserRouter>
      </UserProfileProvider>
      </LocaleProvider>
    </AuthProvider>
  )
}
