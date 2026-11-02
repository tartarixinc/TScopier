import { useState } from 'react'
import { Megaphone, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAppAnnouncement } from '../../context/AppAnnouncementContext'
import { useT } from '../../context/LocaleContext'
import { appAnnouncementRevision, isExternalAnnouncementHref } from '../../lib/appAnnouncement'

const DISMISSED_ANNOUNCEMENT_KEY = 'tscopier:announcement:dismissed'

function readDismissedAnnouncement(): string | null {
  try {
    return localStorage.getItem(DISMISSED_ANNOUNCEMENT_KEY)
  } catch {
    return null
  }
}

const linkClassName =
  'font-semibold underline underline-offset-2 decoration-green-400/80 hover:text-teal-950 dark:hover:text-teal-50'

function AnnouncementLink({ href, label }: { href: string; label: string }) {
  if (isExternalAnnouncementHref(href)) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClassName}
      >
        {label}
      </a>
    )
  }

  return (
    <Link to={href} className={linkClassName}>
      {label}
    </Link>
  )
}

/** Teal announcement bar — message from `app_settings.announcement_message`. */
export function AppAnnouncementBar() {
  const { enabled, message, linkHref, linkLabel } = useAppAnnouncement()
  const t = useT()
  const revision = appAnnouncementRevision({ enabled, message, linkHref, linkLabel })
  const [dismissedRevision, setDismissedRevision] = useState<string | null>(readDismissedAnnouncement)

  if (!revision || !message) return null
  if (dismissedRevision === revision) return null

  const hide = () => {
    try {
      localStorage.setItem(DISMISSED_ANNOUNCEMENT_KEY, revision)
    } catch {
      /* the in-memory dismissal still hides it for this visit */
    }
    setDismissedRevision(revision)
  }

  return (
    <div
      role="status"
      className="relative flex shrink-0 items-center justify-center gap-2 border-b border-teal-200 bg-teal-50 px-10 py-2.5 text-center text-sm text-teal-900 dark:border-teal-900/60 dark:bg-teal-950/40 dark:text-teal-100 sm:px-12"
    >
      <Megaphone className="h-4 w-4 shrink-0 text-green-400 dark:text-green-400" aria-hidden />
      <p className="min-w-0 font-medium leading-snug">
        <span>{message}</span>
        {linkHref && linkLabel ? (
          <>
            {' '}
            <AnnouncementLink href={linkHref} label={linkLabel} />
          </>
        ) : null}
      </p>
      <button
        type="button"
        onClick={hide}
        aria-label={t.nav.updatesAnnouncement.dismiss}
        className="absolute inset-y-0 inset-e-1 my-auto flex h-7 w-7 items-center justify-center rounded-md text-teal-900 transition-colors hover:bg-teal-100 dark:text-teal-100 dark:hover:bg-teal-900/70"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  )
}
