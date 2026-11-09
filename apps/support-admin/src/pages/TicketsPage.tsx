import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Loader2, RefreshCw, Send, Ticket } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { fetchUserContext, type UserContext } from '../lib/supportApi'
import {
  claimTicket,
  getAgentTicket,
  listAgentTickets,
  replyToTicket,
  updateTicketStatus,
  type SupportTicket,
  type SupportTicketMessage,
  type SupportTicketStatus,
  type TicketFilter,
} from '../lib/ticketsApi'

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function parseTicketFilter(raw: string | null): TicketFilter {
  if (raw === 'mine' || raw === 'all' || raw === 'open') return raw
  return 'open'
}

export function TicketsPage() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const filter = parseTicketFilter(searchParams.get('filter'))
  const [tickets, setTickets] = useState<SupportTicket[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<SupportTicketMessage[]>([])
  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(null)
  const [userCtx, setUserCtx] = useState<UserContext | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadingList, setLoadingList] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)

  const refreshList = useCallback(async () => {
    if (!user?.id) return
    setLoadingList(true)
    setError('')
    try {
      const rows = await listAgentTickets(filter, user.id)
      setTickets(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tickets')
    } finally {
      setLoadingList(false)
    }
  }, [filter, user?.id])

  const loadThread = useCallback(async (ticketId: string, userId: string | null) => {
    try {
      const { ticket, messages: msgs } = await getAgentTicket(ticketId)
      setSelectedTicket(ticket)
      setMessages(msgs)
      if (userId) {
        setUserCtx(await fetchUserContext(userId))
      } else {
        setUserCtx(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ticket')
    }
  }, [])

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  useEffect(() => {
    if (!selectedId) {
      setMessages([])
      setSelectedTicket(null)
      setUserCtx(null)
      setDraft('')
      return
    }
    setDraft('')
    void loadThread(selectedId, tickets.find(t => t.id === selectedId)?.user_id ?? null)
  }, [selectedId, loadThread, tickets])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, selectedId])

  const selected = useMemo(
    () => selectedTicket ?? tickets.find(t => t.id === selectedId) ?? null,
    [selectedTicket, tickets, selectedId],
  )

  const onClaim = async () => {
    if (!selectedId) return
    setBusy(true)
    setError('')
    try {
      const ticket = await claimTicket(selectedId)
      setSelectedTicket(ticket)
      await refreshList()
      await loadThread(selectedId, ticket.user_id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Claim failed')
    } finally {
      setBusy(false)
    }
  }

  const onStatus = async (status: SupportTicketStatus) => {
    if (!selectedId) return
    setBusy(true)
    setError('')
    try {
      const ticket = await updateTicketStatus(selectedId, status)
      setSelectedTicket(ticket)
      await refreshList()
      await loadThread(selectedId, ticket.user_id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setBusy(false)
    }
  }

  const onReply = async () => {
    const text = draft.trim()
    if (!text || !selectedId || busy) return
    setBusy(true)
    setError('')
    const snapshot = text
    setDraft('')
    try {
      if (selected && !selected.assignee_id) {
        await claimTicket(selectedId)
      }
      const msg = await replyToTicket(selectedId, snapshot)
      setMessages(prev => (prev.some(m => m.id === msg.id) ? prev : [...prev, msg]))
      await refreshList()
      if (selectedId) {
        const { ticket, messages: msgs } = await getAgentTicket(selectedId)
        setSelectedTicket(ticket)
        setMessages(msgs)
      }
    } catch (err) {
      setDraft(snapshot)
      setError(err instanceof Error ? err.message : 'Reply failed')
    } finally {
      setBusy(false)
    }
  }

  const closed = selected?.status === 'resolved' || selected?.status === 'closed'

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error ? (
        <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600">{error}</div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[min(100%,20rem)] shrink-0 flex-col border-r border-neutral-100 bg-white">
          <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
            <div>
              <p className="text-sm font-semibold capitalize text-neutral-900">{filter} tickets</p>
              <p className="text-xs text-neutral-400">{tickets.length} tickets</p>
            </div>
            <button
              type="button"
              onClick={() => void refreshList()}
              className="rounded-full p-2 text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-800"
              aria-label="Refresh tickets"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {loadingList ? (
              <p className="px-2 py-4 text-sm text-neutral-500">Loading…</p>
            ) : tickets.length === 0 ? (
              <div className="mx-2 rounded-2xl bg-neutral-50 px-4 py-8 text-center">
                <Ticket className="mx-auto h-8 w-8 text-neutral-300" />
                <p className="mt-3 text-sm font-medium text-neutral-800">No tickets</p>
                <p className="mt-1 text-xs text-neutral-500">New email tickets will appear here.</p>
              </div>
            ) : (
              <ul className="space-y-1">
                {tickets.map(t => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(t.id)}
                      className={clsx(
                        'w-full rounded-xl px-3 py-3 text-left transition',
                        selectedId === t.id ? 'bg-neutral-100' : 'hover:bg-neutral-50',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-neutral-900">
                          #{t.number} · {t.subject}
                        </span>
                        <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium uppercase text-neutral-500 ring-1 ring-neutral-200">
                          {t.status}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-neutral-400">{formatWhen(t.last_message_at)}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-[#FAFBFC]">
          {!selected ? (
            <div className="grid flex-1 place-items-center px-6 text-center">
              <div>
                <Ticket className="mx-auto h-10 w-10 text-neutral-300" />
                <p className="mt-4 text-base font-semibold text-neutral-900">No ticket selected</p>
                <p className="mt-1 text-sm text-neutral-500">
                  Choose a ticket from the list to reply by email.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 border-b border-neutral-100 bg-white px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-neutral-900">
                    #{selected.number} — {selected.subject}
                  </p>
                  <p className="text-xs text-neutral-500">
                    Status: {selected.status}
                    {selected.assignee_id ? ` · assignee ${selected.assignee_id.slice(0, 8)}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {!selected.assignee_id && selected.status !== 'closed' ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onClaim()}
                      className="rounded-full bg-green-400 px-3.5 py-1.5 text-xs font-medium text-neutral-950 transition hover:bg-green-500 disabled:opacity-50"
                    >
                      Claim
                    </button>
                  ) : null}
                  {!closed ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onStatus('resolved')}
                      className="rounded-full bg-neutral-100 px-3.5 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-200 disabled:opacity-50"
                    >
                      Resolve
                    </button>
                  ) : null}
                  {selected.status !== 'closed' ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onStatus('closed')}
                      className="rounded-full bg-neutral-100 px-3.5 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-200 disabled:opacity-50"
                    >
                      Close
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
                {messages.map(m => (
                  <div
                    key={m.id}
                    className={clsx(
                      'max-w-[75%] rounded-2xl px-3 py-2 text-sm leading-relaxed',
                      m.sender_type === 'agent'
                        ? 'ml-auto bg-green-500 text-neutral-950'
                        : m.sender_type === 'user' || m.sender_type === 'email_inbound'
                          ? 'bg-white text-neutral-800 shadow-sm ring-1 ring-neutral-200'
                          : 'mx-auto max-w-full bg-transparent text-center text-xs text-neutral-500',
                    )}
                  >
                    {m.body}
                    {m.sender_type !== 'system' ? (
                      <span className="mt-1 block text-[10px] opacity-60">{formatWhen(m.created_at)}</span>
                    ) : null}
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>

              {!closed ? (
                <form
                  className="flex items-end gap-2 border-t border-neutral-200 bg-white p-3"
                  onSubmit={e => {
                    e.preventDefault()
                    void onReply()
                  }}
                >
                  <textarea
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    rows={2}
                    placeholder="Reply by email…"
                    className="min-h-[44px] flex-1 resize-none rounded-xl border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-green-400 focus:ring-2 focus:ring-green-400/20"
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        void onReply()
                      }
                    }}
                  />
                  <button
                    type="submit"
                    disabled={busy || !draft.trim()}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-green-500 text-neutral-950 disabled:opacity-40"
                    aria-label="Send reply"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </button>
                </form>
              ) : null}
            </>
          )}
        </section>

        <aside className="hidden w-64 shrink-0 border-l border-neutral-100 bg-white p-4 lg:block">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Requester</h2>
          {selected ? (
            <dl className="mt-3 space-y-3 text-sm">
              <div>
                <dt className="text-xs text-neutral-500">Guest name</dt>
                <dd className="text-neutral-900">{selected.guest_name?.trim() || '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-neutral-500">Guest email</dt>
                <dd className="break-all text-neutral-900">{selected.guest_email?.trim() || '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-neutral-500">User ID</dt>
                <dd className="break-all font-mono text-xs text-neutral-800">
                  {selected.user_id?.trim() || '—'}
                </dd>
              </div>
              {selected.user_id ? (
                <>
                  <div>
                    <dt className="text-xs text-neutral-500">Name</dt>
                    <dd className="text-neutral-900">
                      {userCtx?.display_name ||
                        [userCtx?.first_name, userCtx?.last_name].filter(Boolean).join(' ') ||
                        '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-neutral-500">Username</dt>
                    <dd className="text-neutral-900">{userCtx?.username || '—'}</dd>
                  </div>
                </>
              ) : null}
            </dl>
          ) : (
            <p className="mt-3 text-sm text-neutral-500">No ticket selected</p>
          )}
        </aside>
      </div>
    </div>
  )
}
