import { PlaceholderPage } from './PlaceholderPage'
import { useT } from '../../context/LocaleContext'

export { ContactSupportPage } from './ContactSupportPage'

export function FeatureRequestPage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.featureRequest.title} description={t.pages.featureRequest.description} />
}

export function PartnerWithUsPage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.partnerWithUs.title} description={t.pages.partnerWithUs.description} />
}

export { AffiliateProgramPage } from './AffiliateProgramPage'

export { BillingPage } from './BillingPage'

export function SubscriptionsPage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.subscriptions.title} description={t.pages.subscriptions.description} />
}
