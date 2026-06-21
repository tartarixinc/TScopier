import { useT } from '../../context/LocaleContext'
import { LegalDocumentPage } from '../../components/marketing/LegalDocumentPage'

export function TermsOfServicePage() {
  const page = useT().termsOfServicePage
  return <LegalDocumentPage page={page} />
}
