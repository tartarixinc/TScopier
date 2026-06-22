import type { BrokerFailureMode } from './brokerFailureModes'

/** Load-test scenario — happy path or a specific failure class. */
export type LoadScenario =
  | 'happy'
  | 'heuristic_reject'
  | 'parse_skip'
  | 'not_eligible'
  | 'broker_session_down'
  | 'broker_order_fail'
  | 'broker_ws_down'

export const LOAD_SCENARIOS: LoadScenario[] = [
  'happy',
  'heuristic_reject',
  'parse_skip',
  'not_eligible',
  'broker_session_down',
  'broker_order_fail',
  'broker_ws_down',
]

/** Default mixed fleet: ~60% happy, rest spread across failure modes. */
export function scenarioForSignalIndex(index: number): LoadScenario {
  const mod = index % 100
  if (mod < 60) return 'happy'
  if (mod < 68) return 'heuristic_reject'
  if (mod < 76) return 'parse_skip'
  if (mod < 84) return 'not_eligible'
  if (mod < 90) return 'broker_session_down'
  if (mod < 96) return 'broker_order_fail'
  return 'broker_ws_down'
}

export function scenarioForProfile(
  index: number,
  profile: 'happy' | 'mixed' | 'unhappy',
): LoadScenario {
  if (profile === 'happy') return 'happy'
  if (profile === 'unhappy') {
    const unhappy = LOAD_SCENARIOS.filter(s => s !== 'happy')
    return unhappy[index % unhappy.length]!
  }
  return scenarioForSignalIndex(index)
}

/** Telegram samples that stop at known pipeline stages (non-happy path). */
export const NON_HAPPY_TELEGRAM_MESSAGES: Record<
  Exclude<LoadScenario, 'happy' | 'broker_session_down' | 'broker_order_fail' | 'broker_ws_down'>,
  string
> = {
  heuristic_reject: 'Good morning traders, enjoy your weekend!',
  parse_skip: 'BUY XAUUSD @ 4500',
  not_eligible: 'BUY EURUSD NOW SL 1.0850 TP 1.0900 — we are 5 pips short of tp2',
}

export function brokerFailureForScenario(scenario: LoadScenario): BrokerFailureMode {
  switch (scenario) {
    case 'broker_session_down':
      return 'fxsocket_session_down'
    case 'broker_order_fail':
      return 'fxsocket_order_send_fail'
    case 'broker_ws_down':
      return 'fxsocket_ws_disconnected'
    default:
      return 'none'
  }
}

export function scenarioLabel(scenario: LoadScenario): string {
  switch (scenario) {
    case 'happy':
      return 'Happy path (full Telegram → OrderSend)'
    case 'heuristic_reject':
      return 'Heuristic reject (casual chat, not a signal)'
    case 'parse_skip':
      return 'Parse skip (trade-like text, missing NOW/SL/TP structure)'
    case 'not_eligible':
      return 'Not eligible (commentary / structure guard)'
    case 'broker_session_down':
      return 'FxSocket session down (keepSessionAlive / heartbeat failed)'
    case 'broker_order_fail':
      return 'FxSocket REST OrderSend error'
    case 'broker_ws_down':
      return 'FxSocket WebSocket disconnected (live stream path)'
    default:
      return scenario
  }
}
