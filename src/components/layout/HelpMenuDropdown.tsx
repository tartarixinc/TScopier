import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BookOpen,
  MessageCircle,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react'
import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import { HELP_LINKS, isExternalHelpUrl } from '../../lib/helpLinks'

interface HelpMenuDropdownProps {
  open: boolean
  onClose: () => void
}

type HelpItem = {
  id: string
  label: string
  icon?: LucideIcon
  iconSrc?: string
  href?: string
  internalPath?: string
}

function HelpMenuIcon({ icon: Icon, iconSrc }: { icon?: LucideIcon; iconSrc?: string }) {
  if (iconSrc) {
    return (
      <img
        src={iconSrc}
        alt=""
        className="h-4 w-4 object-contain"
        width={16}
        height={16}
        aria-hidden
      />
    )
  }
  if (Icon) return <Icon className="h-4 w-4" />
  return null
}

export function HelpMenuDropdown({ open, onClose }: HelpMenuDropdownProps) {
  const t = useT()
  const hm = t.nav.helpMenu
  const navigate = useNavigate()
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const items: HelpItem[] = [
    {
      id: 'documentation',
      label: hm.documentation,
      icon: BookOpen,
      href: HELP_LINKS.documentation,
    },
    HELP_LINKS.liveChat && isExternalHelpUrl(HELP_LINKS.liveChat)
      ? {
          id: 'liveChat',
          label: hm.liveChat,
          icon: MessageCircle,
          href: HELP_LINKS.liveChat,
        }
      : {
          id: 'liveChatInternal',
          label: hm.liveChat,
          icon: MessageCircle,
          internalPath: '/contact-support',
        },
    {
      id: 'whatsapp',
      label: hm.whatsapp,
      iconSrc: '/WhatsApp-icon.svg',
      href: HELP_LINKS.whatsapp || undefined,
      internalPath: HELP_LINKS.whatsapp ? undefined : '/contact-support',
    },
    {
      id: 'telegram',
      label: hm.telegram,
      iconSrc: '/Telegram.svg',
      href: HELP_LINKS.telegram || undefined,
      internalPath: HELP_LINKS.telegram ? undefined : '/contact-support',
    },
  ]

  const handleSelect = (item: HelpItem) => {
    if (item.href && isExternalHelpUrl(item.href)) {
      window.open(item.href, '_blank', 'noopener,noreferrer')
      onClose()
      return
    }
    if (item.internalPath) {
      navigate(item.internalPath)
      onClose()
    }
  }

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label={t.nav.help}
      className={clsx(
        'absolute right-0 top-full z-50 mt-1 w-56 rounded-xl border border-neutral-200 bg-white py-1 shadow-lg',
        'before:absolute before:-top-1 before:right-0 before:left-0 before:h-1 before:content-[""]',
        'dark:border-neutral-700 dark:bg-neutral-900',
      )}
    >
      <ul>
        {items.map(item => {
          return (
            <li key={item.id} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => handleSelect(item)}
                className={clsx(
                  'flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm font-medium transition-colors',
                  'text-neutral-800 hover:bg-neutral-50 dark:text-neutral-100 dark:hover:bg-neutral-800/80',
                )}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
                  <HelpMenuIcon icon={item.icon} iconSrc={item.iconSrc} />
                </span>
                <span className="min-w-0 flex-1">{item.label}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
              </button>
            </li>
          )
        })}
      </ul>

      <div
        className="border-t border-neutral-100 px-3 py-3 dark:border-neutral-800"
        role="presentation"
      >
        <div className="flex items-start gap-2.5">
          <span className="relative mt-1 flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-neutral-900 dark:text-neutral-50">{hm.status}</p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{hm.statusOperational}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
