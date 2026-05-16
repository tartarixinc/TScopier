import { PlaceholderPage } from './PlaceholderPage'
import { useT } from '../../context/LocaleContext'

export function EconomicCalendarPage() {
  const t = useT()
  return (
    <PlaceholderPage title={t.pages.economicCalendar.title} description={t.pages.economicCalendar.description} />
  )
}
