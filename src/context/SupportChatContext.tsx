import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import {
  SupportWidget,
  type SupportWidgetIntent,
  type SupportWidgetVisibility,
} from '../components/support/SupportWidget'

type SupportChatContextValue = {
  visibility: SupportWidgetVisibility
  openSupportWidget: () => void
  openTicketForm: () => void
  /** @deprecated Prefer openSupportWidget — kept for assistant handoff aliases */
  openLiveChat: () => void
}

const SupportChatContext = createContext<SupportChatContextValue | null>(null)

export function SupportChatProvider({ children }: { children: ReactNode }) {
  const [visibility, setVisibility] = useState<SupportWidgetVisibility>('minimized')
  const [intent, setIntent] = useState<SupportWidgetIntent>(null)

  const openSupportWidget = useCallback(() => {
    setVisibility('maximized')
  }, [])

  const openTicketForm = useCallback(() => {
    setIntent('ticket')
    setVisibility('maximized')
  }, [])

  const onIntentConsumed = useCallback(() => {
    setIntent(null)
  }, [])

  return (
    <SupportChatContext.Provider
      value={{
        visibility,
        openSupportWidget,
        openTicketForm,
        openLiveChat: openSupportWidget,
      }}
    >
      <SupportWidget
        visibility={visibility}
        onVisibilityChanged={setVisibility}
        intent={intent}
        onIntentConsumed={onIntentConsumed}
      />
      {children}
    </SupportChatContext.Provider>
  )
}

export function useSupportChat(): SupportChatContextValue {
  const ctx = useContext(SupportChatContext)
  if (!ctx) {
    throw new Error('useSupportChat must be used within SupportChatProvider')
  }
  return ctx
}

/** Compatibility alias while callers migrate from LiveChat naming. */
export function useLiveChat(): SupportChatContextValue {
  return useSupportChat()
}
