import { lazy, Suspense } from 'react'
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
  const { needsWelcome, deferAppBootstrap } = useNeedsWelcome()

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
