import { PlaceholderPage } from './PlaceholderPage'
import { useT } from '../../context/LocaleContext'

export function SentimentsPage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.sentiments.title} description={t.pages.sentiments.description} />
}
