import { BrokerAccountsProvider } from '../../context/BrokerAccountsContext'
import { AppLayout } from './AppLayout'

/** Authenticated app shell: shared broker state + dashboard layout. */
export function AppShell() {
  return (
    <BrokerAccountsProvider>
      <AppLayout />
    </BrokerAccountsProvider>
  )
}
