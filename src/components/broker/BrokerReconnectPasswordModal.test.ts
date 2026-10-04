// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrokerReconnectPasswordModal } from './BrokerReconnectPasswordModal'
import type { BrokerAccount } from '../../types/database'

// Tells React that act() may flush work in this process (React 18 requirement).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ModalProps = Parameters<typeof BrokerReconnectPasswordModal>[0]

const copy = {
  title: 'We have updated how TScopier connects to your broker',
  body: 'Reconnect this account to keep copying trades.',
  passwordLabel: 'MT account password',
  passwordHint: 'Sent to MT servers only.',
  passwordPlaceholder: 'Trading account password',
  rememberPasswordLabel: 'Remember password',
  rememberPasswordHint: 'Stores an encrypted copy.',
  detailLogin: 'Login',
  detailServer: 'Server',
  reconnect: 'Reconnect',
  cancel: 'Cancel',
  back: 'Back',
  successAction: 'Next account',
}

const broker = {
  id: 'broker-1',
  label: 'Exness Demo',
  platform: 'MT5',
  account_login: '436990470',
  broker_server: 'Exness-MT5Trial9',
} as BrokerAccount

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(props: Partial<ModalProps>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(createElement(BrokerReconnectPasswordModal, {
      open: true,
      broker,
      stage: 'details',
      copy,
      onSubmit: () => {},
      onCancel: () => {},
      ...props,
    } as ModalProps))
  })
}

function pressEscape() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

function clickBackdrop() {
  const dialog = document.querySelector('[role="dialog"]') as HTMLElement
  const overlay = dialog.parentElement as HTMLElement
  const backdrop = overlay.querySelector('[aria-hidden="true"]') as HTMLElement
  act(() => {
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function buttonByLabel(label: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll('button')).find(
    b => b.textContent?.trim() === label,
  ) ?? null) as HTMLButtonElement | null
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  document.body.innerHTML = ''
  root = null
  container = null
})

describe('BrokerReconnectPasswordModal — not dismissible (automatic prompt)', () => {
  it('shows the account and the Reconnect button on the details stage', () => {
    render({ dismissible: false })
    expect(document.body.textContent).toContain('We have updated how TScopier connects to your broker')
    expect(document.body.textContent).toContain('Exness Demo')
    expect(document.body.textContent).toContain('436990470')
    expect(document.body.textContent).toContain('Exness-MT5Trial9')
    expect(buttonByLabel('Reconnect')).not.toBeNull()
  })

  it('has no close button and no Cancel button', () => {
    render({ dismissible: false })
    expect(document.querySelector('[aria-label="Cancel"]')).toBeNull()
    expect(buttonByLabel('Cancel')).toBeNull()
  })

  it('ignores Escape', () => {
    const onCancel = vi.fn()
    render({ dismissible: false, onCancel })
    pressEscape()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('ignores a backdrop click', () => {
    const onCancel = vi.fn()
    render({ dismissible: false, onCancel })
    clickBackdrop()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('does not ask for a password on the details stage', () => {
    render({ dismissible: false, stage: 'details' })
    expect(document.getElementById('broker-reconnect-password')).toBeNull()
  })
})

describe('BrokerReconnectPasswordModal — dismissible (dialog the customer opened)', () => {
  it('offers close, Cancel and Escape', () => {
    const onCancel = vi.fn()
    render({ dismissible: true, onCancel })

    expect(document.querySelector('[aria-label="Cancel"]')).not.toBeNull()
    buttonByLabel('Cancel')?.click()
    expect(onCancel).toHaveBeenCalledTimes(1)

    pressEscape()
    expect(onCancel).toHaveBeenCalledTimes(2)

    clickBackdrop()
    expect(onCancel).toHaveBeenCalledTimes(3)
  })
})

describe('BrokerReconnectPasswordModal — password stage', () => {
  it('asks for the password and submits it', () => {
    const onSubmit = vi.fn()
    render({ stage: 'password', dismissible: false, onSubmit })

    const input = document.getElementById('broker-reconnect-password') as HTMLInputElement
    expect(input).not.toBeNull()

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'hunter2')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const form = input.closest('form') as HTMLFormElement
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onSubmit).toHaveBeenCalledWith({ password: 'hunter2', rememberPassword: true })
  })

  it('keeps a Back button that returns to the details stage', () => {
    const onBack = vi.fn()
    render({ stage: 'password', dismissible: false, onBack })
    buttonByLabel('Back')?.click()
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('offers no Back button when the caller does not provide one', () => {
    render({ stage: 'password', dismissible: true })
    expect(buttonByLabel('Back')).toBeNull()
  })

  it('shows a reconnect failure instead of hiding it', () => {
    render({ stage: 'details', dismissible: false, error: 'Wrong password for this account' })
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('Wrong password for this account')
  })
})

describe('BrokerReconnectPasswordModal — connecting stage', () => {
  it('shows the waiting message exactly once with no form and no buttons', () => {
    const waiting = 'Sign-in accepted. Waiting for the broker bridge — this can take a moment.'
    render({
      stage: 'connecting',
      dismissible: false,
      copy: { ...copy, title: 'Connecting your account', body: waiting },
    })
    // Exactly once: the header carries the message, nothing repeats it below.
    expect(document.body.textContent?.split(waiting).length - 1).toBe(1)
    expect(document.querySelector('[role="status"]')).not.toBeNull()
    expect(document.getElementById('broker-reconnect-password')).toBeNull()
    expect(buttonByLabel('Reconnect')).toBeNull()
    expect(buttonByLabel('Cancel')).toBeNull()
  })

  it('refuses dismissal even when the caller passes dismissible=true', () => {
    const onCancel = vi.fn()
    render({ stage: 'connecting', dismissible: true, onCancel })
    expect(document.querySelector('[aria-label="Cancel"]')).toBeNull()
    expect(buttonByLabel('Cancel')).toBeNull()
    pressEscape()
    clickBackdrop()
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('BrokerReconnectPasswordModal — success stage', () => {
  it('confirms the connection exactly once and continues on the action button', () => {
    const confirmation = 'Connected. Copying resumes automatically.'
    const onContinue = vi.fn()
    render({
      stage: 'success',
      dismissible: false,
      onContinue,
      copy: { ...copy, title: 'Account connected', body: confirmation },
    })
    expect(document.body.textContent?.split(confirmation).length - 1).toBe(1)
    expect(document.querySelector('[role="status"]')).not.toBeNull()
    buttonByLabel('Next account')?.click()
    expect(onContinue).toHaveBeenCalledTimes(1)
  })
})

describe('BrokerReconnectPasswordModal — remind later and delete', () => {
  const escapeCopy = {
    ...copy,
    remindLater: 'Remind me later',
    deleteAccountLink: "I can't reconnect — delete this account",
    deleteConfirmTitle: 'Delete this account?',
    deleteConfirmBody: 'This removes the account and its history.',
    deleteConfirmNote: 'This cannot be undone.',
    deleteConfirmCta: 'Delete account',
  }

  it('offers Remind me later exactly once and calls it', () => {
    const onRemindLater = vi.fn()
    render({ stage: 'details', copy: escapeCopy, onRemindLater })
    expect(document.body.textContent?.split('Remind me later').length - 1).toBe(1)
    buttonByLabel('Remind me later')?.click()
    expect(onRemindLater).toHaveBeenCalledTimes(1)
  })

  it('offers the escape hatches once on the password stage and not while connecting', () => {
    render({ stage: 'password', copy: escapeCopy, onRemindLater: vi.fn(), onDeleteAccount: vi.fn() })
    expect(document.body.textContent?.split('Remind me later').length - 1).toBe(1)
    expect(document.body.textContent?.split("I can't reconnect").length - 1).toBe(1)
    act(() => root?.unmount())
    container?.remove()
    document.body.innerHTML = ''
    root = null
    container = null
    render({ stage: 'connecting', copy: escapeCopy, onRemindLater: vi.fn(), onDeleteAccount: vi.fn() })
    expect(document.body.textContent).not.toContain('Remind me later')
    expect(document.body.textContent).not.toContain("I can't reconnect")
  })

  it('deletes only after the confirmation step', () => {
    const onDeleteAccount = vi.fn()
    render({ stage: 'details', copy: escapeCopy, onDeleteAccount })
    // The link alone must not delete anything.
    act(() => { buttonByLabel("I can't reconnect — delete this account")?.click() })
    expect(onDeleteAccount).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Delete this account?')
    expect(document.body.textContent).toContain('This cannot be undone.')
    // Cancel backs out without deleting.
    act(() => { buttonByLabel('Cancel')?.click() })
    expect(onDeleteAccount).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Delete this account?')
    // The red button performs it.
    act(() => { buttonByLabel("I can't reconnect — delete this account")?.click() })
    act(() => { buttonByLabel('Delete account')?.click() })
    expect(onDeleteAccount).toHaveBeenCalledTimes(1)
  })
})

describe('BrokerReconnectPasswordModal — multi-account hint', () => {
  const hint = '3 accounts need reconnecting. You will be asked for the password once for each one.'

  it('tells the customer they will be asked once per account (details stage)', () => {
    render({ stage: 'details', copy: { ...copy, hint } })
    expect(document.body.textContent).toContain(hint)
    expect(document.body.textContent).toContain('Reconnect this account to keep copying trades.')
  })

  it('shows the same warning above the password field', () => {
    render({ stage: 'password', copy: { ...copy, hint } })
    expect(document.body.textContent).toContain(hint)
    expect(document.getElementById('broker-reconnect-password')).not.toBeNull()
  })

  it('stays quiet when only one account is queued (no hint supplied)', () => {
    render({ stage: 'details' })
    expect(document.body.textContent).not.toContain('accounts need reconnecting')
    expect(document.body.textContent).not.toContain('once for each one')
  })
})
