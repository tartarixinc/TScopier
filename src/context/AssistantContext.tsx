import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAuth } from './AuthContext'
import {
  assistantThreadTitle,
  createAssistantThreadId,
  loadAssistantThreads,
  loadDeletedThreadIds,
  MAX_THREADS,
  saveAssistantThreads,
  saveDeletedThreadIds,
  type AssistantChatMessage,
  type AssistantThread,
  type PendingClientAction,
  type PendingConfirmation,
} from '../lib/assistantClient'
import {
  deleteAssistantThread,
  listAssistantThreads,
  mergeThreadStates,
  newAssistantThread,
  upsertAssistantThread,
} from '../lib/assistantThreadsApi'
import {
  INITIAL_TELEGRAM_LINK_STATE,
  type AssistantTelegramLinkState,
} from '../lib/assistantTelegramLink'
import {
  brokerConnectFromPrefill,
  INITIAL_BROKER_CONNECT_STATE,
  type AssistantBrokerConnectPrefill,
  type AssistantBrokerConnectState,
} from '../lib/assistantBrokerConnect'
import { AssistantContext } from './useAssistant'

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const [open, setOpen] = useState(false)
  const [pendingAutoSend, setPendingAutoSend] = useState<string | null>(null)
  const [messages, setMessages] = useState<AssistantChatMessage[]>(() => {
    if (!userId) return []
    const { activeThreadId, threads } = loadAssistantThreads(userId)
    return threads.find(t => t.id === activeThreadId)?.messages ?? []
  })
  const [threads, setThreads] = useState<AssistantThread[]>(() =>
    userId ? loadAssistantThreads(userId).threads : [],
  )
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() =>
    userId ? loadAssistantThreads(userId).activeThreadId : null,
  )
  const [pendingConfirmations, setPendingConfirmations] = useState<PendingConfirmation[]>([])
  const [pendingClientActions, setPendingClientActions] = useState<PendingClientAction[]>([])
  const [telegramLink, setTelegramLink] = useState<AssistantTelegramLinkState>(INITIAL_TELEGRAM_LINK_STATE)
  const [brokerConnect, setBrokerConnect] = useState<AssistantBrokerConnectState>(
    INITIAL_BROKER_CONNECT_STATE,
  )

  const threadsRef = useRef<AssistantThread[]>(threads)
  const activeThreadIdRef = useRef<string | null>(activeThreadId)
  const deletedIdsRef = useRef<Set<string>>(new Set())

  const syncActiveThread = useCallback((id: string | null) => {
    setActiveThreadId(id)
    activeThreadIdRef.current = id
  }, [])

  // DB is the source of truth; sessionStorage is a cache + offline fallback.
  const syncThreadToDb = useCallback(
    (thread: AssistantThread) => {
      if (!userId) return
      void upsertAssistantThread(userId, thread).catch(() => {})
    },
    [userId],
  )

  const removeThreadFromDb = useCallback(
    (threadId: string) => {
      if (!userId) return
      void deleteAssistantThread(userId, threadId)
        .then(() => {
          deletedIdsRef.current.delete(threadId)
          saveDeletedThreadIds(userId, deletedIdsRef.current)
        })
        .catch(() => {})
    },
    [userId],
  )

  // Load this user's persisted tombstone set (survives reloads for offline deletes).
  useEffect(() => {
    deletedIdsRef.current = userId ? loadDeletedThreadIds(userId) : new Set()
  }, [userId])

  // Pull threads from the DB and reconcile with the local cache: merge by id
  // preferring the newer version, upload local-only / newer local threads,
  // re-issue deletes for tombstones, and drop tombstoned entries. Also called
  // when connectivity returns so offline edits to existing threads are not lost.
  const syncThreadsFromDb = useCallback(() => {
    if (!userId) {
      // Defer the reset out of the synchronous effect body (lint: set-state-in-effect).
      queueMicrotask(() => {
        setThreads([])
        threadsRef.current = []
        syncActiveThread(null)
        setMessages([])
      })
      return
    }
    void (async () => {
      // Snapshot the live in-memory state (not re-read sessionStorage) so a sync
      // racing an in-flight persistMessages doesn't fall back to a stale copy.
      const local = { threads: threadsRef.current, activeThreadId: activeThreadIdRef.current }
      const applyThreads = (next: AssistantThread[], preferred: string | null) => {
        const threads = next.filter(t => !deletedIdsRef.current.has(t.id))
        const activeThreadId = threads.some(t => t.id === preferred)
          ? preferred
          : (threads[0]?.id ?? null)
        setThreads(threads)
        threadsRef.current = threads
        syncActiveThread(activeThreadId)
        const target = threads.find(t => t.id === activeThreadId) ?? threads[0]
        setMessages(target?.messages ?? [])
        saveAssistantThreads(userId, { threads, activeThreadId })
      }
      try {
        const dbThreads = await listAssistantThreads(userId)
        const tombstoned = [...deletedIdsRef.current]
        for (const id of tombstoned) {
          if (dbThreads.some(t => t.id === id)) {
            void deleteAssistantThread(userId, id)
              .then(() => {
                deletedIdsRef.current.delete(id)
                saveDeletedThreadIds(userId, deletedIdsRef.current)
              })
              .catch(() => {})
          }
        }
        const merged = mergeThreadStates(dbThreads, local.threads, activeThreadIdRef.current)
        applyThreads(merged.threads, merged.activeThreadId)
        const dbById = new Map(dbThreads.map(t => [t.id, t]))
        for (const thread of local.threads) {
          if (deletedIdsRef.current.has(thread.id)) continue
          if (thread.messages.length === 0) continue
          const dbRow = dbById.get(thread.id)
          if (!dbRow || thread.updatedAt > dbRow.updatedAt) {
            void upsertAssistantThread(userId, thread).catch(() => {})
          }
        }
      } catch {
        // Offline or DB error — keep the sessionStorage cache as-is.
        applyThreads(local.threads, local.activeThreadId)
      }
    })()
  }, [userId, syncActiveThread])

  useEffect(() => {
    syncThreadsFromDb()
    if (typeof window === 'undefined') return
    const onOnline = () => syncThreadsFromDb()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [syncThreadsFromDb])

  const resetTelegramLinkFlow = useCallback(() => {
    setTelegramLink(INITIAL_TELEGRAM_LINK_STATE)
  }, [])

  const startTelegramLinkFlow = useCallback(() => {
    setBrokerConnect(INITIAL_BROKER_CONNECT_STATE)
    setTelegramLink({
      ...INITIAL_TELEGRAM_LINK_STATE,
      stage: 'phone',
    })
  }, [])

  const resetBrokerConnectFlow = useCallback(() => {
    setBrokerConnect(INITIAL_BROKER_CONNECT_STATE)
  }, [])

  const startBrokerConnectFlow = useCallback((prefill?: AssistantBrokerConnectPrefill | null) => {
    setTelegramLink(INITIAL_TELEGRAM_LINK_STATE)
    setBrokerConnect(brokerConnectFromPrefill(prefill))
  }, [])

  const openAssistant = useCallback(() => {
    if (userId) {
      const state = loadAssistantThreads(userId)
      const target = state.threads.find(t => t.id === state.activeThreadId) ?? state.threads[0] ?? null
      setThreads(state.threads)
      threadsRef.current = state.threads
      syncActiveThread(target?.id ?? null)
      setMessages(target?.messages ?? [])
    }
    setOpen(true)
  }, [userId, syncActiveThread])

  const closeAssistant = useCallback(() => setOpen(false), [])

  const persistMessages = useCallback(
    (
      next: AssistantChatMessage[] | ((prev: AssistantChatMessage[]) => AssistantChatMessage[]),
      ownerThreadId?: string,
    ): string | null => {
      if (!userId) return null
      const targetId = ownerThreadId ?? activeThreadIdRef.current
      const now = Date.now()
      if (!targetId) {
        if (Array.isArray(next) && next.length === 0) return null
        const id = createAssistantThreadId()
        const resolved = typeof next === 'function' ? next([]) : next
        const thread: AssistantThread = {
          id,
          title: assistantThreadTitle(resolved),
          createdAt: now,
          updatedAt: now,
          messages: resolved,
        }
        const updated = [thread, ...threadsRef.current]
        setThreads(updated)
        threadsRef.current = updated
        syncActiveThread(id)
        setMessages(resolved)
        saveAssistantThreads(userId, { threads: updated, activeThreadId: id })
        syncThreadToDb(thread)
        return id
      }
      const prev = threadsRef.current.find(t => t.id === targetId)?.messages ?? []
      const resolved = typeof next === 'function' ? next(prev) : next
      const updated = threadsRef.current.map(t =>
        t.id === targetId ? { ...t, messages: resolved, updatedAt: now } : t,
      )
      setThreads(updated)
      threadsRef.current = updated
      if (activeThreadIdRef.current === targetId) setMessages(resolved)
      saveAssistantThreads(userId, { threads: updated, activeThreadId: activeThreadIdRef.current })
      const updatedThread = updated.find(t => t.id === targetId)
      if (updatedThread) syncThreadToDb(updatedThread)
      return targetId
    },
    [userId, syncActiveThread, syncThreadToDb],
  )

  const switchThread = useCallback(
    (id: string) => {
      if (!userId || id === activeThreadIdRef.current) return
      const thread = threadsRef.current.find(t => t.id === id)
      if (!thread) return
      syncActiveThread(id)
      setMessages(thread.messages)
      setPendingConfirmations([])
      setPendingClientActions([])
      saveAssistantThreads(userId, { threads: threadsRef.current, activeThreadId: id })
    },
    [userId, syncActiveThread],
  )

  const startNewThread = useCallback(() => {
    if (!userId) return
    const thread = newAssistantThread()
    const updated = [thread, ...threadsRef.current].slice(0, MAX_THREADS)
    setThreads(updated)
    threadsRef.current = updated
    syncActiveThread(thread.id)
    setMessages([])
    setPendingConfirmations([])
    setPendingClientActions([])
    // Local-only until the first real message is persisted, so an unused "New
    // chat" never occupies a DB slot (which would evict an older real thread at
    // the 8-thread cap). persistMessages upserts it once it has messages.
    saveAssistantThreads(userId, { threads: updated, activeThreadId: thread.id })
  }, [userId, syncActiveThread])

  const deleteThread = useCallback(
    (id: string) => {
      if (!userId) return
      deletedIdsRef.current.add(id)
      saveDeletedThreadIds(userId, deletedIdsRef.current)
      const updated = threadsRef.current.filter(t => t.id !== id)
      setThreads(updated)
      threadsRef.current = updated
      if (activeThreadIdRef.current === id) {
        const next = updated[0]?.id ?? null
        syncActiveThread(next)
        setMessages(updated[0]?.messages ?? [])
        setPendingConfirmations([])
        setPendingClientActions([])
      }
      saveAssistantThreads(userId, { threads: updated, activeThreadId: activeThreadIdRef.current })
      removeThreadFromDb(id)
    },
    [userId, syncActiveThread, removeThreadFromDb],
  )

  const getActiveThreadId = useCallback(() => activeThreadIdRef.current, [])

  const value = useMemo(
    () => ({
      open,
      openAssistant,
      closeAssistant,
      messages,
      pendingConfirmations,
      setPendingConfirmations,
      pendingClientActions,
      setPendingClientActions,
      persistMessages,
      pendingAutoSend,
      setPendingAutoSend,
      telegramLink,
      setTelegramLink,
      startTelegramLinkFlow,
      resetTelegramLinkFlow,
      brokerConnect,
      setBrokerConnect,
      startBrokerConnectFlow,
      resetBrokerConnectFlow,
      threads,
      activeThreadId,
      getActiveThreadId,
      switchThread,
      startNewThread,
      deleteThread,
    }),
    [
      open,
      openAssistant,
      closeAssistant,
      messages,
      pendingConfirmations,
      pendingClientActions,
      persistMessages,
      pendingAutoSend,
      telegramLink,
      startTelegramLinkFlow,
      resetTelegramLinkFlow,
      brokerConnect,
      startBrokerConnectFlow,
      resetBrokerConnectFlow,
      threads,
      activeThreadId,
      getActiveThreadId,
      switchThread,
      startNewThread,
      deleteThread,
    ],
  )

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>
}
