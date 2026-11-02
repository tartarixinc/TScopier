import type { NavigateFunction } from 'react-router-dom'
import type { PendingClientAction } from './assistantClient'
import type { AssistantBrokerConnectPrefill } from './assistantBrokerConnect'

const NAV_ALLOWLIST = new Set([
  '/dashboard',
  '/copier-engine',
  '/brokers',
  '/account-configuration',
  '/channels',
  '/backtest',
  '/billing',
  '/contact-support',
  '/pricing',
  '/account-trades',
  '/copier-logs',
  '/reported-trades',
  '/activities',
  '/manage-signals',
])

/** Legacy assistant paths → real routes (avoid /:referralCode catch-all → signup). */
function normalizeNavPath(path: string): string {
  if (path === '/account-config' || path === '/account-configuration') return '/brokers'
  return path
}

export type AssistantActionHandlers = {
  navigate: NavigateFunction
  openAddTradingAccount: () => void
  openLiveChat: () => void
  refreshProfile: () => Promise<void> | void
  startTelegramLinkFlow?: () => void
  startBrokerConnectFlow?: (prefill?: AssistantBrokerConnectPrefill | null) => void
  requestConfigureBroker?: (brokerId: string) => void
}

function prefillFromAction(action: PendingClientAction): AssistantBrokerConnectPrefill {
  const args = action.args ?? {}
  const platform = args.platform === 'MT4' || args.platform === 'MT5' ? args.platform : undefined
  return {
    platform,
    account_login: args.account_login != null ? String(args.account_login) : undefined,
    broker_server: args.broker_server != null ? String(args.broker_server) : undefined,
    label: args.label != null ? String(args.label) : undefined,
  }
}

/** Run allowlisted client-side actions returned by the assistant. */
export function runPendingClientActions(
  actions: PendingClientAction[],
  handlers: AssistantActionHandlers,
): string[] {
  const notes: string[] = []
  for (const action of actions) {
    switch (action.type) {
      case 'open_connect_broker':
      case 'start_broker_connect':
        if (handlers.startBrokerConnectFlow) {
          handlers.startBrokerConnectFlow(prefillFromAction(action))
          notes.push('Started in-chat broker connect')
        } else {
          handlers.openAddTradingAccount()
          notes.push('Opened connect broker')
        }
        break
      case 'start_telegram_link':
        handlers.startTelegramLinkFlow?.()
        notes.push('Started in-chat Telegram link')
        break
      case 'open_telegram_link': {
        if (handlers.startTelegramLinkFlow) {
          handlers.startTelegramLinkFlow()
          notes.push('Started in-chat Telegram link')
        } else {
          const path = String(action.args?.path ?? '/copier-engine')
          if (NAV_ALLOWLIST.has(path)) handlers.navigate(path)
          else handlers.navigate('/copier-engine')
          notes.push('Opened Copier Process for Telegram link')
        }
        break
      }
      case 'navigate': {
        const raw = String(action.args?.path ?? '')
        const path = normalizeNavPath(raw)
        if (NAV_ALLOWLIST.has(path) || NAV_ALLOWLIST.has(raw)) {
          handlers.navigate(path)
          notes.push(`Navigated to ${path}`)
        }
        break
      }
      case 'open_live_chat':
        handlers.openLiveChat()
        notes.push('Opened live chat')
        break
      case 'open_broker_config':
      case 'propose_config_change': {
        const brokerId = String(action.args?.broker_account_id ?? '').trim()
        if (brokerId && handlers.requestConfigureBroker) {
          handlers.requestConfigureBroker(brokerId)
          notes.push(action.summary || 'Opened broker configuration')
        } else {
          handlers.navigate('/brokers')
          notes.push(action.summary || 'Opened Brokers configuration')
        }
        break
      }
      default:
        break
    }
  }
  return notes
}

export function isNavigatePathAllowed(path: string): boolean {
  const normalized = normalizeNavPath(path)
  return NAV_ALLOWLIST.has(normalized) || NAV_ALLOWLIST.has(path)
}
