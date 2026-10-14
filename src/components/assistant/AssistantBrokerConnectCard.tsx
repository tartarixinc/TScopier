import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '../ui/Button'
import { PasswordInput } from '../auth/PasswordInput'
import clsx from 'clsx'

export type AssistantBrokerConnectCopy = {
  title: string
  hint: string
  platformLabel: string
  loginLabel: string
  serverLabel: string
  labelLabel: string
  passwordLabel: string
  passwordPlaceholder: string
  connect: string
  cancel: string
  openFullForm: string
  missingFields: string
}

type Props = {
  platform: 'MT4' | 'MT5'
  accountLogin: string
  brokerServer: string
  label: string
  error: string
  busy: boolean
  copy: AssistantBrokerConnectCopy
  onConnect: (values: {
    platform: 'MT4' | 'MT5'
    account_login: string
    broker_server: string
    label: string
    password: string
  }) => void | Promise<void>
  onCancel: () => void
  onOpenFullForm?: () => void
}

export function AssistantBrokerConnectCard({
  platform: initialPlatform,
  accountLogin,
  brokerServer,
  label: initialLabel,
  error,
  busy,
  copy,
  onConnect,
  onCancel,
  onOpenFullForm,
}: Props) {
  const [platform, setPlatform] = useState<'MT4' | 'MT5'>(initialPlatform)
  const [login, setLogin] = useState(accountLogin)
  const [server, setServer] = useState(brokerServer)
  const [label, setLabel] = useState(initialLabel)
  const [password, setPassword] = useState('')
  const [localError, setLocalError] = useState('')

  const displayError = localError || error

  const submit = () => {
    setLocalError('')
    if (!login.trim() || !server.trim() || !password) {
      setLocalError(copy.missingFields)
      return
    }
    void onConnect({
      platform,
      account_login: login.trim(),
      broker_server: server.trim(),
      label: label.trim(),
      password,
    })
  }

  return (
    <div
      className={clsx(
        'animate-assistant-msg-in ms-[2.375rem] rounded-2xl border border-teal-200/80 bg-white p-3.5 shadow-sm',
        'dark:border-teal-900/50 dark:bg-neutral-900',
      )}
    >
      <p className="text-[13.5px] font-semibold text-neutral-900 dark:text-neutral-50">{copy.title}</p>
      <p className="mt-1 text-xs leading-relaxed text-neutral-900 dark:text-neutral-50">{copy.hint}</p>

      <div className="mt-3 space-y-2">
        <label className="block text-xs text-neutral-900 dark:text-neutral-50">
          {copy.platformLabel}
          <select
            value={platform}
            disabled={busy}
            onChange={e => setPlatform(e.target.value === 'MT4' ? 'MT4' : 'MT5')}
            className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          >
            <option value="MT5">MT5</option>
            <option value="MT4">MT4</option>
          </select>
        </label>
        <label className="block text-xs text-neutral-900 dark:text-neutral-50">
          {copy.loginLabel}
          <input
            value={login}
            disabled={busy}
            onChange={e => setLogin(e.target.value)}
            className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          />
        </label>
        <label className="block text-xs text-neutral-900 dark:text-neutral-50">
          {copy.serverLabel}
          <input
            value={server}
            disabled={busy}
            onChange={e => setServer(e.target.value)}
            className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          />
        </label>
        <label className="block text-xs text-neutral-900 dark:text-neutral-50">
          {copy.labelLabel}
          <input
            value={label}
            disabled={busy}
            onChange={e => setLabel(e.target.value)}
            className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          />
        </label>
        <label className="block text-xs text-neutral-900 dark:text-neutral-50">
          {copy.passwordLabel}
          <div className="mt-1">
            <PasswordInput
              value={password}
              disabled={busy}
              placeholder={copy.passwordPlaceholder}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submit()
                }
              }}
            />
          </div>
        </label>
      </div>

      {displayError ? (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{displayError}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {copy.connect}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {copy.cancel}
        </Button>
      </div>

      {onOpenFullForm ? (
        <button
          type="button"
          className="mt-2 text-xs text-green-500 underline-offset-2 hover:underline dark:text-teal-300"
          disabled={busy}
          onClick={onOpenFullForm}
        >
          {copy.openFullForm}
        </button>
      ) : null}
    </div>
  )
}
