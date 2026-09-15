import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { BrokerAccountsProvider } from '../../context/BrokerAccountsContext'
import { NotificationsProvider } from '../../context/NotificationsContext'
import { HumanReviewProvider } from '../../context/HumanReviewContext'
import { AddTradingAccountProvider } from '../../context/AddTradingAccountContext'
import { PendingBrokerConnectionSync } from '../broker/PendingBrokerConnectionSync'
import { BrokerTerminalHealthSync } from '../broker/BrokerTerminalHealthSync'
import { AppLayout } from './AppLayout'
import { LiveChatProvider } from '../../context/LiveChatContext'
import { AssistantProvider } from '../../context/AssistantContext'
import { useAssistant } from '../../context/useAssistant'
import { AssistantPanel } from '../assistant/AssistantPanel'
import { AssistantLauncher, type AssistantLauncherPosition } from '../assistant/AssistantLauncher'
import { HumanReviewModal } from '../dashboard/HumanReviewModal'
import { useNeedsWelcome } from '../../hooks/useNeedsWelcome'

const WelcomeModal = lazy(() =>
  import('../onboarding/WelcomeModal').then(m => ({ default: m.WelcomeModal })),
)

const UpdatesAnnouncementModal = lazy(() =>
  import('../updates/UpdatesAnnouncementModal').then(m => ({ default: m.UpdatesAnnouncementModal })),
)

const LAUNCHER_VISIBLE_STORAGE_KEY = 'tscopier-assistant-launcher-visible'
const LAUNCHER_MINIMIZED_STORAGE_KEY = 'tscopier-assistant-launcher-collapsed'
const LAUNCHER_POSITION_STORAGE_KEY = 'tscopier-assistant-launcher-position'

function readSessionBoolean(key: string, fallback: boolean) {
  if (typeof window === 'undefined') return fallback
  const stored = window.sessionStorage.getItem(key)
  if (stored === null) return fallback
  return stored === 'true'
}

function readLauncherPosition(): AssistantLauncherPosition | null {
  if (typeof window === 'undefined') return null
  const stored = window.sessionStorage.getItem(LAUNCHER_POSITION_STORAGE_KEY)
  if (!stored) return null
  try {
    const parsed = JSON.parse(stored) as Partial<AssistantLauncherPosition>
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null
    return { x: parsed.x, y: parsed.y }
  } catch {
    return null
  }
}

type AssistantSurfaceProps = {
  launcherVisible: boolean
  launcherMinimized: boolean
  launcherPosition: AssistantLauncherPosition | null
  deferAppBootstrap: boolean
  needsWelcome: boolean
  onLauncherVisibleChange: (visible: boolean) => void
  onLauncherMinimizedChange: (minimized: boolean) => void
  onLauncherPositionChange: (position: AssistantLauncherPosition) => void
}

function AssistantSurface({
  launcherVisible,
  launcherMinimized,
  launcherPosition,
  deferAppBootstrap,
  needsWelcome,
  onLauncherVisibleChange,
  onLauncherMinimizedChange,
  onLauncherPositionChange,
}: AssistantSurfaceProps) {
  const { open, openAssistant } = useAssistant()
  const wasAssistantOpenRef = useRef(open)

  const handleAssistantTrigger = useCallback(() => {
    openAssistant()
  }, [openAssistant])

  useEffect(() => {
    if (wasAssistantOpenRef.current && !open) {
      onLauncherVisibleChange(true)
      onLauncherMinimizedChange(true)
    }
    wasAssistantOpenRef.current = open
  }, [open, onLauncherMinimizedChange, onLauncherVisibleChange])

  return (
    <>
      <AppLayout onAssistantTrigger={handleAssistantTrigger} />
      <AssistantLauncher
        visible={launcherVisible}
        minimized={launcherMinimized}
        position={launcherPosition}
        onVisibleChange={onLauncherVisibleChange}
        onMinimizedChange={onLauncherMinimizedChange}
        onPositionChange={onLauncherPositionChange}
      />
      <AssistantPanel />
      {!deferAppBootstrap ? <HumanReviewModal /> : null}
      {needsWelcome ? (
        <Suspense fallback={null}>
          <WelcomeModal />
        </Suspense>
      ) : null}
      {!deferAppBootstrap && !needsWelcome ? (
        <Suspense fallback={null}>
          <UpdatesAnnouncementModal />
        </Suspense>
      ) : null}
    </>
  )
}

/** Authenticated app shell: shared broker state + dashboard layout. */
export function AppShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const { needsWelcome, deferAppBootstrap } = useNeedsWelcome()
  const [assistantLauncherVisible, setAssistantLauncherVisible] = useState(() =>
    readSessionBoolean(LAUNCHER_VISIBLE_STORAGE_KEY, true),
  )
  const [assistantLauncherMinimized, setAssistantLauncherMinimized] = useState(() =>
    readSessionBoolean(LAUNCHER_MINIMIZED_STORAGE_KEY, false),
  )
  const [assistantLauncherPosition, setAssistantLauncherPosition] = useState<AssistantLauncherPosition | null>(
    readLauncherPosition,
  )
  const onDashboardRoute =
    location.pathname === '/dashboard' || location.pathname.startsWith('/dashboard/broker/')

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.sessionStorage.setItem(LAUNCHER_VISIBLE_STORAGE_KEY, String(assistantLauncherVisible))
  }, [assistantLauncherVisible])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.sessionStorage.setItem(LAUNCHER_MINIMIZED_STORAGE_KEY, String(assistantLauncherMinimized))
  }, [assistantLauncherMinimized])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!assistantLauncherPosition) {
      window.sessionStorage.removeItem(LAUNCHER_POSITION_STORAGE_KEY)
      return
    }
    window.sessionStorage.setItem(
      LAUNCHER_POSITION_STORAGE_KEY,
      JSON.stringify(assistantLauncherPosition),
    )
  }, [assistantLauncherPosition])

  useEffect(() => {
    if (needsWelcome && !onDashboardRoute) {
      navigate('/dashboard', { replace: true })
    }
  }, [needsWelcome, onDashboardRoute, navigate])

  return (
    <BrokerAccountsProvider enabled={!deferAppBootstrap}>
      {!deferAppBootstrap ? <PendingBrokerConnectionSync /> : null}
      {!deferAppBootstrap ? <BrokerTerminalHealthSync /> : null}
      <NotificationsProvider enabled={!deferAppBootstrap}>
        <HumanReviewProvider enabled={!deferAppBootstrap}>
          <AddTradingAccountProvider>
            <LiveChatProvider>
              <AssistantProvider>
                <AssistantSurface
                  launcherVisible={assistantLauncherVisible}
                  launcherMinimized={assistantLauncherMinimized}
                  launcherPosition={assistantLauncherPosition}
                  deferAppBootstrap={deferAppBootstrap}
                  needsWelcome={needsWelcome}
                  onLauncherVisibleChange={setAssistantLauncherVisible}
                  onLauncherMinimizedChange={setAssistantLauncherMinimized}
                  onLauncherPositionChange={setAssistantLauncherPosition}
                />
              </AssistantProvider>
            </LiveChatProvider>
          </AddTradingAccountProvider>
        </HumanReviewProvider>
      </NotificationsProvider>
    </BrokerAccountsProvider>
  )
}
