import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, ChevronDown, ImagePlus, Loader2, MessageSquare, RefreshCw, Send, X } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import {
  claimConversation,
  fetchUserContext,
  listInboxConversations,
  listMessages,
  replyAsAgent,
  resolveConversation,
  type InboxFilter,
  type SupportConversation,
  type SupportMessage,
  type UserContext,
} from '../lib/supportApi'
import {
  fileToSupportImageDataUrl,
  isSupportImageType,
  SUPPORT_MAX_IMAGES,
  uploadAgentSupportImages,
} from '../lib/supportImages'

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

function parseInboxFilter(raw: string | null): InboxFilter {
  if (raw === 'mine' || raw === 'all' || raw === 'queued') return raw
  return 'queued'
}

export function InboxPage() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const filter = parseInboxFilter(searchParams.get('filter'))
  const [conversations, setConversations] = useState<SupportConversation[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<SupportMessage[]>([])
  const [userCtx, setUserCtx] = useState<UserContext | null>(null)
  const [draft, setDraft] = useState('')
  const [draftImages, setDraftImages] = useState<string[]>([])
  const [attaching, setAttaching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadingList, setLoadingList] = useState(true)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const selected = useMemo(
    () => conversations.find(c => c.id === selectedId) ?? null,
    [conversations, selectedId],
  )

  const refreshList = useCallback(async () => {
    if (!user?.id) return
    setLoadingList(true)
    setError('')
    try {
      const rows = await listInboxConversations(filter, user.id)
      setConversations(rows)
      if (selectedId && !rows.some(r => r.id === selectedId)) {
        // Keep selection if still present after filter change only when missing
        if (filter !== 'all') {
          /* leave selected so thread can still show */
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load inbox')
    } finally {
      setLoadingList(false)
    }
  }, [filter, user?.id, selectedId])

  const loadThread = useCallback(async (conversationId: string, userId: string | null) => {
    try {
      const msgs = await listMessages(conversationId)
      setMessages(msgs)
      if (userId) {
        setUserCtx(await fetchUserContext(userId))
      } else {
        setUserCtx(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load thread')
    }
  }, [])

  useEffect(() => {
    setSelectedId(null)
  }, [filter])

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  useEffect(() => {
    if (!selected) {
      setMessages([])
      setUserCtx(null)
      setDraft('')
      setDraftImages([])
      return
    }
    setDraft('')
    setDraftImages([])
    setDetailsOpen(false)
    void loadThread(selected.id, selected.user_id ?? null)
  }, [selected, loadThread])

  useEffect(() => {
    if (!user?.id) return
    const channel = supabase
      .channel('support-admin-inbox')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'support_conversations' },
        () => {
          void refreshList()
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'support_messages' },
        payload => {
          const row = payload.new as SupportMessage
          if (selectedId && row.conversation_id === selectedId) {
            setMessages(prev => (prev.some(m => m.id === row.id) ? prev : [...prev, row]))
          }
          void refreshList()
        },
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [user?.id, selectedId, refreshList])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, selectedId])

  const onClaim = async () => {
    if (!selectedId) return
    setBusy(true)
    setError('')
    try {
      await claimConversation(selectedId)
      await refreshList()
      if (selected) await loadThread(selected.id, selected.user_id ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Claim failed')
    } finally {
      setBusy(false)
    }
  }

  const onResolve = async () => {
    if (!selectedId) return
    setBusy(true)
    setError('')
    try {
      await resolveConversation(selectedId)
      await refreshList()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resolve failed')
    } finally {
      setBusy(false)
    }
  }

  const addImageFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter(f => isSupportImageType(f.type))
    if (!list.length) {
      setError('Use a JPEG, PNG, WebP, or GIF image.')
      return
    }
    const room = SUPPORT_MAX_IMAGES - draftImages.length
    if (room <= 0) {
      setError(`You can attach up to ${SUPPORT_MAX_IMAGES} images.`)
      return
    }
    setError('')
    setAttaching(true)
    try {
      const next: string[] = []
      for (const file of list.slice(0, room)) {
        try {
          next.push(await fileToSupportImageDataUrl(file))
        } catch (err) {
          const code = err instanceof Error ? err.message : ''
          setError(code === 'too_large' ? 'Image is too large.' : 'Could not attach that image.')
        }
      }
      if (next.length) setDraftImages(prev => [...prev, ...next].slice(0, SUPPORT_MAX_IMAGES))
    } finally {
      setAttaching(false)
    }
  }

  const onReply = async () => {
    const text = draft.trim()
    if ((!text && draftImages.length === 0) || !selectedId || !user?.id || attaching) return
    setBusy(true)
    setError('')
    const imagesSnapshot = draftImages
    setDraft('')
    setDraftImages([])
    try {
      if (selected?.status === 'queued' || (selected && selected.assignee_id !== user.id)) {
        await claimConversation(selectedId)
      }
      const uploaded =
        imagesSnapshot.length > 0
          ? await uploadAgentSupportImages({
              agentUserId: user.id,
              conversationId: selectedId,
              dataUrls: imagesSnapshot,
            })
          : []
      const msg = await replyAsAgent({
        conversationId: selectedId,
        agentUserId: user.id,
        body: text,
        images: uploaded,
      })
      setMessages(prev => (prev.some(m => m.id === msg.id) ? prev : [...prev, msg]))
      await refreshList()
    } catch (err) {
      setDraft(text)
      setDraftImages(imagesSnapshot)
      setError(err instanceof Error ? err.message : 'Reply failed')
    } finally {
      setBusy(false)
    }
  }

  const userDetails = selected ? (
    <dl className="space-y-3 text-sm">
      {selected.guest_name || selected.guest_email ? (
        <>
          <div>
            <dt className="text-xs text-neutral-500">Guest name</dt>
            <dd className="text-neutral-900">{selected.guest_name?.trim() || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Guest email</dt>
            <dd className="break-all text-neutral-900">{selected.guest_email?.trim() || '—'}</dd>
          </div>
        </>
      ) : null}
      {selected.user_id ? (
        <>
          <div>
            <dt className="text-xs text-neutral-500">User ID</dt>
            <dd className="break-all font-mono text-xs text-neutral-800">{selected.user_id}</dd>
          </div>
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
          <div>
            <a
              href="https://app.tscopier.ai/dashboard"
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-green-600 hover:underline"
            >
              Open app
            </a>
          </div>
        </>
      ) : !selected.guest_name && !selected.guest_email ? (
        <p className="text-neutral-500">No linked user</p>
      ) : null}
    </dl>
  ) : (
    <p className="text-sm text-neutral-500">No conversation selected</p>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error ? (
        <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600">{error}</div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside
          className={clsx(
            'min-h-0 w-full shrink-0 flex-col border-r border-neutral-100 bg-white md:flex md:w-80',
            selectedId ? 'hidden' : 'flex',
          )}
        >
          <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
            <div>
              <p className="text-sm font-semibold capitalize text-neutral-900">{filter} chats</p>
              <p className="text-xs text-neutral-400">{conversations.length} conversations</p>
            </div>
            <button
              type="button"
              onClick={() => void refreshList()}
              className="rounded-full p-2 text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-800"
              aria-label="Refresh inbox"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {loadingList ? (
              <p className="px-2 py-4 text-sm text-neutral-500">Loading…</p>
            ) : conversations.length === 0 ? (
              <div className="mx-2 rounded-2xl bg-neutral-50 px-4 py-8 text-center">
                <MessageSquare className="mx-auto h-8 w-8 text-neutral-300" />
                <p className="mt-3 text-sm font-medium text-neutral-800">No chats to handle</p>
                <p className="mt-1 text-xs text-neutral-500">
                  Queued conversations will show up here.
                </p>
              </div>
            ) : (
              <ul className="space-y-1">
                {conversations.map(c => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      className={clsx(
                        'w-full rounded-xl px-3 py-3 text-left transition',
                        selectedId === c.id ? 'bg-neutral-100' : 'hover:bg-neutral-50',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-neutral-900">
                          {c.subject?.trim() ||
                            c.guest_name?.trim() ||
                            c.guest_email?.trim() ||
                            (c.user_id ? c.user_id.slice(0, 8) : 'Guest')}
                        </span>
                        <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium uppercase text-neutral-500 ring-1 ring-neutral-200">
                          {c.status}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-neutral-400">{formatWhen(c.last_message_at)}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <section
          className={clsx(
            'min-h-0 min-w-0 flex-1 flex-col bg-[#FAFBFC]',
            selectedId ? 'flex' : 'hidden md:flex',
          )}
        >
          {!selected ? (
            <div className="grid flex-1 place-items-center px-6 text-center">
              <div>
                <MessageSquare className="mx-auto h-10 w-10 text-neutral-300" />
                <p className="mt-4 text-base font-semibold text-neutral-900">No chats to handle</p>
                <p className="mt-1 text-sm text-neutral-500">
                  Pick a conversation from the list, or wait for new messages in the queue.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="border-b border-neutral-100 bg-white px-3 py-3 sm:px-4">
                <div className="flex items-start justify-between gap-2 sm:items-center sm:gap-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedId(null)}
                      className="mt-0.5 rounded-full p-1.5 text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-800 md:hidden"
                      aria-label="Back to inbox"
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </button>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-neutral-900">
                        {selected.subject?.trim() || 'Support conversation'}
                      </p>
                      <p className="text-xs text-neutral-500">
                        Status: {selected.status}
                        {selected.assignee_id ? ` · assignee ${selected.assignee_id.slice(0, 8)}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-2">
                    {selected.status === 'queued' || selected.status === 'active' ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onClaim()}
                        className="rounded-full bg-green-400 px-3.5 py-1.5 text-xs font-medium text-neutral-950 transition hover:bg-green-500 disabled:opacity-50"
                      >
                        Claim
                      </button>
                    ) : null}
                    {selected.status !== 'resolved' ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onResolve()}
                        className="rounded-full bg-neutral-100 px-3.5 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-200 disabled:opacity-50"
                      >
                        Resolve
                      </button>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDetailsOpen(value => !value)}
                  className="mt-3 flex w-full items-center justify-between rounded-xl bg-neutral-50 px-3 py-2 text-left text-xs font-medium text-neutral-600 xl:hidden"
                  aria-expanded={detailsOpen}
                >
                  User details
                  <ChevronDown
                    className={clsx('h-3.5 w-3.5 transition', detailsOpen && 'rotate-180')}
                  />
                </button>
                {detailsOpen ? (
                  <div className="mt-2 rounded-xl border border-neutral-100 bg-white p-3 xl:hidden">
                    {userDetails}
                  </div>
                ) : null}
              </div>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-4 sm:px-4">
                {messages.map(m => (
                  <div
                    key={m.id}
                    className={clsx(
                      'max-w-[min(75%,28rem)] rounded-2xl px-3 py-2 text-sm leading-relaxed',
                      m.sender_type === 'agent'
                        ? 'ml-auto bg-green-500 text-neutral-950'
                        : m.sender_type === 'user'
                          ? 'bg-white text-neutral-800 shadow-sm ring-1 ring-neutral-200'
                          : m.sender_type === 'system'
                            ? 'mx-auto max-w-full bg-transparent text-center text-xs text-neutral-500'
                            : 'bg-teal-50 text-neutral-800 ring-1 ring-teal-100',
                    )}
                  >
                    {m.sender_type !== 'system' && m.sender_type !== 'user' && m.sender_type !== 'agent' ? (
                      <span className="mb-0.5 block text-[10px] font-medium uppercase text-neutral-500">
                        {m.sender_type}
                      </span>
                    ) : null}
                    {m.body &&
                    !(Array.isArray(m.images) && m.images.length > 0 && m.body === 'Shared an image')
                      ? m.body
                      : null}
                    {Array.isArray(m.images) && m.images.length > 0 ? (
                      <div
                        className={clsx(
                          'mt-2 grid gap-1.5',
                          m.images.length === 1 ? 'grid-cols-1' : 'grid-cols-2',
                        )}
                      >
                        {m.images.map(src => (
                          <a
                            key={src}
                            href={src}
                            target="_blank"
                            rel="noreferrer"
                            className="block overflow-hidden rounded-lg"
                          >
                            <img
                              src={src}
                              alt=""
                              className="max-h-48 w-full object-cover ring-1 ring-neutral-200"
                            />
                          </a>
                        ))}
                      </div>
                    ) : null}
                    {m.sender_type !== 'system' ? (
                      <span className="mt-1 block text-[10px] opacity-60">{formatWhen(m.created_at)}</span>
                    ) : null}
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>

              {selected.status !== 'resolved' ? (
                <form
                  className="space-y-2 border-t border-neutral-200 bg-white p-3"
                  onSubmit={e => {
                    e.preventDefault()
                    void onReply()
                  }}
                >
                  {draftImages.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {draftImages.map((src, idx) => (
                        <div key={`${idx}-${src.slice(-12)}`} className="relative h-16 w-16 shrink-0">
                          <img
                            src={src}
                            alt=""
                            className="h-16 w-16 rounded-lg object-cover ring-1 ring-neutral-200"
                          />
                          <button
                            type="button"
                            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900 text-white shadow-sm"
                            aria-label="Remove image"
                            onClick={() => setDraftImages(prev => prev.filter((_, i) => i !== idx))}
                            disabled={busy}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex items-end gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      multiple
                      className="hidden"
                      onChange={e => {
                        const files = e.target.files
                        if (files?.length) void addImageFiles(files)
                        e.target.value = ''
                      }}
                    />
                    <button
                      type="button"
                      className="mb-0.5 rounded-lg p-2 text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
                      aria-label="Attach image"
                      disabled={busy || attaching || draftImages.length >= SUPPORT_MAX_IMAGES}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {attaching ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ImagePlus className="h-4 w-4" />
                      )}
                    </button>
                    <textarea
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      rows={2}
                      placeholder="Reply as agent…"
                      className="min-h-[44px] flex-1 resize-none rounded-xl border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-green-400 focus:ring-2 focus:ring-green-400/20"
                      onPaste={e => {
                        const files = Array.from(e.clipboardData?.files ?? []).filter(f =>
                          f.type.startsWith('image/'),
                        )
                        if (files.length) {
                          e.preventDefault()
                          void addImageFiles(files)
                        }
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          void onReply()
                        }
                      }}
                    />
                    <button
                      type="submit"
                      disabled={busy || attaching || (!draft.trim() && draftImages.length === 0)}
                      className="flex h-11 w-11 shrink-0 items-center justify-center self-end rounded-xl bg-green-500 text-neutral-950 disabled:opacity-40"
                      aria-label="Send reply"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  </div>
                </form>
              ) : null}
            </>
          )}
        </section>

        <aside className="hidden w-64 shrink-0 border-l border-neutral-100 bg-white p-4 xl:block">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">User</h2>
          <div className="mt-3">{userDetails}</div>
        </aside>
      </div>
    </div>
  )
}
