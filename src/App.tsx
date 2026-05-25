import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { LocaleProvider } from './context/LocaleContext'
import { UserProfileProvider } from './context/UserProfileContext'
import { SubscriptionProvider } from './context/SubscriptionContext'
import { AuthLayout } from './components/layout/AuthLayout'
import { AppShell } from './components/layout/AppShell'
import { ProtectedRoute } from './components/layout/ProtectedRoute'
import { SubscriptionGuard } from './components/layout/SubscriptionGuard'
import { PricingPage } from './pages/pricing/PricingPage'
import { DashboardPage } from './pages/dashboard/DashboardPage'
import { AccountConfigPage } from './pages/dashboard/AccountConfigPage'
import { CopierEnginePage } from './pages/dashboard/CopierEnginePage'
import { CopierLogsPage } from './pages/dashboard/CopierLogsPage'
import { Backtest } from './pages/dashboard/Backtest'
import { TradesPage } from './pages/dashboard/TradesPage'
import { MarketNewsPage } from './pages/dashboard/MarketNewsPage'
import { EconomicCalendarPage } from './pages/dashboard/EconomicCalendarPage'
import { PerformancePage } from './pages/dashboard/PerformancePage'
import {
  AffiliateProgramPage,
  BillingPage,
  ContactSupportPage,
  FeatureRequestPage,
  PartnerWithUsPage,
  SubscriptionsPage,
} from './pages/dashboard/SupportMembershipPages'
import { PortfolioPage } from './pages/dashboard/PortfolioPage'
import { AnalysisHubPage } from './pages/dashboard/AnalysisHubPage'
import { SignalHistoryPage } from './pages/dashboard/SignalHistoryPage'
import { SettingsPage } from './pages/dashboard/SettingsPage'

export default function App() {
  return (
    <AuthProvider>
      <LocaleProvider>
      <UserProfileProvider>
      <SubscriptionProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />

          <Route path="/login" element={<AuthLayout />} />
          <Route path="/signup" element={<AuthLayout />} />
          <Route path="/verify-email" element={<AuthLayout />} />
          <Route path="/forgot-password" element={<AuthLayout />} />
          <Route path="/reset-password" element={<AuthLayout />} />

          {/* Pricing wall - requires auth but not subscription */}
          <Route
            path="/pricing"
            element={
              <ProtectedRoute>
                <PricingPage />
              </ProtectedRoute>
            }
          />

          <Route
            element={
              <ProtectedRoute>
                <SubscriptionGuard>
                  <AppShell />
                </SubscriptionGuard>
              </ProtectedRoute>
            }
          >
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/account-configuration" element={<AccountConfigPage />} />
            <Route path="/account-trades" element={<TradesPage />} />
            <Route path="/channels" element={<CopierEnginePage />} />
            <Route path="/copier-engine" element={<Navigate to="/channels" replace />} />
            <Route path="/backtest" element={<Backtest />} />
            <Route path="/copier-templates" element={<Navigate to="/backtest" replace />} />
            <Route path="/copier-logs" element={<CopierLogsPage />} />
            <Route path="/signal-history" element={<SignalHistoryPage />} />
            <Route path="/market-news" element={<MarketNewsPage />} />
            <Route path="/economic-calendar" element={<EconomicCalendarPage />} />
            <Route path="/contact-support" element={<ContactSupportPage />} />
            <Route path="/feature-request" element={<FeatureRequestPage />} />
            <Route path="/partner-with-us" element={<PartnerWithUsPage />} />
            <Route path="/affiliate-program" element={<AffiliateProgramPage />} />
            <Route path="/billing" element={<BillingPage />} />
            <Route path="/subscriptions" element={<SubscriptionsPage />} />
            <Route path="/performance" element={<PerformancePage />} />
            <Route path="/portfolio" element={<PortfolioPage />} />
            <Route path="/analysis-hub" element={<AnalysisHubPage />} />
            <Route path="/settings" element={<SettingsPage />} />

            {/* Legacy redirects */}
            <Route path="/trades" element={<Navigate to="/account-trades" replace />} />
            <Route path="/onboarding" element={<Navigate to="/dashboard" replace />} />
            <Route path="/integrations" element={<Navigate to="/dashboard" replace />} />
            <Route path="/sentiments" element={<Navigate to="/market-news" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      </SubscriptionProvider>
      </UserProfileProvider>
      </LocaleProvider>
    </AuthProvider>
  )
}
