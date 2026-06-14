import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  Search,
  X,
  LayoutDashboard,
  Settings,
  History,
  Send,
  LayoutTemplate,
  ScrollText,
  Newspaper,
  Calendar,
  ChartBar as BarChart2,
  ChartNoAxesColumn,
  Landmark,
  LifeBuoy,
  Lightbulb,
  Handshake,
  Share2,
  CreditCard,
  Repeat,
  Server,
  Radio,
} from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import {
  buildAppSearchPages,
  filterSearchResults,
  groupSearchResults,
  type AppSearchResult,
  type AppSearchResultKind,
} from '../../lib/appSearch'

const PAGE_ICONS: Record<string, typeof LayoutDashboard> = {
  '/dashboard': LayoutDashboard,
  '/brokers': Landmark,
  '/account-trades': History,
  '/settings': Settings,
  '/channels': Send,
  '/backtest': LayoutTemplate,
  '/copier-logs': ScrollText,
  '/updates': ChartNoAxesColumn,
  '/performance': BarChart2,
  '/market-news': Newspaper,
  '/economic-calendar': Calendar,
  '/contact-support': LifeBuoy,
  '/feature-request': Lightbulb,
  '/partner-with-us': Handshake,
  '/affiliate-program': Share2,
  '/billing': CreditCard,
  '/subscriptions': Repeat,
}

const KIND_ICONS: Record<AppSearchResultKind, typeof LayoutDashboard> = {
  page: LayoutDashboard,
  broker: Server,
  channel: Radio,
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform)
}

type AppSearchController = ReturnType<typeof useAppSearchController>

const AppSearchContext = createContext<AppSearchController | null>(null)

function useIsMobileViewport() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)')
    const update = () => setIsMobile(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return isMobile
}

function useAppSearchController(headerEl: HTMLElement | null) {
  const t = useT()
  const gs = t.globalSearch
  const { user } = useAuth()
  const navigate = useNavigate()
  const desktopRef = useRef<HTMLDivElement>(null)
  const mobileOverlayRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [mobileExpanded, setMobileExpanded] = useState(false)
  const isMobile = useIsMobileViewport()
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    if (!isMobile) setMobileExpanded(false)
  }, [isMobile])
  const [brokers, setBrokers] = useState<{ id: string; label: string; server: string }[]>([])
  const [channels, setChannels] = useState<{ id: string; name: string; username: string }[]>([])

  const shortcutLabel = useMemo(() => (isMacPlatform() ? '⌘K' : 'Ctrl+K'), [])

  const containsSearchUi = useCallback((node: Node | null) => {
    if (!node) return false
    return (
      desktopRef.current?.contains(node) ||
      mobileOverlayRef.current?.contains(node) ||
      false
    )
  }, [])

  const collapseMobile = useCallback(() => {
    setMobileExpanded(false)
    setOpen(false)
    inputRef.current?.blur()
  }, [])

  const expandMobile = useCallback(() => {
    setMobileExpanded(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    void (async () => {
      const [brokerRes, channelRes] = await Promise.all([
        supabase
          .from('broker_accounts')
          .select('id,label,broker_server,broker_name')
          .eq('user_id', user.id)
          .order('label'),
        supabase
          .from('telegram_channels')
          .select('id,display_name,channel_username')
          .eq('user_id', user.id)
          .order('display_name'),
      ])
      if (cancelled) return
      setBrokers(
        (brokerRes.data ?? []).map(row => ({
          id: row.id,
          label: row.label || row.broker_name || 'Account',
          server: row.broker_server ?? '',
        })),
      )
      setChannels(
        (channelRes.data ?? []).map(row => ({
          id: row.id,
          name: row.display_name,
          username: row.channel_username ?? '',
        })),
      )
    })()
    return () => {
      cancelled = true
    }
  }, [user?.id])

  const allResults = useMemo((): AppSearchResult[] => {
    const pages = buildAppSearchPages(t).map(
      (page): AppSearchResult => ({
        id: `page:${page.path}`,
        kind: 'page',
        title: page.title,
        subtitle: page.subtitle,
        path: page.path,
        sectionLabel: page.sectionLabel,
        keywords: [page.path, page.sectionLabel, ...(page.keywords ?? [])],
      }),
    )
    const brokerItems: AppSearchResult[] = brokers.map(b => ({
      id: `broker:${b.id}`,
      kind: 'broker',
      title: b.label,
      subtitle: b.server || undefined,
      path: '/brokers',
      sectionLabel: t.globalSearch.groupBrokers,
      keywords: [b.server, b.id, 'broker', 'account'],
    }))
    const channelItems: AppSearchResult[] = channels.map(c => ({
      id: `channel:${c.id}`,
      kind: 'channel',
      title: c.name,
      subtitle: c.username ? `@${c.username.replace(/^@/, '')}` : undefined,
      path: '/channels',
      sectionLabel: t.globalSearch.groupChannels,
      keywords: [c.username, c.id, 'telegram', 'channel'],
    }))
    return [...pages, ...brokerItems, ...channelItems]
  }, [t, brokers, channels])

  const hasQuery = query.trim().length > 0

  const flatResults = useMemo(() => {
    if (!hasQuery) return []
    return filterSearchResults(allResults, query, 14)
  }, [allResults, query, hasQuery])

  const showSuggestions = open && hasQuery

  const grouped = useMemo(
    () =>
      groupSearchResults(flatResults, {
        pages: gs.groupPages,
        brokers: gs.groupBrokers,
        channels: gs.groupChannels,
      }),
    [flatResults, gs],
  )

  useEffect(() => {
    setActiveIndex(0)
  }, [query, open])

  useEffect(() => {
    if (!open && !mobileExpanded) return
    const onDoc = (e: MouseEvent) => {
      if (!containsSearchUi(e.target as Node)) {
        setOpen(false)
        if (isMobile) setMobileExpanded(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, mobileExpanded, isMobile, containsSearchUi])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (isMobile) expandMobile()
        else inputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isMobile, expandMobile])

  const selectResult = useCallback(
    (item: AppSearchResult) => {
      navigate(item.path)
      setQuery('')
      setOpen(false)
      if (isMobile) setMobileExpanded(false)
      inputRef.current?.blur()
    },
    [navigate, isMobile],
  )

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false)
      setQuery('')
      if (isMobile) collapseMobile()
      else inputRef.current?.blur()
      return
    }
    if (!flatResults.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => (i + 1) % flatResults.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => (i - 1 + flatResults.length) % flatResults.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flatResults[activeIndex]
      if (item) selectResult(item)
    }
  }

  const onInputBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    if (!isMobile || !mobileExpanded) return
    const related = e.relatedTarget as Node | null
    if (related && containsSearchUi(related)) return
    window.setTimeout(() => {
      if (!containsSearchUi(document.activeElement)) {
        collapseMobile()
      }
    }, 120)
  }

  useEffect(() => {
    if (!showSuggestions || !listRef.current) return
    const active = listRef.current.querySelector('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, showSuggestions])

  const inputClassName =
    'w-full rounded-lg border border-neutral-200 bg-neutral-50 py-2 pl-9 pr-3 text-base md:text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 lg:pr-14'

  const renderInput = (opts: { showShortcut: boolean }) => (
    <>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
      <input
        ref={inputRef}
        type="search"
        value={query}
        role="combobox"
        aria-expanded={showSuggestions}
        aria-controls="app-search-listbox"
        aria-autocomplete="list"
        placeholder={gs.placeholder}
        onChange={e => {
          const next = e.target.value
          setQuery(next)
          setOpen(next.trim().length > 0)
        }}
        onFocus={() => {
          if (isMobile) setMobileExpanded(true)
          if (query.trim().length > 0) setOpen(true)
        }}
        onBlur={onInputBlur}
        onKeyDown={onInputKeyDown}
        className={inputClassName}
      />
      {opts.showShortcut ? (
        <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-neutral-400 lg:inline dark:border-neutral-600 dark:bg-neutral-900">
          {shortcutLabel}
        </kbd>
      ) : null}
    </>
  )

  const renderSuggestions = (anchor: 'desktop' | 'mobile') => {
    if (!showSuggestions) return null
    const positionClass =
      anchor === 'mobile'
        ? 'fixed left-3 right-3 top-[calc(env(safe-area-inset-top)+3.5rem)] z-[60] sm:top-16'
        : 'absolute left-0 right-0 top-[calc(100%+6px)] z-50'

    return (
      <div
        id="app-search-listbox"
        ref={listRef}
        role="listbox"
        className={clsx(
          positionClass,
          'max-h-[min(22rem,70vh)] overflow-y-auto rounded-xl border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900',
        )}
      >
        {flatResults.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">{gs.noResults}</p>
        ) : (
          (() => {
            let flatIdx = -1
            return grouped.map(group => (
              <div key={group.kind}>
                <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                  {group.label}
                </p>
                {group.items.map(item => {
                  flatIdx += 1
                  const idx = flatIdx
                  const isActive = idx === activeIndex
                  const Icon =
                    item.kind === 'page'
                      ? PAGE_ICONS[item.path] ?? KIND_ICONS.page
                      : KIND_ICONS[item.kind]
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      data-active={isActive ? 'true' : undefined}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => selectResult(item)}
                      className={clsx(
                        'flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors',
                        isActive
                          ? 'bg-teal-50 text-teal-900 dark:bg-teal-950/50 dark:text-teal-100'
                          : 'text-neutral-800 hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-800/80',
                      )}
                    >
                      <span
                        className={clsx(
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                          isActive
                            ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/60 dark:text-teal-300'
                            : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{item.title}</span>
                        {(item.subtitle || item.sectionLabel) && (
                          <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">
                            {item.subtitle ?? item.sectionLabel}
                          </span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))
          })()
        )}
      </div>
    )
  }

  const mobileTriggerButton = (
    <button
      type="button"
      onClick={expandMobile}
      aria-label={t.nav.search}
      aria-expanded={mobileExpanded}
      className={clsx(
        'shrink-0 rounded-lg p-2 transition-colors lg:hidden',
        mobileExpanded
          ? 'text-teal-600 bg-teal-50 dark:text-teal-400 dark:bg-teal-950/50'
          : 'text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800',
      )}
    >
      <Search className="h-5 w-5" />
    </button>
  )

  const mobileOverlay =
    headerEl &&
    isMobile &&
    createPortal(
      <div
        ref={mobileOverlayRef}
        className={clsx(
          'absolute inset-y-0 z-50 flex items-center gap-2 border-neutral-100 bg-white px-2 transition-[left,opacity] duration-200 ease-out dark:border-neutral-800 dark:bg-neutral-900',
          mobileExpanded
            ? 'left-12 right-0 border-b opacity-100'
            : 'pointer-events-none left-full right-0 opacity-0',
        )}
        aria-hidden={!mobileExpanded}
      >
        <div className="relative min-w-0 flex-1">
          {renderInput({ showShortcut: false })}
        </div>
        <button
          type="button"
          onClick={collapseMobile}
          aria-label={t.nav.closeMenu}
          className="shrink-0 rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <X className="h-5 w-5" />
        </button>
        {mobileExpanded ? renderSuggestions('mobile') : null}
      </div>,
      headerEl,
    )

  const renderDesktop = (className?: string) => (
    <div ref={desktopRef} className={clsx('relative hidden min-w-0 lg:block', className)}>
      {renderInput({ showShortcut: true })}
      {renderSuggestions('desktop')}
    </div>
  )

  return {
    mobileTriggerButton,
    mobileOverlay,
    renderDesktop,
  }
}

export function AppSearchProvider({
  headerEl,
  children,
}: {
  headerEl: HTMLElement | null
  children: ReactNode
}) {
  const controller = useAppSearchController(headerEl)
  return (
    <AppSearchContext.Provider value={controller}>
      {children}
      {controller.mobileOverlay}
    </AppSearchContext.Provider>
  )
}

export function AppSearchDesktop({ className }: { className?: string }) {
  const ctx = useContext(AppSearchContext)
  if (!ctx) return null
  return ctx.renderDesktop(className)
}

export function AppSearchMobileTrigger() {
  const ctx = useContext(AppSearchContext)
  if (!ctx) return null
  return ctx.mobileTriggerButton
}
