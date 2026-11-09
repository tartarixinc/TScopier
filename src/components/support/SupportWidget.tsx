import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
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
import { useT } from '../../context/LocaleContext'
import { useUserProfile } from '../../context/UserProfileContext'
import type { SupportWidgetTranslations } from '../../i18n/supportWidget/types'
import { playSupportNotificationSound } from '../../lib/notificationSound'
import { supabase } from '../../lib/supabase'
import { appUrl } from '../../lib/site'
import { isAssistantImageType } from '../../lib/assistantImages'
import {
  ensureOpenSupportConversation,
  escalateSupportConversation,
  fetchSupportAgentProfiles,
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
  type SupportAgentProfile,
  type SupportConversation,
  type SupportGuestSession,
  type SupportMessage,
} from '../../lib/supportChat'

export type SupportWidgetVisibility = 'minimized' | 'maximized' | 'hidden'

export type SupportWidgetIntent = 'chat' | 'ticket' | null

/** Team faces shown in the widget header (overlapping stack). */
export type SupportHeaderAvatar = {
  name: string
  src?: string | null
}

type Tab = 'home' | 'messages'

type HomePane = 'main' | 'ticket' | 'ticket-success'

type SupportWidgetProps = {
  visibility: SupportWidgetVisibility
  onVisibilityChanged?: (visibility: SupportWidgetVisibility) => void
  intent?: SupportWidgetIntent
  onIntentConsumed?: () => void
  /** Optional support-team avatars for the header. Live agent profiles load when omitted. */
  headerAvatars?: SupportHeaderAvatar[]
}

function avatarInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase()
  return (parts[0] ?? 'U').slice(0, 2).toUpperCase()
}

function PersonAvatar({
  name,
  src,
  size = 'md',
  className,
}: {
  name: string
  src?: string | null
  size?: 'sm' | 'md'
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [src])
  const sizeClass = size === 'sm' ? 'h-7 w-7 text-[9px]' : 'h-9 w-9 text-[10px]'
  return (
    <span
      className={clsx(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-green-400 font-semibold text-neutral-950',
        sizeClass,
        className,
      )}
      title={name}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        avatarInitials(name)
      )}
    </span>
  )
}

function HeaderAvatarStack({ avatars }: { avatars: SupportHeaderAvatar[] }) {
  const maxFaces = 3
  const shown = avatars.slice(0, maxFaces)
  const overflow = Math.max(0, avatars.length - maxFaces)
  if (shown.length === 0) {
    return (
      <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-white/80 text-green-500 shadow-xs ring-1 ring-black/5 dark:bg-neutral-900 dark:text-teal-300 dark:ring-white/10">
        <Headphones className="h-4 w-4" aria-hidden />
      </span>
    )
  }
  return (
    <div className="flex items-center ps-0.5" aria-hidden>
      {shown.map((avatar, index) => (
        <PersonAvatar
          key={`${avatar.name}-${index}`}
          name={avatar.name}
          src={avatar.src}
          className={clsx('ring-2 ring-white dark:ring-neutral-950', index > 0 && '-ms-2.5')}
        />
      ))}
      {overflow > 0 ? (
        <span
          className="-ms-2.5 flex h-9 w-9 items-center justify-center rounded-full bg-neutral-900 text-[10px] font-semibold text-white ring-2 ring-white dark:bg-neutral-700 dark:ring-neutral-950"
          title={`${overflow} more`}
        >
          +{overflow > 9 ? '9' : overflow}
        </span>
      ) : null}
    </div>
  )
}

function statusLabel(
  status: string,
  t: Pick<
    SupportWidgetTranslations,
    'statusAi' | 'statusQueued' | 'statusActive' | 'statusResolved'
  >,
): string {
  switch (status) {
    case 'ai':
      return t.statusAi
    case 'queued':
      return t.statusQueued
    case 'active':
      return t.statusActive
    case 'resolved':
      return t.statusResolved
    default:
      return status
  }
}

function StatusDot({
  status,
  t,
  label,
}: {
  status: string
  t?: Pick<
    SupportWidgetTranslations,
    'statusAi' | 'statusQueued' | 'statusActive' | 'statusResolved'
  >
  label?: string
}) {
  const live = status === 'active' || status === 'ai' || status === 'queued'
  const text = label ?? (t ? statusLabel(status, t) : status)
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
      <span
        className={clsx(
          'h-1.5 w-1.5 rounded-full',
          live ? 'bg-green-400' : 'bg-neutral-300 dark:bg-neutral-600',
        )}
      />
      {text}
    </span>
  )
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}

function previewBody(
  messages: SupportMessage[],
  conversationId: string,
  labels: Pick<
    SupportWidgetTranslations,
    'youPrefix' | 'supportPrefix' | 'noMessagesYet' | 'sentAnImage'
  >,
): string {
  const last = [...messages].reverse().find(m => m.conversation_id === conversationId)
  if (!last) return labels.noMessagesYet
  const prefix =
    last.sender_type === 'user'
      ? labels.youPrefix
      : last.sender_type === 'system'
        ? ''
        : labels.supportPrefix
  const text = last.body?.trim() || (last.images?.length ? labels.sentAnImage : '')
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
  headerAvatars,
}: SupportWidgetProps) {
  const translations = useT()
  const t = translations.supportWidget
  const imageLimitReached = translations.assistant.imageLimitReached
  const { user, loading: authLoading } = useAuth()
  const { profile } = useUserProfile()
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
  const [unreadCount, setUnreadCount] = useState(0)
  const [teamAvatars, setTeamAvatars] = useState<SupportHeaderAvatar[]>([])
  const [agentProfiles, setAgentProfiles] = useState<Record<string, SupportAgentProfile>>({})
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const knownMessageIdsRef = useRef<Set<string>>(new Set())
  const hydratedConversationsRef = useRef<Set<string>>(new Set())
  const viewStateRef = useRef({ open: false, tab: 'home' as Tab, activeId: null as string | null })
  const open = visibility === 'maximized'

  viewStateRef.current = { open, tab, activeId }

  const markMessagesSeen = useCallback((rows: SupportMessage[]) => {
    for (const m of rows) knownMessageIdsRef.current.add(m.id)
  }, [])

  const notifyInboundMessage = useCallback((message: SupportMessage) => {
    if (!message?.id) return
    if (message.sender_type !== 'ai' && message.sender_type !== 'agent') return
    if (knownMessageIdsRef.current.has(message.id)) return
    knownMessageIdsRef.current.add(message.id)

    const view = viewStateRef.current
    const viewingThread =
      view.open && view.tab === 'messages' && view.activeId === message.conversation_id
    if (viewingThread) return

    setUnreadCount(count => count + 1)
    playSupportNotificationSound()
  }, [])

  /** First snapshot for a conversation is silent; later rows notify. */
  const ingestConversationMessages = useCallback(
    (rows: SupportMessage[], conversationId: string) => {
      const hydrated = hydratedConversationsRef.current.has(conversationId)
      if (hydrated) {
        for (const row of rows) notifyInboundMessage(row)
      }
      markMessagesSeen(rows)
      hydratedConversationsRef.current.add(conversationId)
    },
    [markMessagesSeen, notifyInboundMessage],
  )

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
          ingestConversationMessages(rows, conversationId)
          setMessages(rows)
          return
        }
        const token = guestSession?.token
        if (!token) return
        const { conversation, messages: rows } = await listGuestSupportMessages({
          guestToken: token,
          conversationId,
        })
        ingestConversationMessages(rows, conversation.id)
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
        setError(err instanceof Error ? err.message : t.errorLoadMessages)
      } finally {
        setLoadingThread(false)
      }
    },
    [user, guestSession, ingestConversationMessages, t.errorLoadMessages],
  )

  useEffect(() => {
    if (!open || !user) return
    void refreshConversations()
  }, [open, user, refreshConversations])

  // Header: agent photos when available, initials when not
  useEffect(() => {
    if (headerAvatars?.length) return
    let cancelled = false
    void fetchSupportAgentProfiles().then(rows => {
      if (cancelled) return
      setTeamAvatars(
        rows.map(row => ({
          name: row.display_name,
          src: row.avatar_url,
        })),
      )
      setAgentProfiles(prev => {
        const next = { ...prev }
        for (const row of rows) next[row.user_id] = row
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [headerAvatars])

  // Resolve agent photos/names for anyone who has spoken or joined this thread
  useEffect(() => {
    const wanted = new Set<string>()
    for (const m of messages) {
      if (m.sender_user_id && (m.sender_type === 'agent' || m.sender_type === 'system')) {
        wanted.add(m.sender_user_id)
      }
    }
    if (activeConversation?.assignee_id) wanted.add(activeConversation.assignee_id)
    const missing = Array.from(wanted).filter(id => !agentProfiles[id])
    if (!missing.length) return
    let cancelled = false
    void fetchSupportAgentProfiles(missing).then(rows => {
      if (cancelled || !rows.length) return
      setAgentProfiles(prev => {
        const next = { ...prev }
        for (const row of rows) next[row.user_id] = row
        return next
      })
    })
    return () => {
      cancelled = true
    }
    // intentionally omit agentProfiles — we only fetch ids missing at effect time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeConversation?.assignee_id])

  useEffect(() => {
    if (!open || !activeId) return
    if (user || guestSession?.token) void loadThread(activeId)
  }, [open, activeId, user, guestSession?.token, loadThread])

  useEffect(() => {
    if (user) return
    const stored = readSupportGuestSession()
    if (!stored) return
    setGuestSession(stored)
    setGuestName(stored.name)
    setGuestEmail(stored.email)
    if (stored.conversationId) setActiveId(prev => prev ?? stored.conversationId)
  }, [user])

  // Guest poll — keeps running while minimized so new replies can notify
  useEffect(() => {
    if (user) return
    const token = guestSession?.token
    const conversationId = guestSession?.conversationId ?? activeId
    if (!token || !conversationId) return

    const poll = async () => {
      try {
        const { conversation, messages: rows } = await listGuestSupportMessages({
          guestToken: token,
          conversationId,
        })
        ingestConversationMessages(rows, conversation.id)
        const view = viewStateRef.current
        if (view.open && view.activeId === conversation.id) {
          setMessages(rows)
        }
        setConversations(prev => {
          const rest = prev.filter(c => c.id !== conversation.id)
          return [conversation, ...rest]
        })
        if (conversation.id !== guestSession?.conversationId) {
          const next: SupportGuestSession = {
            name: guestSession!.name,
            email: guestSession!.email,
            token,
            conversationId: conversation.id,
          }
          setGuestSession(next)
          writeSupportGuestSession(next)
        }
      } catch (err) {
        console.warn('guest support poll failed', err)
      }
    }
    void poll()
    const id = window.setInterval(() => void poll(), 4000)
    return () => window.clearInterval(id)
  }, [user, guestSession, activeId, ingestConversationMessages])

  // Authenticated realtime — listen even when minimized for launcher badge + sound
  useEffect(() => {
    if (!user) return
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
          notifyInboundMessage(row)
          const view = viewStateRef.current
          if (view.open && view.activeId === row.conversation_id) {
            setMessages(prev => (prev.some(m => m.id === row.id) ? prev : [...prev, row]))
          }
          void refreshConversations()
        },
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [user, refreshConversations, notifyInboundMessage])

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

  useEffect(() => {
    if (!open) return
    setUnreadCount(0)
  }, [open])

  const close = () => onVisibilityChanged?.('minimized')
  const maximize = () => {
    setUnreadCount(0)
    onVisibilityChanged?.('maximized')
  }

  const finishGuestDetailsOnHome = () => {
    const name = guestName.trim()
    const email = guestEmail.trim()
    if (!name || !email) {
      setError(t.errorEnterDetails)
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
      setError(err instanceof Error ? err.message : t.errorCreateTicket)
    } finally {
      setTicketSubmitting(false)
    }
  }

  const continueAsGuest = () => {
    const name = guestName.trim()
    const email = guestEmail.trim()
    if (!name || !email) {
      setError(t.errorEnterDetails)
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
      setError(t.errorInvalidImage)
      return
    }
    const room = SUPPORT_MAX_IMAGES - draftImages.length
    if (room <= 0) {
      setError(imageLimitReached)
      return
    }
    setError('')
    setAttaching(true)
    try {
      const next = await filesToSupportImageDataUrls(list.slice(0, room))
      if (next.length) setDraftImages(prev => [...prev, ...next].slice(0, SUPPORT_MAX_IMAGES))
    } catch (err) {
      const code = err instanceof Error ? err.message : ''
      setError(code === 'too_large' ? t.errorImageTooLarge : t.errorAttachFailed)
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
        const appended = [result.user_message, result.ai_message].filter(Boolean) as SupportMessage[]
        markMessagesSeen(appended)
        setMessages(prev => {
          const next = [...prev]
          for (const m of appended) {
            if (!next.some(x => x.id === m.id)) next.push(m)
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
      const appended = [result.user_message, result.ai_message].filter(Boolean) as SupportMessage[]
      markMessagesSeen(appended)
      setMessages(prev => {
        const next = [...prev]
        for (const m of appended) {
          if (!next.some(x => x.id === m.id)) next.push(m)
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
      setError(err instanceof Error ? err.message : t.errorSend)
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
      setError(err instanceof Error ? err.message : t.errorRequestAgent)
    } finally {
      setSending(false)
    }
  }

  const loginHref = appUrl(loginUrlForSupportReturn())
  // Authenticated: first name only. Guests / signed-out: "Hi there".
  const greetingName = user ? profile.first_name?.trim() || null : null
  const resolvedHeaderAvatars = headerAvatars?.length ? headerAvatars : teamAvatars

  if (visibility === 'hidden') return null

  const fieldClass =
    'mt-1.5 w-full rounded-xl border-0 bg-neutral-100/80 px-3.5 py-2.5 text-sm text-neutral-900 outline-none transition placeholder:text-neutral-400 focus:bg-white focus:ring-2 focus:ring-green-400/30 dark:bg-neutral-900 dark:text-neutral-50 dark:placeholder:text-neutral-500 dark:focus:bg-neutral-900 dark:focus:ring-teal-400/25'
  const primaryBtnClass =
    'flex w-full items-center justify-center gap-2 rounded-full bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-green-400 dark:text-neutral-950 dark:hover:bg-green-500'
  const rowClass =
    'group flex w-full items-center gap-3 px-3.5 py-3 text-left transition hover:bg-neutral-50 dark:hover:bg-white/[0.03]'

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex flex-col items-end gap-3">
      {open ? (
        <div
          className="pointer-events-auto flex h-[min(580px,calc(100dvh-6.5rem))] w-[min(372px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-[1.35rem] border border-black/5 bg-white shadow-[0_20px_50px_-24px_rgba(15,23,42,0.45)] dark:border-white/10 dark:bg-neutral-950 dark:shadow-black/50"
          role="dialog"
          aria-label={t.supportChat}
        >
          <header className="relative overflow-hidden px-4 pb-3.5 pt-3.5">
            <div
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_80%_at_0%_0%,rgba(74,222,128,0.16),transparent_55%),linear-gradient(180deg,#f8faf9_0%,#ffffff_100%)] dark:bg-[radial-gradient(120%_80%_at_0%_0%,rgba(45,212,191,0.12),transparent_55%),linear-gradient(180deg,#171717_0%,#0a0a0a_100%)]"
              aria-hidden
            />
            <div className="relative flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <HeaderAvatarStack avatars={resolvedHeaderAvatars} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
                    {t.title}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-60" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-400" />
                    </span>
                    {t.replyEta}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={close}
                className="rounded-full p-1.5 text-neutral-400 transition hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-100"
                aria-label={t.closeSupport}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'home' ? (
              <div className="space-y-5 px-4 pb-4 pt-1">
                <div>
                  <p className="text-[1.65rem] font-semibold leading-tight tracking-tight text-neutral-900 dark:text-neutral-50">
                    {greetingName
                      ? t.hiNamed.replace('{name}', greetingName)
                      : t.hiThere}
                  </p>
                  <p className="mt-1.5 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
                    {t.howCanWeHelp}
                  </p>
                </div>

                {authLoading ? (
                  <p className="text-sm text-neutral-500">{t.checkingSignIn}</p>
                ) : homePane === 'ticket-success' ? (
                  <div className="rounded-2xl bg-teal-50/80 px-4 py-5 text-center dark:bg-teal-950/30">
                    <CheckCircle2 className="mx-auto h-8 w-8 text-green-500 dark:text-teal-300" />
                    <p className="mt-3 text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                      {t.ticketCreated.replace(
                        '{number}',
                        String(createdTicketNumber ?? ''),
                      )}
                    </p>
                    <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                      {t.ticketEmailConfirm}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setHomePane('main')
                        setCreatedTicketNumber(null)
                      }}
                      className="mt-4 text-sm font-medium text-green-600 hover:underline dark:text-teal-300"
                    >
                      {t.backToHome}
                    </button>
                  </div>
                ) : homePane === 'ticket' ? (
                  <form
                    className="space-y-3"
                    onSubmit={e => {
                      e.preventDefault()
                      void submitTicket()
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setHomePane('main')
                        setError('')
                      }}
                      className="inline-flex items-center gap-1 text-xs font-medium text-neutral-500 transition hover:text-neutral-800 dark:hover:text-neutral-200"
                    >
                      <ArrowLeft className="h-3.5 w-3.5" />
                      {t.back}
                    </button>
                    <p className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                      {t.createTicket}
                    </p>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">
                      {t.ticketFollowUp}
                    </p>
                    <label className="block">
                      <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                        {t.ticketSubject}
                      </span>
                      <input
                        type="text"
                        value={ticketSubject}
                        onChange={e => setTicketSubject(e.target.value)}
                        maxLength={200}
                        className={fieldClass}
                        placeholder={t.ticketSubjectPlaceholder}
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                        {t.ticketDescription}
                      </span>
                      <textarea
                        value={ticketDescription}
                        onChange={e => setTicketDescription(e.target.value)}
                        rows={4}
                        className={`${fieldClass} resize-none`}
                        placeholder={t.ticketDescriptionPlaceholder}
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
                      className={primaryBtnClass}
                    >
                      {ticketSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      {t.submitTicket}
                    </button>
                  </form>
                ) : guestReady ? (
                  <div className="overflow-hidden rounded-2xl bg-neutral-50/90 dark:bg-white/[0.03]">
                    <button type="button" onClick={startMessage} className={rowClass}>
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-green-500 shadow-xs ring-1 ring-black/5 dark:bg-neutral-900 dark:text-teal-300 dark:ring-white/10">
                        <MessageCircle className="h-4 w-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-50">
                          {t.chatWithUs}
                        </span>
                        <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                          {t.chatWithUsHint}
                        </span>
                      </span>
                      <ChevronRight className="h-4 w-4 text-neutral-300 transition group-hover:text-neutral-500 dark:text-neutral-600" />
                    </button>
                    <div className="mx-3.5 h-px bg-neutral-200/70 dark:bg-white/5" />
                    <button type="button" onClick={openTicketPane} className={rowClass}>
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-green-500 shadow-xs ring-1 ring-black/5 dark:bg-neutral-900 dark:text-teal-300 dark:ring-white/10">
                        <Ticket className="h-4 w-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-50">
                          {t.createTicket}
                        </span>
                      </span>
                      <ChevronRight className="h-4 w-4 text-neutral-300 transition group-hover:text-neutral-500 dark:text-neutral-600" />
                    </button>
                  </div>
                ) : (
                  <form
                    className="space-y-3"
                    onSubmit={e => {
                      e.preventDefault()
                      finishGuestDetailsOnHome()
                    }}
                  >
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">
                      {t.guestPrompt}
                    </p>
                    <label className="block">
                      <span className="text-xs font-medium text-neutral-500">{t.name}</span>
                      <input
                        type="text"
                        value={guestName}
                        onChange={e => setGuestName(e.target.value)}
                        autoComplete="name"
                        className={fieldClass}
                        placeholder={t.namePlaceholder}
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-neutral-500">{t.email}</span>
                      <input
                        type="email"
                        value={guestEmail}
                        onChange={e => setGuestEmail(e.target.value)}
                        autoComplete="email"
                        className={fieldClass}
                        placeholder="you@example.com"
                      />
                    </label>
                    {error && tab === 'home' ? (
                      <p className="text-xs text-red-500">{error}</p>
                    ) : null}
                    <button type="submit" className={primaryBtnClass}>
                      {t.continue}
                    </button>
                    <p className="text-center text-xs text-neutral-500">
                      <a
                        href={loginHref}
                        className="font-medium text-neutral-700 underline-offset-2 hover:underline dark:text-neutral-300"
                      >
                        {t.preferSignIn}
                      </a>
                    </p>
                  </form>
                )}

                {guestReady && conversations.length > 0 ? (
                  <div>
                    <p className="mb-1.5 px-0.5 text-xs font-medium text-neutral-400">{t.recent}</p>
                    <ul className="overflow-hidden rounded-2xl bg-neutral-50/90 dark:bg-white/[0.03]">
                      {conversations.slice(0, 3).map((c, index) => (
                        <li key={c.id}>
                          {index > 0 ? (
                            <div className="mx-3.5 h-px bg-neutral-200/70 dark:bg-white/5" />
                          ) : null}
                          <button
                            type="button"
                            onClick={() => openConversation(c.id)}
                            className={rowClass}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center justify-between gap-2">
                                <span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">
                                  {c.subject?.trim() || t.supportChat}
                                </span>
                                <StatusDot status={c.status} t={t} />
                              </span>
                              <span className="mt-0.5 block truncate text-xs text-neutral-400">
                                {formatTime(c.last_message_at)}
                              </span>
                            </span>
                            <ChevronRight className="h-4 w-4 shrink-0 text-neutral-300 group-hover:text-neutral-500 dark:text-neutral-600" />
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
                    className="space-y-3 px-4 py-4"
                    onSubmit={e => {
                      e.preventDefault()
                      continueAsGuest()
                    }}
                  >
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">
                      {t.guestChatPrompt}
                    </p>
                    <input
                      type="text"
                      value={guestName}
                      onChange={e => setGuestName(e.target.value)}
                      autoComplete="name"
                      className={fieldClass}
                      placeholder={t.name}
                    />
                    <input
                      type="email"
                      value={guestEmail}
                      onChange={e => setGuestEmail(e.target.value)}
                      autoComplete="email"
                      className={fieldClass}
                      placeholder={t.email}
                    />
                    {error ? <p className="text-xs text-red-500">{error}</p> : null}
                    <button type="submit" className={primaryBtnClass}>
                      {t.continue}
                    </button>
                  </form>
                ) : (
                  <>
                    {!activeId && user && openConversations.length > 0 ? (
                      <ul className="space-y-0 px-3 py-2">
                        {conversations.map(c => (
                          <li key={c.id}>
                            <button
                              type="button"
                              onClick={() => openConversation(c.id)}
                              className="group flex w-full items-center gap-2 rounded-xl px-3 py-3 text-left transition hover:bg-neutral-50 dark:hover:bg-white/[0.03]"
                            >
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center justify-between gap-2 text-sm font-medium text-neutral-900 dark:text-neutral-50">
                                  <span className="truncate">
                                    {c.subject?.trim() || t.supportChat}
                                  </span>
                                  <StatusDot status={c.status} t={t} />
                                </span>
                                <span className="mt-0.5 block truncate text-xs text-neutral-400">
                                  {previewBody(messages, c.id, {
                                    youPrefix: t.youPrefix,
                                    supportPrefix: t.supportPrefix,
                                    noMessagesYet: t.noMessagesYet,
                                    sentAnImage: t.sentAnImage,
                                  }) || formatTime(c.last_message_at)}
                                </span>
                              </span>
                              <ChevronRight className="h-4 w-4 text-neutral-300 dark:text-neutral-600" />
                            </button>
                          </li>
                        ))}
                        <li className="px-1 pt-1">
                          <button
                            type="button"
                            onClick={() => {
                              setActiveId(null)
                              setMessages([])
                            }}
                            className="w-full rounded-full py-2.5 text-sm font-medium text-green-600 transition hover:bg-teal-50 dark:text-teal-300 dark:hover:bg-teal-950/40"
                          >
                            {t.newConversation}
                          </button>
                        </li>
                      </ul>
                    ) : (
                      <>
                        <div className="flex items-center justify-between gap-2 px-3 py-2">
                          <button
                            type="button"
                            onClick={() => {
                              setActiveId(null)
                              void refreshConversations()
                            }}
                            className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                          >
                            <ArrowLeft className="h-3.5 w-3.5" />
                            {t.allMessages}
                          </button>
                          {activeConversation && activeConversation.status === 'ai' ? (
                            <button
                              type="button"
                              disabled={sending}
                              onClick={() => void onEscalate()}
                              className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700 transition hover:bg-neutral-200 disabled:opacity-50 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
                            >
                              <UserRound className="h-3 w-3" aria-hidden />
                              {t.requestHuman}
                            </button>
                          ) : null}
                          {activeConversation?.status === 'queued' ? (
                            <span className="text-xs font-medium text-amber-600">
                              {t.waitingForAgent}
                            </span>
                          ) : null}
                          {activeConversation?.status === 'active' ? (
                            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-600 dark:text-teal-300">
                              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                              {activeConversation.assignee_id &&
                              agentProfiles[activeConversation.assignee_id]
                                ? t.agentConnectedNamed.replace(
                                    '{name}',
                                    agentProfiles[activeConversation.assignee_id]!.display_name,
                                  )
                                : t.agentConnected}
                            </span>
                          ) : null}
                        </div>
                        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2">
                          {loadingThread ? (
                            <p className="text-center text-xs text-neutral-400">{t.loading}</p>
                          ) : null}
                          {messages.map(m => {
                            if (m.sender_type === 'system') {
                              return (
                                <div
                                  key={m.id}
                                  className="mx-auto max-w-[95%] px-2 text-center text-xs leading-relaxed text-neutral-400"
                                >
                                  {m.body}
                                </div>
                              )
                            }
                            if (m.sender_type === 'user') {
                              return (
                                <div
                                  key={m.id}
                                  className="ml-auto max-w-[88%] rounded-2xl rounded-br-md bg-neutral-900 px-3.5 py-2 text-sm leading-relaxed text-white dark:bg-green-400 dark:text-neutral-950"
                                >
                                  {m.body &&
                                  !(m.images?.length && m.body === 'Shared an image')
                                    ? m.body
                                    : null}
                                  <MessageImages images={m.images} onUser />
                                  <span className="mt-1 block text-[10px] text-white/55 dark:text-neutral-800/65">
                                    {formatTime(m.created_at)}
                                  </span>
                                </div>
                              )
                            }

                            const agent =
                              (m.sender_user_id && agentProfiles[m.sender_user_id]) || null
                            const agentName =
                              agent?.display_name ||
                              (m.sender_type === 'ai' ? t.aiName : t.supportName)

                            return (
                              <div key={m.id} className="flex max-w-[92%] items-end gap-2">
                                <PersonAvatar
                                  name={agentName}
                                  src={agent?.avatar_url}
                                  size="sm"
                                  className="mb-0.5"
                                />
                                <div className="min-w-0 rounded-2xl rounded-bl-md bg-neutral-100 px-3.5 py-2 text-sm leading-relaxed text-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
                                  {m.sender_type === 'agent' ? (
                                    <p className="mb-0.5 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                                      {agentName}
                                    </p>
                                  ) : null}
                                  {m.body &&
                                  !(m.images?.length && m.body === 'Shared an image')
                                    ? m.body
                                    : null}
                                  <MessageImages images={m.images} />
                                  <span className="mt-1 block text-[10px] text-neutral-400">
                                    {formatTime(m.created_at)}
                                  </span>
                                </div>
                              </div>
                            )
                          })}
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
            <div className="px-3 pb-2 pt-1">
              {error ? <p className="mb-2 px-1 text-xs text-red-500">{error}</p> : null}
              {activeConversation?.status === 'resolved' ? (
                <p className="rounded-2xl bg-neutral-50 px-3 py-3 text-xs text-neutral-500 dark:bg-white/[0.03]">
                  {t.conversationResolved}
                </p>
              ) : (
                <form
                  className="space-y-2"
                  onSubmit={e => {
                    e.preventDefault()
                    void onSend()
                  }}
                >
                  {draftImages.length > 0 ? (
                    <div className="flex flex-wrap gap-2 px-1">
                      {draftImages.map((src, idx) => (
                        <div key={`${idx}-${src.slice(-12)}`} className="relative h-14 w-14 shrink-0">
                          <img
                            src={src}
                            alt=""
                            className="h-14 w-14 rounded-xl object-cover"
                          />
                          <button
                            type="button"
                            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900 text-white shadow-sm"
                            aria-label={t.removeImage}
                            onClick={() => setDraftImages(prev => prev.filter((_, i) => i !== idx))}
                            disabled={sending}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex items-end gap-1.5 rounded-2xl bg-neutral-100/90 p-1.5 dark:bg-neutral-900">
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
                      className="mb-0.5 rounded-full p-2 text-neutral-400 transition hover:bg-white hover:text-neutral-700 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                      aria-label={t.attachImage}
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
                      placeholder={t.writeMessage}
                      className="max-h-28 min-h-[40px] flex-1 resize-none bg-transparent px-1 py-2 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-50"
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
                      className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-800 disabled:opacity-35 dark:bg-green-400 dark:text-neutral-950 dark:hover:bg-green-500"
                      aria-label={t.send}
                    >
                      <Send className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </form>
              )}
            </div>
          ) : null}

          <nav className="flex gap-1 px-3 pb-3 pt-1">
            <button
              type="button"
              onClick={() => setTab('home')}
              className={clsx(
                'flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-[12px] font-medium transition',
                tab === 'home'
                  ? 'bg-neutral-900 text-white dark:bg-green-400 dark:text-neutral-950'
                  : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-900 dark:hover:text-neutral-200',
              )}
            >
              <Home className="h-3.5 w-3.5" />
              {t.home}
            </button>
            <button
              type="button"
              onClick={() => setTab('messages')}
              className={clsx(
                'flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-[12px] font-medium transition',
                tab === 'messages'
                  ? 'bg-neutral-900 text-white dark:bg-green-400 dark:text-neutral-950'
                  : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-900 dark:hover:text-neutral-200',
              )}
            >
              <MessageCircle className="h-3.5 w-3.5" />
              {t.messages}
            </button>
          </nav>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => (open ? close() : maximize())}
        className={clsx(
          'pointer-events-auto relative flex h-12 w-12 items-center justify-center rounded-full bg-green-400 text-neutral-950 shadow-lg shadow-green-900/20 transition hover:-translate-y-0.5 hover:bg-green-500',
          !open && 'hover:scale-[1.03]',
        )}
        aria-label={
          open
            ? t.closeSupportChat
            : unreadCount > 0
              ? t.openSupportUnread.replace('{count}', String(unreadCount))
              : t.openSupport
        }
      >
        {open ? (
          <X className="h-5 w-5" />
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
        {!open && unreadCount > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-neutral-900 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white dark:ring-neutral-950">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        ) : null}
      </button>
    </div>
  )
}
