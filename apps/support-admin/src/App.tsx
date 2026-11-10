import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { SupportGuard } from './components/SupportGuard'
import { AppShell } from './components/AppShell'
import { InboxPage } from './pages/InboxPage'
import { LoginPage } from './pages/LoginPage'
import { TicketsPage } from './pages/TicketsPage'

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={(
              <SupportGuard>
                <AppShell />
              </SupportGuard>
            )}
          >
            <Route path="/" element={<InboxPage />} />
            <Route path="/tickets" element={<TicketsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
