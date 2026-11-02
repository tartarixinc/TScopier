import { useEffect, useState } from 'react'
import { useLocale } from '../context/LocaleContext'
import {
  fetchLandingAnnouncementRow,
  normalizeLandingAnnouncementRow,
  type LandingAnnouncement,
} from '../lib/landingAnnouncement'

type Row = Awaited<ReturnType<typeof fetchLandingAnnouncementRow>>

// One fetch per page load, shared by every consumer.
let pending: Promise<Row> | null = null

/** The live landing announcement for the visitor's language, or null (also while loading). */
export function useLandingAnnouncement(): LandingAnnouncement | null {
  const { locale } = useLocale()
  const [row, setRow] = useState<Row>(null)

  useEffect(() => {
    let cancelled = false
    pending ??= fetchLandingAnnouncementRow()
    void pending.then(result => {
      if (!cancelled) setRow(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return normalizeLandingAnnouncementRow(row, locale)
}
