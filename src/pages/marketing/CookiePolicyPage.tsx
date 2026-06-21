import { useT } from '../../context/LocaleContext'
import { LegalDocumentPage } from '../../components/marketing/LegalDocumentPage'

export function CookiePolicyPage() {
  const page = useT().cookiePolicyPage
  return <LegalDocumentPage page={page} />
}
