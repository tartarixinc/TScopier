import { BrokerAccountsProvider } from '../../context/BrokerAccountsContext'
import { NotificationsProvider } from '../../context/NotificationsContext'
import { AddTradingAccountProvider } from '../../context/AddTradingAccountContext'
import { AppLayout } from './AppLayout'

/** Authenticated app shell: shared broker state + dashboard layout. */
export function AppShell() {
  return (
    <div className="flex h-full min-h-0 flex-col">
    <BrokerAccountsProvider>
      <NotificationsProvider>
        <AddTradingAccountProvider>
          <AppLayout />
        </AddTradingAccountProvider>
      </NotificationsProvider>
    </BrokerAccountsProvider>
    </div>
  )
}
