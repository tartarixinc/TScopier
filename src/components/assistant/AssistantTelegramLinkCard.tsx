import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '../ui/Button'
import type { AssistantTelegramLinkStage } from '../../lib/assistantTelegramLink'
import {
  isPlausibleTelegramPhone,
  normalizeTelegramCodeInput,
  normalizeTelegramPhoneInput,
} from '../../lib/telegramPhone'
import clsx from 'clsx'

export type AssistantTelegramLinkCopy = {
  phoneTitle: string
  phoneHint: string
  phonePlaceholder: string
  sendCode: string
  codeTitle: string
  codeHint: string
  codePlaceholder: string
  verifyCode: string
  twoFaTitle: string
  twoFaHint: string
  twoFaPlaceholder: string
  submitPassword: string
  cancel: string
  restart: string
  openQrInstead: string
  invalidPhone: string
}

type Props = {
  stage: Exclude<AssistantTelegramLinkStage, 'idle' | 'done'>
  phone: string
  error: string
  busy: boolean
  copy: AssistantTelegramLinkCopy
  onSendCode: (phone: string) => void | Promise<void>
  onVerifyCode: (code: string) => void | Promise<void>
  onSubmitPassword: (password: string) => void | Promise<void>
  onCancel: () => void
  onRestart: () => void
  onOpenQr?: () => void
}

export function AssistantTelegramLinkCard({
  stage,
  phone,
  error,
  busy,
  copy,
  onSendCode,
  onVerifyCode,
  onSubmitPassword,
  onCancel,
  onRestart,
  onOpenQr,
}: Props) {
  const [phoneDraft, setPhoneDraft] = useState(phone || '')
  const [codeDraft, setCodeDraft] = useState('')
  const [passwordDraft, setPasswordDraft] = useState('')
  const [localError, setLocalError] = useState('')

  const displayError = localError || error

  const title =
    stage === 'phone' ? copy.phoneTitle : stage === 'code' ? copy.codeTitle : copy.twoFaTitle
  const hint =
    stage === 'phone' ? copy.phoneHint : stage === 'code' ? copy.codeHint : copy.twoFaHint

  const submit = () => {
    setLocalError('')
    if (stage === 'phone') {
      const next = normalizeTelegramPhoneInput(phoneDraft)
      if (!isPlausibleTelegramPhone(next)) {
        setLocalError(copy.invalidPhone)
        return
      }
      void onSendCode(next)
      return
    }
    if (stage === 'code') {
      const code = normalizeTelegramCodeInput(codeDraft)
      if (code.length < 4) return
      void onVerifyCode(code)
      return
    }
    if (!passwordDraft.trim()) return
    void onSubmitPassword(passwordDraft)
  }

  return (
    <div
      className={clsx(
        'animate-assistant-msg-in ms-[2.375rem] rounded-2xl border border-teal-200/80 bg-white p-3.5 shadow-sm',
        'dark:border-teal-900/50 dark:bg-neutral-900',
      )}
    >
      <p className="text-[13.5px] font-semibold text-neutral-900 dark:text-neutral-50">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{hint}</p>

      {stage === 'phone' ? (
        <input
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          value={phoneDraft}
          onChange={e => setPhoneDraft(e.target.value)}
          placeholder={copy.phonePlaceholder}
          disabled={busy}
          className="mt-3 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />
      ) : null}

      {stage === 'code' ? (
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={codeDraft}
          onChange={e => setCodeDraft(normalizeTelegramCodeInput(e.target.value))}
          placeholder={copy.codePlaceholder}
          disabled={busy}
          className="mt-3 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm tracking-widest outline-none focus:border-green-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />
      ) : null}

      {stage === 'twoFa' ? (
        <input
          type="password"
          autoComplete="current-password"
          value={passwordDraft}
          onChange={e => setPasswordDraft(e.target.value)}
          placeholder={copy.twoFaPlaceholder}
          disabled={busy}
          className="mt-3 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />
      ) : null}

      {displayError ? (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{displayError}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {stage === 'phone'
            ? copy.sendCode
            : stage === 'code'
              ? copy.verifyCode
              : copy.submitPassword}
        </Button>
        {stage !== 'phone' ? (
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onRestart}>
            {copy.restart}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {copy.cancel}
        </Button>
      </div>

      {stage === 'phone' && onOpenQr ? (
        <button
          type="button"
          className="mt-2 text-xs text-green-500 underline-offset-2 hover:underline dark:text-teal-300"
          disabled={busy}
          onClick={onOpenQr}
        >
          {copy.openQrInstead}
        </button>
      ) : null}
    </div>
  )
}
