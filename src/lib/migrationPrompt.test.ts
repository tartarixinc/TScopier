import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BrokerAccount } from '../types/database'
import {
  isMigrationPromptSnoozed,
  isMigrationSwitchCase,
  isPromptDismissible,
  pickPromptBroker,
  resolveReconnectDialog,
  routeReconnectError,
  snoozeMigrationPrompt,
} from './migrationPrompt'

function broker(overrides: Partial<BrokerAccount> & { id: string }): BrokerAccount {
  return {
    label: 'Test account',
    platform: 'MT5',
    provider: 'fxsocket',
    is_active: true,
    connection_status: 'connected',
    ...overrides,
  } as BrokerAccount
}

const needsReconnect = [
  broker({ id: 'a', provider: 'mtapi', mtapi_status: null }),
  broker({ id: 'b' }),
]

describe('pickPromptBroker', () => {
  it('picks the first account that needs reconnecting', () => {
    expect(pickPromptBroker(needsReconnect, new Set())?.id).toBe('a')
  })

  it('skips paused accounts — they are not copying anything', () => {
    const list = [
      broker({ id: 'paused', is_active: false }),
      broker({ id: 'live' }),
    ]
    expect(pickPromptBroker(list, new Set())?.id).toBe('live')
  })

  it('skips an account whose reconnect is already in flight', () => {
    expect(pickPromptBroker(needsReconnect, new Set(['a']))?.id).toBe('b')
  })

  it('returns null when nothing needs reconnecting', () => {
    expect(pickPromptBroker([], new Set())).toBeNull()
  })

  it('returns null when every candidate is paused or in flight', () => {
    expect(pickPromptBroker(needsReconnect, new Set(['a', 'b']))).toBeNull()
  })
})

describe('isPromptDismissible', () => {
  it('refuses to close while the shown account needs reconnecting', () => {
    expect(isPromptDismissible(needsReconnect, needsReconnect[0])).toBe(false)
  })

  it('allows closing a dialog the customer opened for an account that is fine', () => {
    const manual = broker({ id: 'manual', connection_status: 'error' })
    expect(isPromptDismissible(needsReconnect, manual)).toBe(true)
  })

  it('is false when no account is shown', () => {
    expect(isPromptDismissible(needsReconnect, null)).toBe(false)
  })

  it('allows closing a failed attempt on a paused account — it copies nothing', () => {
    const paused = broker({ id: 'paused-err', is_active: false, connection_status: 'error' })
    expect(isPromptDismissible([paused], paused)).toBe(true)
  })
})

describe('isMigrationSwitchCase', () => {
  it('is the migration case for an MTAPI row that has never connected', () => {
    expect(isMigrationSwitchCase(broker({ id: 'm', provider: 'mtapi', mtapi_status: null }))).toBe(true)
  })

  it('is not the migration case once MTAPI has reported a status', () => {
    expect(isMigrationSwitchCase(broker({ id: 'm', provider: 'mtapi', mtapi_status: 'connected' }))).toBe(false)
    expect(isMigrationSwitchCase(broker({ id: 'm', provider: 'mtapi', mtapi_status: 'error' }))).toBe(false)
  })

  it('is not the migration case for an ordinary FxSocket account', () => {
    expect(isMigrationSwitchCase(broker({ id: 'f', provider: 'fxsocket' }))).toBe(false)
    expect(isMigrationSwitchCase(null)).toBe(false)
  })
})

describe('routeReconnectError', () => {
  it('shows the message in the dialog even when the page has its own handler', () => {
    // Regression: the prompt covers the page and cannot be dismissed, so a
    // message routed only to the page banner was invisible — the reconnect
    // failure looked like nothing had happened at all.
    const dialog: string[] = []
    const page: string[] = []
    routeReconnectError('MTAPI connect failed: 503', {
      dialog: message => dialog.push(message),
      page: message => page.push(message),
    })
    expect(dialog).toEqual(['MTAPI connect failed: 503'])
    expect(page).toEqual(['MTAPI connect failed: 503'])
  })

  it('shows the message in the dialog when no page handler is registered', () => {
    const dialog: string[] = []
    routeReconnectError('Broker request timed out', {
      dialog: message => dialog.push(message),
    })
    expect(dialog).toEqual(['Broker request timed out'])
  })

  it('tolerates an explicitly null page handler', () => {
    const dialog: string[] = []
    routeReconnectError('Unauthorized', { dialog: message => dialog.push(message), page: null })
    expect(dialog).toEqual(['Unauthorized'])
  })
})

describe('resolveReconnectDialog', () => {
  const none = {
    passwordPrompt: null,
    success: null,
    inflight: null,
    errorAnchor: null,
    migrationPrompt: null,
  }
  const a = broker({ id: 'a' })
  const b = broker({ id: 'b' })
  const c = broker({ id: 'c' })
  const d = broker({ id: 'd' })
  const e = broker({ id: 'e' })

  it('shows the password prompt above everything else', () => {
    expect(resolveReconnectDialog({
      ...none,
      passwordPrompt: a,
      success: b,
      inflight: c,
      errorAnchor: d,
      migrationPrompt: e,
    })).toEqual({ active: a, stage: 'password' })
  })

  it('confirms a success before any in-flight or failed attempt', () => {
    expect(resolveReconnectDialog({
      ...none,
      success: a,
      inflight: b,
      errorAnchor: c,
      migrationPrompt: d,
    })).toEqual({ active: a, stage: 'success' })
  })

  it('stays on the account still waiting for the bridge instead of advancing', () => {
    expect(resolveReconnectDialog({
      ...none,
      inflight: a,
      errorAnchor: b,
      migrationPrompt: c,
    })).toEqual({ active: a, stage: 'connecting' })
  })

  it('keeps a failed attempt on screen even when its row is off the needs-reconnect list', () => {
    expect(resolveReconnectDialog({
      ...none,
      errorAnchor: a,
      migrationPrompt: b,
    })).toEqual({ active: a, stage: 'details' })
  })

  it('falls through to the automatic prompt for the next account', () => {
    expect(resolveReconnectDialog({ ...none, migrationPrompt: a }))
      .toEqual({ active: a, stage: 'details' })
  })

  it('resolves to a closed dialog when nothing is active', () => {
    expect(resolveReconnectDialog(none)).toEqual({ active: null, stage: 'details' })
  })
})

describe('migration prompt snooze ("Remind me later")', () => {
  const store = new Map<string, string>()

  beforeAll(() => {
    ;(globalThis as unknown as { window?: unknown }).window = {
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value) },
      },
    }
  })
  afterAll(() => {
    delete (globalThis as unknown as { window?: unknown }).window
    store.clear()
  })

  it('postpones one account without touching the others', () => {
    expect(isMigrationPromptSnoozed('account-a')).toBe(false)
    snoozeMigrationPrompt('account-a')
    expect(isMigrationPromptSnoozed('account-a')).toBe(true)
    expect(isMigrationPromptSnoozed('account-b')).toBe(false)
  })
})
