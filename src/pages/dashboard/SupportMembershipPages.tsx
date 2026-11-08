import { PlaceholderPage } from './PlaceholderPage'
import { useT } from '../../context/LocaleContext'

export { ContactSupportPage } from './ContactSupportPage'

export function FeatureRequestPage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.featureRequest.title} />
}

export function PartnerWithUsPage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.partnerWithUs.title} />
}

export { AffiliateProgramPage } from './AffiliateProgramPage'
export { WalletPage } from './WalletPage'

export { BillingPage } from './BillingPage'

export function SubscriptionsPage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.subscriptions.title} />
}
