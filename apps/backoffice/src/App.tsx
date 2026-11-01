import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { AdminGuard } from './components/AdminGuard'
import { AppShell } from './components/AppShell'
import { OverviewPage } from './pages/OverviewPage'
import { UsersPage } from './pages/UsersPage'
import { UserDetailPage } from './pages/UserDetailPage'
import { TradesAdminPage } from './pages/TradesAdminPage'
import { ChannelsBacktestsPage } from './pages/ChannelsBacktestsPage'
import { CopierLogsPage } from './pages/CopierLogsPage'
import { LoginPage } from './pages/LoginPage'
import { AffiliatePayoutsPage } from './pages/AffiliatePayoutsPage'
import { ProviderApplicationsPage } from './pages/ProviderApplicationsPage'

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={(
              <AdminGuard>
                <AppShell />
              </AdminGuard>
            )}
          >
            <Route path="/" element={<OverviewPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/users/:userId" element={<UserDetailPage />} />
            <Route path="/trades" element={<TradesAdminPage />} />
            <Route path="/channels-backtests" element={<ChannelsBacktestsPage />} />
            <Route path="/copier-logs" element={<CopierLogsPage />} />
            <Route path="/affiliate-payouts" element={<AffiliatePayoutsPage />} />
            <Route path="/provider-applications" element={<ProviderApplicationsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
