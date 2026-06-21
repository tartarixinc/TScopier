import { lazy, Suspense, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { BrokerAccountsProvider } from '../../context/BrokerAccountsContext'
import { NotificationsProvider } from '../../context/NotificationsContext'
import { AddTradingAccountProvider } from '../../context/AddTradingAccountContext'
import { PendingBrokerConnectionSync } from '../broker/PendingBrokerConnectionSync'
import { AppLayout } from './AppLayout'
import { useNeedsWelcome } from '../../hooks/useNeedsWelcome'

const WelcomeModal = lazy(() =>
  import('../onboarding/WelcomeModal').then(m => ({ default: m.WelcomeModal })),
)

/** Authenticated app shell: shared broker state + dashboard layout. */
export function AppShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const { needsWelcome, deferAppBootstrap } = useNeedsWelcome()
  const onDashboardRoute = location.pathname === '/dashboard'
    || location.pathname.startsWith('/dashboard/broker/')

  useEffect(() => {
    if (needsWelcome && !onDashboardRoute) {
      navigate('/dashboard', { replace: true })
    }
  }, [needsWelcome, onDashboardRoute, navigate])

  return (
    <BrokerAccountsProvider enabled={!deferAppBootstrap}>
      {!deferAppBootstrap ? <PendingBrokerConnectionSync /> : null}
      <NotificationsProvider enabled={!deferAppBootstrap}>
        <AddTradingAccountProvider>
          <AppLayout />
          {needsWelcome ? (
            <Suspense fallback={null}>
              <WelcomeModal />
            </Suspense>
          ) : null}
        </AddTradingAccountProvider>
      </NotificationsProvider>
    </BrokerAccountsProvider>
  )
}
