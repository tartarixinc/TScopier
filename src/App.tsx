import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { LocaleProvider } from './context/LocaleContext'
import { AuthLayout } from './components/layout/AuthLayout'
import { AppLayout } from './components/layout/AppLayout'
import { ProtectedRoute } from './components/layout/ProtectedRoute'
import { LoginPage } from './pages/auth/LoginPage'
import { SignupPage } from './pages/auth/SignupPage'
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

export default function App() {
  return (
    <AuthProvider>
      <LocaleProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />

          <Route element={<AuthLayout />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
          </Route>

          <Route
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/account-configuration" element={<AccountConfigPage />} />
            <Route path="/account-trades" element={<TradesPage />} />
            <Route path="/copier-engine" element={<CopierEnginePage />} />
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

            {/* Legacy redirects */}
            <Route path="/channels" element={<Navigate to="/copier-engine" replace />} />
            <Route path="/trades" element={<Navigate to="/account-trades" replace />} />
            <Route path="/settings" element={<Navigate to="/account-configuration" replace />} />
            <Route path="/onboarding" element={<Navigate to="/dashboard" replace />} />
            <Route path="/integrations" element={<Navigate to="/dashboard" replace />} />
            <Route path="/sentiments" element={<Navigate to="/market-news" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      </LocaleProvider>
    </AuthProvider>
  )
}
