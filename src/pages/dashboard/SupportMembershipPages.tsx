import { PlaceholderPage } from './PlaceholderPage'
import { useT } from '../../context/LocaleContext'

export function ContactSupportPage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.contactSupport.title} description={t.pages.contactSupport.description} />
}

export function FeatureRequestPage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.featureRequest.title} description={t.pages.featureRequest.description} />
}

export function PartnerWithUsPage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.partnerWithUs.title} description={t.pages.partnerWithUs.description} />
}

export function AffiliateProgramPage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.affiliateProgram.title} description={t.pages.affiliateProgram.description} />
}

export function BillingPage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.billing.title} description={t.pages.billing.description} />
}

export function SubscriptionsPage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.subscriptions.title} description={t.pages.subscriptions.description} />
}
