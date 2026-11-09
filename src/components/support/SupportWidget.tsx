import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Headphones,
  Home,
  ImagePlus,
  Loader2,
  MessageCircle,
  Send,
  Ticket,
  UserRound,
  X,
} from 'lucide-react'
import { createSupportTicket } from '../../lib/supportTickets'
import clsx from 'clsx'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../lib/supabase'
import { appUrl } from '../../lib/site'
import { isAssistantImageType } from '../../lib/assistantImages'
import {
  ensureOpenSupportConversation,
  escalateSupportConversation,
  filesToSupportImageDataUrls,
  listGuestSupportMessages,
  listSupportConversations,
  listSupportMessages,
  loginUrlForSupportReturn,
  readSupportGuestSession,
  sendSupportMessage,
  SUPPORT_MAX_IMAGES,
  uploadSupportImages,
  writeSupportGuestSession,
  type SupportConversation,
  type SupportGuestSession,
  type SupportMessage,
} from '../../lib/supportChat'

export type SupportWidgetVisibility = 'minimized' | 'maximized' | 'hidden'

export type SupportWidgetIntent = 'chat' | 'ticket' | null

type Tab = 'home' | 'messages'

type HomePane = 'main' | 'ticket' | 'ticket-success'

type SupportWidgetProps = {
  visibility: SupportWidgetVisibility
  onVisibilityChanged?: (visibility: SupportWidgetVisibility) => void
  intent?: SupportWidgetIntent
  onIntentConsumed?: () => void
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}

function previewBody(messages: SupportMessage[], conversationId: string): string {
  const last = [...messages].reverse().find(m => m.conversation_id === conversationId)
  if (!last) return 'No messages yet'
  const prefix =
    last.sender_type === 'user' ? 'You: ' : last.sender_type === 'system' ? '' : 'Support: '
  const text = last.body?.trim() || (last.images?.length ? 'Sent an image' : '')
  return `${prefix}${text}`.slice(0, 96)
}

function MessageImages({ images, onUser }: { images?: string[]; onUser?: boolean }) {
  if (!images?.length) return null
  return (
    <div
      className={clsx(
        'mt-2 grid gap-1.5',
        images.length === 1 ? 'grid-cols-1' : 'grid-cols-2',
      )}
    >
      {images.map(src => (
        <a key={src} href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg">
          <img
            src={src}
            alt=""
            className={clsx(
              'max-h-40 w-full object-cover',
              onUser ? 'ring-1 ring-neutral-900/10' : 'ring-1 ring-neutral-200',
            )}
          />
        </a>
      ))}
    </div>
  )
}

export function SupportWidget({
  visibility,
  onVisibilityChanged,
  intent = null,
  onIntentConsumed,
}: SupportWidgetProps) {
  const { user, loading: authLoading } = useAuth()
  const [tab, setTab] = useState<Tab>('home')
  const [conversations, setConversations] = useState<SupportConversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<SupportMessage[]>([])
  const [draft, setDraft] = useState('')
  const [draftImages, setDraftImages] = useState<string[]>([])
  const [attaching, setAttaching] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [loadingThread, setLoadingThread] = useState(false)
  const [guestSession, setGuestSession] = useState<SupportGuestSession | null>(null)
  const [guestName, setGuestName] = useState('')
  const [guestEmail, setGuestEmail] = useState('')
  const [homePane, setHomePane] = useState<HomePane>('main')
  const [ticketSubject, setTicketSubject] = useState('')
  const [ticketDescription, setTicketDescription] = useState('')
  const [ticketSubmitting, setTicketSubmitting] = useState(false)
  const [createdTicketNumber, setCreatedTicketNumber] = useState<number | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const open = visibility === 'maximized'

  const guestReady = useMemo(() => {
    if (user) return true
    if (guestSession) return true
    return Boolean(guestName.trim() && guestEmail.trim())
  }, [user, guestSession, guestName, guestEmail])

  const openConversations = useMemo(
    () => conversations.filter(c => c.status !== 'resolved'),
    [conversations],
  )

  const showComposer =
    tab === 'messages' &&
    guestReady &&
    (user
      ? activeId != null || openConversations.length === 0
      : activeId != null || conversations.length === 0)

  const activeConversation = useMemo(
    () => conversations.find(c => c.id === activeId) ?? null,
    [activeId, conversations],
  )

  const refreshConversations = useCallback(async () => {
    if (!user) {
      setConversations([])
      return
    }
    try {
      const rows = await listSupportConversations()
      setConversations(rows)
    } catch (err) {
      console.warn('support conversations load failed', err)
    }
  }, [user])

  const loadThread = useCallback(
    async (conversationId: string) => {
      setLoadingThread(true)
      setError('')
      try {
        if (user) {
          const rows = await listSupportMessages(conversationId)
          setMessages(rows)
          return
        }
        const token = guestSession?.token
        if (!token) return
        const { conversation, messages: rows } = await listGuestSupportMessages({
          guestToken: token,
          conversationId,
        })
        setMessages(rows)
        setConversations(prev => {
          const rest = prev.filter(c => c.id !== conversation.id)
          return [conversation, ...rest]
        })
        const nextSession: SupportGuestSession = {
          name: guestSession.name,
          email: guestSession.email,
          token: guestSession.token,
          conversationId: conversation.id,
        }
        setGuestSession(nextSession)
        writeSupportGuestSession(nextSession)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load messages')
      } finally {
        setLoadingThread(false)
      }
    },
    [user, guestSession],
  )

  useEffect(() => {
    if (!open || !user) return
    void refreshConversations()
  }, [open, user, refreshConversations])

  useEffect(() => {
    if (!open || !activeId) return
    if (user || guestSession?.token) void loadThread(activeId)
  }, [open, activeId, user, guestSession?.token, loadThread])

  useEffect(() => {
    if (user || !open) return
    const stored = readSupportGuestSession()
    if (!stored) return
    setGuestSession(stored)
    setGuestName(stored.name)
    setGuestEmail(stored.email)
    if (stored.conversationId) setActiveId(stored.conversationId)
  }, [open, user])

  useEffect(() => {
    if (!open || user || !guestSession?.token || !activeId) return
    const token = guestSession.token
    const conversationId = activeId
    const poll = async () => {
      try {
        const { conversation, messages: rows } = await listGuestSupportMessages({
          guestToken: token,
          conversationId,
        })
        setMessages(rows)
        setConversations(prev => {
          const rest = prev.filter(c => c.id !== conversation.id)
          return [conversation, ...rest]
        })
        if (conversation.id !== guestSession.conversationId) {
          const next: SupportGuestSession = {
            ...guestSession,
            conversationId: conversation.id,
          }
          setGuestSession(next)
          writeSupportGuestSession(next)
        }
      } catch (err) {
        console.warn('guest support poll failed', err)
      }
    }
    const id = window.setInterval(() => void poll(), 4000)
    return () => window.clearInterval(id)
  }, [open, user, guestSession, activeId])

  useEffect(() => {
    if (!open || !user) return
    const channel = supabase
      .channel(`support-widget-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'support_conversations',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          void refreshConversations()
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'support_messages' },
        payload => {
          const row = payload.new as SupportMessage
          if (!row?.conversation_id) return
          if (activeId && row.conversation_id === activeId) {
            setMessages(prev => (prev.some(m => m.id === row.id) ? prev : [...prev, row]))
          }
          void refreshConversations()
        },
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [open, user, activeId, refreshConversations])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, open, activeId])

  useEffect(() => {
    if (!open || !intent) return
    setTab('home')
    if (intent === 'ticket') {
      setHomePane(user || guestReady ? 'ticket' : 'main')
    }
    onIntentConsumed?.()
  }, [open, intent, onIntentConsumed, user, guestReady])

  const close = () => onVisibilityChanged?.('minimized')
  const maximize = () => onVisibilityChanged?.('maximized')

  const finishGuestDetailsOnHome = () => {
    const name = guestName.trim()
    const email = guestEmail.trim()
    if (!name || !email) {
      setError('Enter your name and email to continue.')
      return
    }
    setError('')
  }

  const openTicketPane = () => {
    if (!guestReady) return
    setHomePane('ticket')
    setCreatedTicketNumber(null)
    setError('')
  }

  const submitTicket = async () => {
    const subject = ticketSubject.trim()
    const message = ticketDescription.trim()
    if (!subject || !message || ticketSubmitting || !guestReady) return
    setTicketSubmitting(true)
    setError('')
    try {
      const guestPayload =
        !user
          ? {
              name: guestSession?.name ?? guestName.trim(),
              email: guestSession?.email ?? guestEmail.trim(),
              token: guestSession?.token ?? null,
            }
          : null
      const result = await createSupportTicket({
        subject,
        message,
        guest: guestPayload,
      })
      if (!user && result.guest_token) {
        const nextSession: SupportGuestSession = {
          name: guestPayload!.name,
          email: guestPayload!.email,
          token: result.guest_token,
          conversationId: guestSession?.conversationId ?? null,
        }
        writeSupportGuestSession(nextSession)
        setGuestSession(nextSession)
      }
      setCreatedTicketNumber(result.ticket.number)
      setTicketSubject('')
      setTicketDescription('')
      setHomePane('ticket-success')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create ticket')
    } finally {
      setTicketSubmitting(false)
    }
  }

  const continueAsGuest = () => {
    const name = guestName.trim()
    const email = guestEmail.trim()
    if (!name || !email) {
      setError('Enter your name and email to continue.')
      return
    }
    setError('')
    setTab('messages')
    const openConvo = conversations.find(c => c.status !== 'resolved')
    if (guestSession?.conversationId) {
      setActiveId(guestSession.conversationId)
    } else if (openConvo) {
      setActiveId(openConvo.id)
    } else {
      setActiveId(null)
      setMessages([])
    }
  }

  const startMessage = () => {
    if (!guestReady) return
    setTab('messages')
    const openConvo = conversations.find(c => c.status !== 'resolved')
    if (user && openConvo) {
      setActiveId(openConvo.id)
    } else if (!user && guestSession?.conversationId) {
      setActiveId(guestSession.conversationId)
    } else if (openConvo) {
      setActiveId(openConvo.id)
    } else {
      setActiveId(null)
      setMessages([])
    }
  }

  const openConversation = (id: string) => {
    setActiveId(id)
    setTab('messages')
  }

  const addImageFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter(f => isAssistantImageType(f.type))
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
      const next = await filesToSupportImageDataUrls(list.slice(0, room))
      if (next.length) setDraftImages(prev => [...prev, ...next].slice(0, SUPPORT_MAX_IMAGES))
    } catch (err) {
      const code = err instanceof Error ? err.message : ''
      setError(code === 'too_large' ? 'Image is too large.' : 'Could not attach that image.')
    } finally {
      setAttaching(false)
    }
  }

  const onSend = async () => {
    const text = draft.trim()
    if ((!text && draftImages.length === 0) || sending || attaching || !guestReady) return
    setSending(true)
    setError('')
    const imagesSnapshot = draftImages
    setDraft('')
    setDraftImages([])
    try {
      if (user) {
        const conversationId =
          activeId ?? (await ensureOpenSupportConversation(user.id))
        const uploaded =
          imagesSnapshot.length > 0
            ? await uploadSupportImages({
                userId: user.id,
                conversationId,
                dataUrls: imagesSnapshot,
              })
            : []
        const result = await sendSupportMessage({
          message: text,
          conversationId,
          images: uploaded,
        })
        setActiveId(result.conversation_id)
        setMessages(prev => {
          const next = [...prev]
          if (!next.some(m => m.id === result.user_message.id)) next.push(result.user_message)
          if (result.ai_message && !next.some(m => m.id === result.ai_message!.id)) {
            next.push(result.ai_message)
          }
          return next
        })
        await refreshConversations()
        return
      }

      const guest = {
        name: guestSession?.name ?? guestName.trim(),
        email: guestSession?.email ?? guestEmail.trim(),
        token: guestSession?.token ?? null,
      }
      const result = await sendSupportMessage({
        message: text,
        conversationId: activeId,
        imageDataUrls: imagesSnapshot.length > 0 ? imagesSnapshot : undefined,
        guest,
      })
      const token = result.guest_token ?? guest.token
      if (token) {
        const nextSession: SupportGuestSession = {
          name: guest.name,
          email: guest.email,
          token,
          conversationId: result.conversation_id,
        }
        writeSupportGuestSession(nextSession)
        setGuestSession(nextSession)
      }
      setActiveId(result.conversation_id)
      setMessages(prev => {
        const next = [...prev]
        if (!next.some(m => m.id === result.user_message.id)) next.push(result.user_message)
        if (result.ai_message && !next.some(m => m.id === result.ai_message!.id)) {
          next.push(result.ai_message)
        }
        return next
      })
      if (result.status) {
        setConversations(prev => {
          const existing = prev.find(c => c.id === result.conversation_id)
          const patch: SupportConversation = {
            id: result.conversation_id,
            user_id: null,
            status: result.status,
            assignee_id: existing?.assignee_id ?? null,
            subject: existing?.subject ?? null,
            last_message_at: new Date().toISOString(),
            created_at: existing?.created_at ?? new Date().toISOString(),
            updated_at: new Date().toISOString(),
            guest_name: guest.name,
            guest_email: guest.email,
          }
          const rest = prev.filter(c => c.id !== result.conversation_id)
          return [patch, ...rest]
        })
      }
    } catch (err) {
      setDraft(text)
      setDraftImages(imagesSnapshot)
      setError(err instanceof Error ? err.message : 'Failed to send')
    } finally {
      setSending(false)
    }
  }

  const onEscalate = async () => {
    if (!activeId || sending) return
    setSending(true)
    setError('')
    try {
      const guestEscalate =
        !user && guestSession?.token ? { token: guestSession.token } : null
      await escalateSupportConversation(activeId, guestEscalate)
      if (user) await refreshConversations()
      await loadThread(activeId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request agent')
    } finally {
      setSending(false)
    }
  }

  const loginHref = appUrl(loginUrlForSupportReturn())

  if (visibility === 'hidden') return null

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex flex-col items-end gap-3">
      {open ? (
        <div
          className="pointer-events-auto flex h-[min(560px,calc(100dvh-6.5rem))] w-[min(380px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl shadow-neutral-900/15"
          role="dialog"
          aria-label="Support chat"
        >
          <header className="flex items-center justify-between bg-gradient-to-br from-emerald-600 to-green-500 px-4 py-3 text-white">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15">
                <Headphones className="h-4 w-4" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-semibold leading-tight">UniCopier Support</p>
                <p className="text-[11px] text-white/80">We typically reply in minutes</p>
              </div>
            </div>
            <button
              type="button"
              onClick={close}
              className="rounded-lg p-1.5 text-white/90 hover:bg-white/15"
              aria-label="Close support"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto bg-neutral-50">
            {tab === 'home' ? (
              <div className="space-y-4 p-4">
                <div>
                  <p className="text-2xl font-semibold text-neutral-900">Hi there</p>
                  <p className="mt-1 text-sm text-neutral-600">
                    Ask our AI anything about UniCopier — or request a human when you need one.
                  </p>
                </div>

                {authLoading ? (
                  <p className="text-sm text-neutral-500">Checking sign-in…</p>
                ) : homePane === 'ticket-success' ? (
                  <div className="rounded-xl border border-green-200 bg-teal-50 p-4">
                    <p className="text-sm font-semibold text-neutral-900">
                      Ticket #{createdTicketNumber} created
                    </p>
                    <p className="mt-1 text-sm text-neutral-600">
                      We emailed a confirmation to your inbox.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setHomePane('main')
                        setCreatedTicketNumber(null)
                      }}
                      className="mt-4 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
                    >
                      Back to home
                    </button>
                  </div>
                ) : homePane === 'ticket' ? (
                  <form
                    className="space-y-3 rounded-xl border border-neutral-200 bg-white p-4"
                    onSubmit={e => {
                      e.preventDefault()
                      void submitTicket()
                    }}
                  >
                    <p className="text-sm font-medium text-neutral-900">Create a support ticket</p>
                    <label className="block">
                      <span className="text-xs font-medium text-neutral-600">Subject</span>
                      <input
                        type="text"
                        value={ticketSubject}
                        onChange={e => setTicketSubject(e.target.value)}
                        maxLength={200}
                        className="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-green-400 focus:ring-2 focus:ring-green-400/20"
                        placeholder="Brief summary"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-neutral-600">Description</span>
                      <textarea
                        value={ticketDescription}
                        onChange={e => setTicketDescription(e.target.value)}
                        rows={4}
                        className="mt-1 w-full resize-none rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-green-400 focus:ring-2 focus:ring-green-400/20"
                        placeholder="What can we help with?"
                      />
                    </label>
                    {error && tab === 'home' ? (
                      <p className="text-xs text-red-500">{error}</p>
                    ) : null}
                    <button
                      type="submit"
                      disabled={
                        ticketSubmitting || !ticketSubject.trim() || !ticketDescription.trim()
                      }
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-green-500 px-3 py-2 text-sm font-medium text-neutral-950 hover:bg-green-400 disabled:opacity-50"
                    >
                      {ticketSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Submit ticket
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setHomePane('main')
                        setError('')
                      }}
                      className="w-full text-center text-xs font-medium text-neutral-500 hover:text-neutral-800"
                    >
                      Cancel
                    </button>
                  </form>
                ) : guestReady ? (
                  <div className="space-y-3">
                    <button
                      type="button"
                      onClick={startMessage}
                      className="flex w-full items-center gap-3 rounded-xl border border-neutral-200 bg-white p-4 text-left shadow-sm transition hover:border-green-400/60 hover:shadow-md"
                    >
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-teal-50 text-green-600">
                        <Send className="h-4 w-4" aria-hidden />
                      </span>
                      <span>
                        <span className="block text-sm font-semibold text-neutral-900">
                          Send us a message
                        </span>
                        <span className="block text-xs text-neutral-500">
                          AI answers instantly · humans on request
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={openTicketPane}
                      className="flex w-full items-center gap-3 rounded-xl border border-neutral-200 bg-white p-4 text-left shadow-sm transition hover:border-green-400/60 hover:shadow-md"
                    >
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-teal-50 text-green-600">
                        <Ticket className="h-4 w-4" aria-hidden />
                      </span>
                      <span>
                        <span className="block text-sm font-semibold text-neutral-900">
                          Create a ticket
                        </span>
                        <span className="block text-xs text-neutral-500">
                          Email follow-up · tracked request
                        </span>
                      </span>
                    </button>
                  </div>
                ) : (
                  <form
                    className="rounded-xl border border-neutral-200 bg-white p-4 space-y-3"
                    onSubmit={e => {
                      e.preventDefault()
                      finishGuestDetailsOnHome()
                    }}
                  >
                    <p className="text-sm text-neutral-700">Enter your details to start chatting.</p>
                    <label className="block">
                      <span className="text-xs font-medium text-neutral-600">Name</span>
                      <input
                        type="text"
                        value={guestName}
                        onChange={e => setGuestName(e.target.value)}
                        autoComplete="name"
                        className="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-green-400 focus:ring-2 focus:ring-green-400/20"
                        placeholder="Your name"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-neutral-600">Email</span>
                      <input
                        type="email"
                        value={guestEmail}
                        onChange={e => setGuestEmail(e.target.value)}
                        autoComplete="email"
                        className="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-green-400 focus:ring-2 focus:ring-green-400/20"
                        placeholder="you@example.com"
                      />
                    </label>
                    {error && tab === 'home' ? (
                      <p className="text-xs text-red-500">{error}</p>
                    ) : null}
                    <button
                      type="submit"
                      className="w-full rounded-lg bg-green-500 px-3 py-2 text-sm font-medium text-neutral-950 hover:bg-green-400"
                    >
                      Continue
                    </button>
                    <p className="text-center text-xs text-neutral-500">
                      <a href={loginHref} className="font-medium text-green-600 hover:underline">
                        Prefer to sign in?
                      </a>
                    </p>
                  </form>
                )}

                {guestReady && conversations.length > 0 ? (
                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
                      Recent
                    </p>
                    <ul className="space-y-2">
                      {conversations.slice(0, 3).map(c => (
                        <li key={c.id}>
                          <button
                            type="button"
                            onClick={() => openConversation(c.id)}
                            className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-left hover:border-green-400/50"
                          >
                            <span className="flex items-center justify-between gap-2">
                              <span className="text-sm font-medium text-neutral-900">
                                {c.subject?.trim() || 'Support chat'}
                              </span>
                              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium uppercase text-neutral-600">
                                {c.status}
                              </span>
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-neutral-500">
                              {formatTime(c.last_message_at)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                {!guestReady ? (
                  <form
                    className="space-y-3 p-4"
                    onSubmit={e => {
                      e.preventDefault()
                      continueAsGuest()
                    }}
                  >
                    <p className="text-sm text-neutral-600">Enter your name and email to chat.</p>
                    <input
                      type="text"
                      value={guestName}
                      onChange={e => setGuestName(e.target.value)}
                      autoComplete="name"
                      className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-green-400"
                      placeholder="Name"
                    />
                    <input
                      type="email"
                      value={guestEmail}
                      onChange={e => setGuestEmail(e.target.value)}
                      autoComplete="email"
                      className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-green-400"
                      placeholder="Email"
                    />
                    {error ? <p className="text-xs text-red-500">{error}</p> : null}
                    <button
                      type="submit"
                      className="w-full rounded-lg bg-green-500 px-3 py-2 text-sm font-medium text-neutral-950"
                    >
                      Continue
                    </button>
                  </form>
                ) : (
                  <>
                    {!activeId && user && openConversations.length > 0 ? (
                      <ul className="space-y-2 p-3">
                        {conversations.map(c => (
                          <li key={c.id}>
                            <button
                              type="button"
                              onClick={() => openConversation(c.id)}
                              className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-left"
                            >
                              <span className="flex justify-between gap-2 text-sm font-medium text-neutral-900">
                                {c.subject?.trim() || 'Support chat'}
                                <span className="text-[10px] uppercase text-neutral-500">{c.status}</span>
                              </span>
                              <span className="mt-0.5 block truncate text-xs text-neutral-500">
                                {previewBody(messages, c.id) || formatTime(c.last_message_at)}
                              </span>
                            </button>
                          </li>
                        ))}
                        <li>
                          <button
                            type="button"
                            onClick={() => {
                              setActiveId(null)
                              setMessages([])
                            }}
                            className="w-full rounded-xl border border-dashed border-neutral-300 bg-white px-3 py-2.5 text-sm font-medium text-green-600"
                          >
                            New conversation
                          </button>
                        </li>
                      </ul>
                    ) : (
                      <>
                        <div className="flex items-center justify-between border-b border-neutral-200 bg-white px-3 py-2">
                          <button
                            type="button"
                            onClick={() => {
                              setActiveId(null)
                              void refreshConversations()
                            }}
                            className="text-xs font-medium text-neutral-500 hover:text-neutral-800"
                          >
                            All messages
                          </button>
                          {activeConversation && activeConversation.status === 'ai' ? (
                            <button
                              type="button"
                              disabled={sending}
                              onClick={() => void onEscalate()}
                              className="inline-flex items-center gap-1 rounded-full bg-teal-50 px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-teal-100 disabled:opacity-50"
                            >
                              <UserRound className="h-3 w-3" aria-hidden />
                              Request human
                            </button>
                          ) : null}
                          {activeConversation?.status === 'queued' ? (
                            <span className="text-xs font-medium text-amber-600">Waiting for agent…</span>
                          ) : null}
                          {activeConversation?.status === 'active' ? (
                            <span className="text-xs font-medium text-green-600">Agent connected</span>
                          ) : null}
                        </div>
                        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
                          {loadingThread ? (
                            <p className="text-center text-xs text-neutral-500">Loading…</p>
                          ) : null}
                          {messages.map(m => (
                            <div
                              key={m.id}
                              className={clsx(
                                'max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed',
                                m.sender_type === 'user'
                                  ? 'ml-auto bg-green-500 text-neutral-950'
                                  : m.sender_type === 'system'
                                    ? 'mx-auto max-w-[95%] bg-transparent text-center text-xs text-neutral-500'
                                    : 'bg-white text-neutral-800 shadow-sm ring-1 ring-neutral-200',
                              )}
                            >
                              {m.body &&
                              !(m.images?.length && m.body === 'Shared an image')
                                ? m.body
                                : null}
                              <MessageImages images={m.images} onUser={m.sender_type === 'user'} />
                              {m.sender_type !== 'system' ? (
                                <span
                                  className={clsx(
                                    'mt-1 block text-[10px]',
                                    m.sender_type === 'user' ? 'text-neutral-800/70' : 'text-neutral-400',
                                  )}
                                >
                                  {formatTime(m.created_at)}
                                </span>
                              ) : null}
                            </div>
                          ))}
                          <div ref={bottomRef} />
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {showComposer ? (
            <div className="border-t border-neutral-200 bg-white p-3">
              {error ? <p className="mb-2 text-xs text-red-500">{error}</p> : null}
              {activeConversation?.status === 'resolved' ? (
                <p className="text-xs text-neutral-500">This conversation is resolved. Start a new one from Home.</p>
              ) : (
                <form
                  className="space-y-2"
                  onSubmit={e => {
                    e.preventDefault()
                    void onSend()
                  }}
                >
                  {draftImages.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {draftImages.map((src, idx) => (
                        <div key={`${idx}-${src.slice(-12)}`} className="relative h-14 w-14 shrink-0">
                          <img
                            src={src}
                            alt=""
                            className="h-14 w-14 rounded-lg object-cover ring-1 ring-neutral-200"
                          />
                          <button
                            type="button"
                            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900 text-white shadow-sm"
                            aria-label="Remove image"
                            onClick={() => setDraftImages(prev => prev.filter((_, i) => i !== idx))}
                            disabled={sending}
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
                      disabled={sending || attaching || draftImages.length >= SUPPORT_MAX_IMAGES}
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
                      rows={1}
                      placeholder="Write a message…"
                      className="max-h-28 min-h-[40px] flex-1 resize-none rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-900 outline-none focus:border-green-400 focus:ring-2 focus:ring-green-400/20"
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
                          void onSend()
                        }
                      }}
                    />
                    <button
                      type="submit"
                      disabled={sending || attaching || (!draft.trim() && draftImages.length === 0)}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-green-500 text-neutral-950 disabled:opacity-40"
                      aria-label="Send"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  </div>
                </form>
              )}
            </div>
          ) : null}

          <nav className="flex border-t border-neutral-200 bg-white">
            <button
              type="button"
              onClick={() => setTab('home')}
              className={clsx(
                'flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium',
                tab === 'home' ? 'text-green-600' : 'text-neutral-500',
              )}
            >
              <Home className="h-4 w-4" />
              Home
            </button>
            <button
              type="button"
              onClick={() => setTab('messages')}
              className={clsx(
                'flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium',
                tab === 'messages' ? 'text-green-600' : 'text-neutral-500',
              )}
            >
              <MessageCircle className="h-4 w-4" />
              Messages
            </button>
          </nav>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => (open ? close() : maximize())}
        className={clsx(
          'pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-500 shadow-lg shadow-green-900/20 transition hover:bg-green-400',
          !open && 'hover:scale-105',
        )}
        aria-label={open ? 'Close support chat' : 'Open support chat'}
      >
        {open ? (
          <X className="h-5 w-5 text-neutral-950" />
        ) : (
          <img
            src="/support-icon.png"
            alt=""
            width={28}
            height={28}
            className="h-7 w-7 rounded-md object-cover"
            draggable={false}
          />
        )}
      </button>
    </div>
  )
}
