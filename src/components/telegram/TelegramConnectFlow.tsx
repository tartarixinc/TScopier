import { type FormEvent } from 'react'
import clsx from 'clsx'
import { Check, Smartphone, KeyRound, ListPlus, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { Card } from '../ui/Card'
import { Button } from '../ui/Button'
import { Alert } from '../ui/Alert'
import { Input } from '../ui/Input'

export type TelegramConnectStage = 'idle' | 'phone' | 'code' | 'twoFa'

interface TelegramConnectFlowProps {
  stage: TelegramConnectStage
  onStageChange: (stage: TelegramConnectStage) => void
  phone: string
  onPhoneChange: (value: string) => void
  code: string
  onCodeChange: (value: string) => void
  password: string
  onPasswordChange: (value: string) => void
  loading: boolean
  error: string
  onSendCode: (e: FormEvent) => void
  onVerifyCode: (e: FormEvent) => void
}

const STEPS = [
  { id: 'phone' as const, icon: Smartphone },
  { id: 'code' as const, icon: KeyRound },
  { id: 'twoFa' as const, icon: ShieldCheck },
  { id: 'channels' as const, icon: ListPlus },
]

function stepIndex(stage: TelegramConnectStage): number {
  if (stage === 'idle') return 0
  if (stage === 'phone') return 1
  if (stage === 'code') return 2
  if (stage === 'twoFa') return 3
  return 0
}

export function TelegramConnectFlow({
  stage,
  onStageChange,
  phone,
  onPhoneChange,
  code,
  onCodeChange,
  password,
  onPasswordChange,
  loading,
  error,
  onSendCode,
  onVerifyCode,
}: TelegramConnectFlowProps) {
  const t = useT()
  const ce = t.copierEnginePage
  const activeStep = stepIndex(stage)

  const stepLabels = [ce.tgConnectStepPhone, ce.tgConnectStepCode, ce.tgConnectStepTwoFa, ce.tgConnectStepChannels]
  const howItWorks = [ce.tgConnectHowItWorks1, ce.tgConnectHowItWorks2, ce.tgConnectHowItWorks3]

  return (
    <Card className="mb-4 overflow-hidden" padding="none">
      <div className="relative px-5 pt-6 pb-5 sm:px-6 sm:pt-7 bg-gradient-to-br from-[#229ED9]/12 via-sky-50/90 to-white dark:from-[#229ED9]/20 dark:via-sky-950/30 dark:to-neutral-900 border-b border-neutral-100 dark:border-neutral-800">
        <div className="flex flex-col items-center text-center max-w-md mx-auto">
          <div className="w-14 h-14 rounded-2xl bg-white dark:bg-neutral-800 shadow-md border border-neutral-100 dark:border-neutral-700 flex items-center justify-center mb-3">
            <img src="/Telegram.svg" alt="" className="w-8 h-8 object-contain" loading="lazy" aria-hidden />
          </div>
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
            {stage === 'phone'
              ? ce.tgConnectPhoneTitle
              : stage === 'code'
                ? ce.tgConnectCodeTitle
                : stage === 'twoFa'
                  ? ce.tgConnectTwoFaTitle
                  : ce.tgConnectHeroTitle}
          </h2>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            {stage === 'phone'
              ? ce.tgConnectPhoneSubtitle
              : stage === 'code'
                ? ce.tgConnectCodeSubtitle
                : stage === 'twoFa'
                  ? ce.tgConnectTwoFaSubtitle
                  : ce.tgConnectHeroSubtitle}
          </p>
        </div>

        <ol className="mt-6 flex items-center justify-center gap-0 max-w-sm mx-auto" aria-label={ce.tgConnectStepsAria}>
          {STEPS.map((step, i) => {
            const done = i < activeStep
            const current = i === activeStep
            const Icon = step.icon
            return (
              <li key={step.id} className="flex items-center flex-1 last:flex-none">
                <div className="flex flex-col items-center gap-1.5 min-w-0">
                  <span
                    className={clsx(
                      'w-9 h-9 rounded-full flex items-center justify-center border-2 transition-colors',
                      done && 'bg-teal-600 border-teal-600 text-white',
                      current && !done && 'bg-white dark:bg-neutral-800 border-teal-600 text-teal-600',
                      !done && !current && 'bg-neutral-100 dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700 text-neutral-400',
                    )}
                  >
                    {done ? <Check className="w-4 h-4" strokeWidth={2.5} /> : <Icon className="w-4 h-4" />}
                  </span>
                  <span
                    className={clsx(
                      'text-[10px] sm:text-xs font-medium truncate max-w-[4.5rem] sm:max-w-none text-center',
                      current ? 'text-teal-700 dark:text-teal-400' : done ? 'text-neutral-600 dark:text-neutral-300' : 'text-neutral-400',
                    )}
                  >
                    {stepLabels[i]}
                  </span>
                </div>
                {i < STEPS.length - 1 && (
                  <div
                    className={clsx(
                      'h-0.5 flex-1 mx-1 sm:mx-2 mb-5 rounded-full transition-colors',
                      i < activeStep ? 'bg-teal-500' : 'bg-neutral-200 dark:bg-neutral-700',
                    )}
                    aria-hidden
                  />
                )}
              </li>
            )
          })}
        </ol>
      </div>

      <div className="px-5 py-5 sm:px-6 sm:py-6 max-w-md mx-auto">
        {stage === 'idle' && (
          <ul className="space-y-2.5 mb-5">
            {howItWorks.map((line, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm text-neutral-600 dark:text-neutral-300">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary-100 dark:bg-primary-900/50 text-primary-700 dark:text-primary-300 text-xs font-semibold flex items-center justify-center mt-0.5">
                  {i + 1}
                </span>
                {line}
              </li>
            ))}
          </ul>
        )}

        {(stage === 'phone' || stage === 'code' || stage === 'twoFa') && (
          <div className="mb-4 px-3 py-2.5 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/80 dark:border-amber-900/50 rounded-xl flex items-start gap-2.5">
            <TriangleAlert className="w-4 h-4 text-amber-600 dark:text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800 dark:text-amber-200/90 leading-relaxed">{ce.tgConnectPhoneWarning}</p>
          </div>
        )}

        {error && <Alert className="mb-4">{error}</Alert>}

        {stage === 'idle' && (
          <Button size="lg" className="w-full" onClick={() => onStageChange('phone')}>
            <img src="/Telegram.svg" alt="" className="w-5 h-5 object-contain" loading="lazy" aria-hidden />
            {ce.connectTelegram}
          </Button>
        )}

        {stage === 'phone' && (
          <form onSubmit={onSendCode} className="space-y-4">
            <Input
              label={ce.phoneLabel}
              type="tel"
              placeholder={ce.phonePlaceholder}
              value={phone}
              onChange={e => onPhoneChange(e.target.value)}
              hint={ce.phoneHint}
              required
              autoFocus
            />
            <Button type="submit" loading={loading} size="lg" className="w-full">
              {ce.sendCode}
            </Button>
            <Button type="button" variant="ghost" className="w-full" onClick={() => onStageChange('idle')}>
              {ce.cancelConnect}
            </Button>
          </form>
        )}

        {stage === 'code' && (
          <form onSubmit={onVerifyCode} className="space-y-4">
            <Input
              label={ce.verificationCode}
              placeholder={ce.verificationPlaceholder}
              value={code}
              onChange={e => onCodeChange(e.target.value)}
              hint={interpolate(ce.sentTo, { phone })}
              required
              autoFocus
            />
            <Button type="submit" loading={loading} size="lg" className="w-full">
              {ce.verify}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => onStageChange('phone')}
            >
              {ce.useDifferentNumber}
            </Button>
          </form>
        )}

        {stage === 'twoFa' && (
          <form onSubmit={onVerifyCode} className="space-y-4">
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 px-4 py-3">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{ce.verificationCode}</p>
              <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50 mt-0.5 font-mono tracking-wide">
                {code || '—'}
              </p>
              <p className="text-xs text-neutral-400 mt-1">{interpolate(ce.sentTo, { phone })}</p>
            </div>
            <Input
              label={ce.twoFaPassword}
              type="password"
              placeholder={ce.twoFaPlaceholder}
              value={password}
              onChange={e => onPasswordChange(e.target.value)}
              hint={ce.twoFaRequired}
              required
              autoFocus
            />
            <Button type="submit" loading={loading} size="lg" className="w-full">
              {ce.verify}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => onStageChange('code')}
            >
              {ce.backToVerificationCode}
            </Button>
          </form>
        )}
      </div>
    </Card>
  )
}
