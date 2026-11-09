import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import clsx from 'clsx'
import {
  Clock3,
  HelpCircle,
  Inbox,
  LayoutDashboard,
  MessageSquare,
  Search,
  Settings,
  Ticket,
  UserRound,
  Users,
} from 'lucide-react'
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { listInboxConversations } from '../lib/supportApi'
import { listAgentTickets } from '../lib/ticketsApi'
import { UserMenu } from './UserMenu'

type Counts = {
  queued: number
  mine: number
  all: number
  ticketsOpen: number
  ticketsMine: number
  ticketsAll: number
}

function SideLink({
  to,
  end,
  icon: Icon,
  label,
  count,
  active,
}: {
  to: string
  end?: boolean
  icon: typeof Inbox
  label: string
  count?: number
  active?: boolean
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition',
          active ?? isActive
            ? 'bg-neutral-200/80 text-neutral-900'
            : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900',
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {typeof count === 'number' ? (
        <span className="tabular-nums text-xs text-neutral-400">{count}</span>
      ) : null}
    </NavLink>
  )
}

function RailLink({
  to,
  icon: Icon,
  label,
  active,
}: {
  to: string
  icon: typeof Inbox
  label: string
  active?: boolean
}) {
  return (
    <NavLink
      to={to}
      title={label}
      aria-label={label}
      className={() =>
        clsx(
          'flex h-10 w-10 items-center justify-center rounded-xl transition',
          active
            ? 'bg-white text-neutral-900 shadow-sm'
            : 'text-neutral-500 hover:bg-white/70 hover:text-neutral-800',
        )
      }
    >
      <Icon className="h-5 w-5" />
    </NavLink>
  )
}

function FilterChip({
  to,
  label,
  count,
  active,
}: {
  to: string
  label: string
  count?: number
  active: boolean
}) {
  return (
    <NavLink
      to={to}
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition',
        active
          ? 'bg-neutral-900 text-white'
          : 'bg-white text-neutral-600 ring-1 ring-black/5 hover:bg-neutral-50',
      )}
    >
      {label}
      {typeof count === 'number' ? (
        <span className={clsx('tabular-nums', active ? 'text-white/70' : 'text-neutral-400')}>
          {count}
        </span>
      ) : null}
    </NavLink>
  )
}

function MobileTab({
  to,
  icon: Icon,
  label,
  active,
  count,
}: {
  to: string
  icon: typeof Inbox
  label: string
  active: boolean
  count?: number
}) {
  return (
    <NavLink
      to={to}
      className={clsx(
        'relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium transition',
        active ? 'text-neutral-900' : 'text-neutral-500',
      )}
    >
      <Icon className={clsx('h-5 w-5', active ? 'text-green-600' : 'text-neutral-400')} />
      <span>{label}</span>
      {typeof count === 'number' && count > 0 ? (
        <span className="absolute right-[calc(50%-1.75rem)] top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-green-500 px-1 text-[10px] font-semibold text-neutral-950">
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </NavLink>
  )
}

export function AppShell() {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [counts, setCounts] = useState<Counts>({
    queued: 0,
    mine: 0,
    all: 0,
    ticketsOpen: 0,
    ticketsMine: 0,
    ticketsAll: 0,
  })
  const [search, setSearch] = useState('')

  const chatFilter = searchParams.get('filter') || 'queued'
  const ticketFilter = searchParams.get('filter') || 'open'
  const onChats = location.pathname === '/'
  const onTickets = location.pathname.startsWith('/tickets')

  const refreshCounts = useCallback(async () => {
    if (!user?.id) return
    try {
      const [queued, mine, all, ticketsOpen, ticketsMine, ticketsAll] = await Promise.all([
        listInboxConversations('queued', user.id),
        listInboxConversations('mine', user.id),
        listInboxConversations('all', user.id),
        listAgentTickets('open', user.id),
        listAgentTickets('mine', user.id),
        listAgentTickets('all', user.id),
      ])
      setCounts({
        queued: queued.length,
        mine: mine.length,
        all: all.length,
        ticketsOpen: ticketsOpen.length,
        ticketsMine: ticketsMine.length,
        ticketsAll: ticketsAll.length,
      })
    } catch {
      /* non-blocking */
    }
  }, [user?.id])

  useEffect(() => {
    void refreshCounts()
    const id = window.setInterval(() => void refreshCounts(), 20000)
    return () => window.clearInterval(id)
  }, [refreshCounts])

  const servedLabel = useMemo(() => {
    const n = counts.mine + counts.ticketsMine
    return `${n} handled today`
  }, [counts.mine, counts.ticketsMine])

  const onSearchSubmit = (event: FormEvent) => {
    event.preventDefault()
    const q = search.trim().toLowerCase()
    if (!q) return
    if (q.includes('ticket')) navigate('/tickets?filter=open')
    else if (q.includes('queue') || q.includes('unassigned')) navigate('/?filter=queued')
    else if (q.includes('mine') || q.includes('my')) navigate('/?filter=mine')
    else navigate(`/?filter=all`)
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-[#F4F5F7] text-neutral-900">
      <header className="flex shrink-0 items-center gap-2 px-2 py-2 sm:gap-3 sm:px-4 sm:py-2.5">
        <img
          src="/uni-support-logo.png"
          alt="uni Support"
          className="h-7 w-auto shrink-0 rounded-md"
          draggable={false}
        />
        <div className="hidden items-center rounded-full bg-white px-3 py-1.5 text-xs font-medium text-neutral-600 shadow-xs ring-1 ring-black/5 md:inline-flex">
          <span className="me-1.5 h-1.5 w-1.5 rounded-full bg-green-400" />
          {servedLabel}
        </div>
        <form onSubmit={onSearchSubmit} className="mx-auto min-w-0 w-full max-w-xl flex-1">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-full rounded-full border-0 bg-white py-2 pl-10 pr-3 text-sm text-neutral-900 shadow-xs outline-none ring-1 ring-black/5 placeholder:text-neutral-400 focus:ring-2 focus:ring-green-400/30 sm:py-2.5 sm:pr-16"
            />
            <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 sm:inline">
              ⌘K
            </kbd>
          </label>
        </form>
        <UserMenu />
      </header>

      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-[calc(4.25rem+env(safe-area-inset-bottom))] md:px-3 md:pb-3">
        <aside className="hidden w-14 shrink-0 flex-col items-center gap-1 rounded-2xl bg-[#ECEEF2] py-3 md:flex">
          <RailLink to="/?filter=queued" icon={Inbox} label="Inbox" active={onChats} />
          <RailLink to="/tickets?filter=open" icon={Ticket} label="Tickets" active={onTickets} />
          <RailLink to="/?filter=all" icon={Users} label="All chats" active={onChats && chatFilter === 'all'} />
          <div className="my-2 h-px w-8 bg-neutral-300/80" />
          <button
            type="button"
            className="flex h-10 w-10 items-center justify-center rounded-xl text-neutral-500 hover:bg-white/70 hover:text-neutral-800"
            title="Settings"
            aria-label="Settings"
          >
            <Settings className="h-5 w-5" />
          </button>
          <button
            type="button"
            className="flex h-10 w-10 items-center justify-center rounded-xl text-neutral-500 hover:bg-white/70 hover:text-neutral-800"
            title="Help"
            aria-label="Help"
          >
            <HelpCircle className="h-5 w-5" />
          </button>
          <div className="mt-auto flex h-10 w-10 items-center justify-center rounded-xl bg-white text-green-500 shadow-xs">
            <LayoutDashboard className="h-5 w-5" />
          </div>
        </aside>

        <aside className="hidden w-56 shrink-0 flex-col rounded-2xl bg-[#ECEEF2] px-2.5 py-3 lg:flex">
          <div className="mb-3 flex items-center justify-between px-2">
            <p className="text-sm font-semibold text-neutral-900">Inbox</p>
          </div>

          <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            Chats
          </p>
          <div className="space-y-0.5">
            <SideLink
              to="/?filter=mine"
              icon={UserRound}
              label="My chats"
              count={counts.mine}
              active={onChats && chatFilter === 'mine'}
            />
            <SideLink
              to="/?filter=queued"
              icon={Clock3}
              label="Queued"
              count={counts.queued}
              active={onChats && chatFilter === 'queued'}
            />
            <SideLink
              to="/?filter=all"
              icon={MessageSquare}
              label="All"
              count={counts.all}
              active={onChats && chatFilter === 'all'}
            />
          </div>

          <p className="mb-1 mt-4 px-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            Tickets
          </p>
          <div className="space-y-0.5">
            <SideLink
              to="/tickets?filter=open"
              icon={Ticket}
              label="Open"
              count={counts.ticketsOpen}
              active={onTickets && ticketFilter === 'open'}
            />
            <SideLink
              to="/tickets?filter=mine"
              icon={UserRound}
              label="Mine"
              count={counts.ticketsMine}
              active={onTickets && ticketFilter === 'mine'}
            />
            <SideLink
              to="/tickets?filter=all"
              icon={Inbox}
              label="All tickets"
              count={counts.ticketsAll}
              active={onTickets && ticketFilter === 'all'}
            />
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-white shadow-xs ring-1 ring-black/5">
          <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-neutral-100 px-3 py-2.5 lg:hidden">
            {onChats ? (
              <>
                <FilterChip
                  to="/?filter=queued"
                  label="Queued"
                  count={counts.queued}
                  active={chatFilter === 'queued'}
                />
                <FilterChip
                  to="/?filter=mine"
                  label="My chats"
                  count={counts.mine}
                  active={chatFilter === 'mine'}
                />
                <FilterChip
                  to="/?filter=all"
                  label="All"
                  count={counts.all}
                  active={chatFilter === 'all'}
                />
              </>
            ) : (
              <>
                <FilterChip
                  to="/tickets?filter=open"
                  label="Open"
                  count={counts.ticketsOpen}
                  active={ticketFilter === 'open'}
                />
                <FilterChip
                  to="/tickets?filter=mine"
                  label="Mine"
                  count={counts.ticketsMine}
                  active={ticketFilter === 'mine'}
                />
                <FilterChip
                  to="/tickets?filter=all"
                  label="All"
                  count={counts.ticketsAll}
                  active={ticketFilter === 'all'}
                />
              </>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <Outlet context={{ refreshCounts }} />
          </div>
        </main>
      </div>

      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-neutral-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        aria-label="Primary"
      >
        <div className="flex">
          <MobileTab
            to="/?filter=queued"
            icon={Inbox}
            label="Inbox"
            active={onChats}
            count={counts.queued}
          />
          <MobileTab
            to="/tickets?filter=open"
            icon={Ticket}
            label="Tickets"
            active={onTickets}
            count={counts.ticketsOpen}
          />
        </div>
      </nav>
    </div>
  )
}
