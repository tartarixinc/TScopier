import { useT } from '../../context/LocaleContext'
import { LegalDocumentPage } from '../../components/marketing/LegalDocumentPage'

export function PrivacyPolicyPage() {
  const page = useT().privacyPolicyPage
  return <LegalDocumentPage page={page} />
}
