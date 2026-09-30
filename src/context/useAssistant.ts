import { createContext, useContext } from 'react'
import type {
  AssistantChatMessage,
  AssistantThread,
  PendingClientAction,
  PendingConfirmation,
} from '../lib/assistantClient'
import type {
  AssistantTelegramLinkState,
} from '../lib/assistantTelegramLink'
import type {
  AssistantBrokerConnectPrefill,
  AssistantBrokerConnectState,
} from '../lib/assistantBrokerConnect'

export type AssistantContextValue = {
  open: boolean
  openAssistant: () => void
  closeAssistant: () => void
  messages: AssistantChatMessage[]
  pendingConfirmations: PendingConfirmation[]
  setPendingConfirmations: React.Dispatch<React.SetStateAction<PendingConfirmation[]>>
  pendingClientActions: PendingClientAction[]
  setPendingClientActions: React.Dispatch<React.SetStateAction<PendingClientAction[]>>
  persistMessages: (
    next: AssistantChatMessage[] | ((prev: AssistantChatMessage[]) => AssistantChatMessage[]),
    ownerThreadId?: string,
  ) => string | null
  /** When set, the panel auto-sends this message on next render then clears it. */
  pendingAutoSend: string | null
  setPendingAutoSend: React.Dispatch<React.SetStateAction<string | null>>
  telegramLink: AssistantTelegramLinkState
  setTelegramLink: React.Dispatch<React.SetStateAction<AssistantTelegramLinkState>>
  startTelegramLinkFlow: () => void
  resetTelegramLinkFlow: () => void
  brokerConnect: AssistantBrokerConnectState
  setBrokerConnect: React.Dispatch<React.SetStateAction<AssistantBrokerConnectState>>
  startBrokerConnectFlow: (prefill?: AssistantBrokerConnectPrefill | null) => void
  resetBrokerConnectFlow: () => void
  threads: AssistantThread[]
  activeThreadId: string | null
  getActiveThreadId: () => string | null
  switchThread: (id: string) => void
  startNewThread: () => void
  deleteThread: (id: string) => void
}

export const AssistantContext = createContext<AssistantContextValue | null>(null)

export function useAssistant(): AssistantContextValue {
  const ctx = useContext(AssistantContext)
  if (!ctx) throw new Error('useAssistant must be used within AssistantProvider')
  return ctx
}
