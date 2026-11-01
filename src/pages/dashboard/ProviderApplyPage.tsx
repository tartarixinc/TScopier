import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, Clock, Plus, XCircle } from 'lucide-react'
import clsx from 'clsx'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { AccountKindBadge } from '../../components/social/AccountKindBadge'
import { ProviderShareCard } from '../../components/social/ProviderShareCard'
import { SocialBrandIcon } from '../../components/social/SocialProfileLinks'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { useAddTradingAccount } from '../../context/AddTradingAccountContext'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useUserProfile } from '../../context/UserProfileContext'
import { useProviderApplication } from '../../hooks/useProviderApplication'
import { resolveAccountLogin } from '../../lib/brokerFromServer'
import { platformIconSrc } from '../../lib/activityRoute'
import {
  PROVIDER_BIO_MAX,
  PROVIDER_INELIGIBILITY_COPY,
  formatAccountAmount,
  priceInputToCents,
  providerAccountIneligibility,
  snapshotFreshness,
  validateProviderStep,
  type ProviderAccountKind,
  type ProviderDraft,
  type ProviderStep,
} from '../../lib/providerApplication'
import {
  brokerConnectionLabel,
  maskBrokerAccountIdentifier,
  resolveSocialAccountMode,
  socialBrokerDisplayLabel,
} from '../../lib/socialAccount'
import { SOCIAL_PROFILE_PLATFORMS, validateSocialProfileLinks } from '../../lib/socialProfileLinks'
import type { BrokerAccount } from '../../types/database'

const STEP_TITLES: Record<ProviderStep, string> = {
  1: 'Account',
  2: 'Price & access',
  3: 'Social profiles',
  4: 'Review',
}

const TERMS = [
  'My balance, equity, account type and platform are shown publicly on my provider profile.',
  'My closed-trade performance is published and cannot be edited by me.',
  'An administrator reviews my application and may suspend my profile at any time.',
  'Followers copy at their own risk; TScopier does not guarantee any results.',
]

function Stepper({ step, onJump, maxStep }: { step: ProviderStep; onJump: (s: ProviderStep) => void; maxStep: ProviderStep }) {
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Application steps">
      {([1, 2, 3, 4] as ProviderStep[]).map(value => (
        <li key={value}>
          <button
            type="button"
            disabled={value > maxStep}
            onClick={() => onJump(value)}
            aria-current={value === step ? 'step' : undefined}
            className={clsx(
              'flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed',
              value === step
                ? 'border-green-400 bg-green-50 font-semibold text-neutral-900 dark:bg-green-950/30 dark:text-neutral-50'
                : 'border-neutral-200 text-neutral-600 hover:border-neutral-300 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300',
            )}
          >
            <span className={clsx(
              'flex h-5 w-5 items-center justify-center rounded-full text-xs',
              value < step ? 'bg-green-400 text-neutral-950' : 'bg-neutral-100 dark:bg-neutral-800',
            )}>
              {value < step ? '\u2713' : value}
            </span>
            {STEP_TITLES[value]}
          </button>
        </li>
      ))}
    </ol>
  )
}

function AccountCard({
  account, selected, onSelect,
}: { account: BrokerAccount; selected: boolean; onSelect: () => void }) {
  const problem = providerAccountIneligibility(account)
  const mode = resolveSocialAccountMode(account)
  const icon = platformIconSrc(account.platform ?? '')
  const freshness = snapshotFreshness(account.last_synced_at)
  return (
    <button
      type="button"
      disabled={problem != null}
      onClick={onSelect}
      aria-pressed={selected}
      className={clsx(
        'w-full rounded-xl border p-4 text-start transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        selected
          ? 'border-green-400 bg-green-50/60 dark:bg-green-950/20'
          : 'border-neutral-200 bg-white hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {icon && <img src={icon} alt="" className="h-7 w-7 shrink-0 object-contain" />}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{socialBrokerDisplayLabel(account)}</p>
            <p className="truncate text-xs text-neutral-600 dark:text-neutral-400">
              {(account.platform ?? '').toUpperCase()} · {maskBrokerAccountIdentifier(resolveAccountLogin(account))} · {brokerConnectionLabel(account)}
            </p>
          </div>
        </div>
        <AccountKindBadge kind={mode} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-neutral-600 dark:text-neutral-400">Balance</dt>
          <dd className="font-semibold text-neutral-900 dark:text-neutral-50">{formatAccountAmount(account.last_balance, account.last_currency)}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-600 dark:text-neutral-400">Equity</dt>
          <dd className="font-semibold text-neutral-900 dark:text-neutral-50">{formatAccountAmount(account.last_equity, account.last_currency)}</dd>
        </div>
      </dl>
      {freshness === 'stale' && !problem && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Last synced a while ago — values will refresh when the account reconnects.</p>
      )}
      {problem && <p className="mt-2 text-xs text-error-600">{PROVIDER_INELIGIBILITY_COPY[problem]}</p>}
    </button>
  )
}

function AccountStep({
  draft, setDraft,
}: { draft: ProviderDraft; setDraft: (patch: Partial<ProviderDraft>) => void }) {
  const { brokers, loading, loadError } = useBrokerAccounts()
  const { openAddTradingAccount } = useAddTradingAccount()
  const sorted = useMemo(() => brokers.slice().sort((a, b) => {
    const ae = providerAccountIneligibility(a) == null ? 0 : 1
    const be = providerAccountIneligibility(b) == null ? 0 : 1
    return ae - be
  }), [brokers])

  const select = (account: BrokerAccount) => {
    const mode = resolveSocialAccountMode(account)
    setDraft({
      brokerAccountId: account.id,
      accountKind: draft.accountKind === 'prop' ? 'prop' : mode === 'demo' || mode === 'live' ? mode : null,
    })
  }

  const kinds: { value: ProviderAccountKind; label: string }[] = [
    { value: 'demo', label: 'Demo' }, { value: 'live', label: 'Live' }, { value: 'prop', label: 'Prop firm' },
  ]
  const selectedAccount = brokers.find(account => account.id === draft.brokerAccountId) ?? null
  const detected = selectedAccount ? resolveSocialAccountMode(selectedAccount) : 'unknown'

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">Which account should people copy?</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          We read the balance, equity, currency and platform directly from your connected account.
        </p>
      </div>
      {loadError && <Alert variant="error">{loadError}</Alert>}
      {loading && !brokers.length ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">Loading your accounts…</p>
      ) : sorted.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-6 text-center dark:border-neutral-700">
          <p className="text-sm text-neutral-700 dark:text-neutral-300">You have no trading accounts connected yet.</p>
          <Button className="mt-3" size="sm" onClick={() => openAddTradingAccount({ asCopySource: true })}>
            <Plus className="h-4 w-4" /> Connect an account
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {sorted.map(account => (
            <AccountCard key={account.id} account={account} selected={draft.brokerAccountId === account.id} onSelect={() => select(account)} />
          ))}
        </div>
      )}

      {selectedAccount && (
        <fieldset className="space-y-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <legend className="px-1 text-sm font-semibold text-neutral-900 dark:text-neutral-50">Account type</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Account type">
            {kinds.map(kind => {
              const disabled = kind.value !== 'prop' && detected !== 'unknown' && kind.value !== detected
              return (
                <button
                  key={kind.value}
                  type="button"
                  role="radio"
                  aria-checked={draft.accountKind === kind.value}
                  disabled={disabled}
                  onClick={() => setDraft({ accountKind: kind.value })}
                  className={clsx(
                    'rounded-full border px-4 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                    draft.accountKind === kind.value
                      ? 'border-green-400 bg-green-50 font-semibold dark:bg-green-950/30'
                      : 'border-neutral-200 dark:border-neutral-700',
                  )}
                >
                  {kind.label}
                </button>
              )
            })}
          </div>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            Detected as {detected === 'demo' ? 'Demo' : detected === 'live' ? 'Live' : 'unknown'}. Choose Prop firm if this is a funded or evaluation account — an administrator confirms it during review.
          </p>
          {draft.accountKind === 'prop' && (
            <label className="block text-sm">
              <span className="font-medium text-neutral-900 dark:text-neutral-50">Prop firm name</span>
              <input
                value={draft.propFirmName}
                maxLength={80}
                onChange={event => setDraft({ propFirmName: event.target.value })}
                placeholder="e.g. FTMO"
                className="mt-1 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-base md:text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          )}
        </fieldset>
      )}
    </div>
  )
}

function PricingStep({
  draft, setDraft,
}: { draft: ProviderDraft; setDraft: (patch: Partial<ProviderDraft>) => void }) {
  const [mode, setMode] = useState<'free' | 'paid' | null>(() => {
    if (draft.priceUsd.trim() === '') return null
    return priceInputToCents(draft.priceUsd) === 0 ? 'free' : 'paid'
  })
  const choose = (next: 'free' | 'paid') => {
    setMode(next)
    setDraft({ priceUsd: next === 'free' ? '0' : draft.priceUsd === '0' ? '' : draft.priceUsd })
  }
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">Set your price</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          The price is displayed on your profile. Billing between you and your followers is not handled by TScopier yet.
        </p>
      </div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Pricing">
        {(['free', 'paid'] as const).map(value => (
          <button key={value} type="button" role="radio" aria-checked={mode === value}
            onClick={() => choose(value)}
            className={clsx('rounded-full border px-4 py-1.5 text-sm', mode === value ? 'border-green-400 bg-green-50 font-semibold dark:bg-green-950/30' : 'border-neutral-200 dark:border-neutral-700')}>
            {value === 'free' ? 'Free' : 'Paid'}
          </button>
        ))}
      </div>
      {mode === 'paid' && (
        <label className="block max-w-xs text-sm">
          <span className="font-medium text-neutral-900 dark:text-neutral-50">Monthly price (USD)</span>
          <input
            inputMode="decimal"
            value={draft.priceUsd}
            onChange={event => setDraft({ priceUsd: event.target.value })}
            placeholder="50"
            className="mt-1 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-base md:text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
      )}
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Who can follow you?</legend>
        {([
          ['open', 'Anyone', 'Followers are accepted automatically.'],
          ['private', 'Approval required', 'You approve each follow request.'],
        ] as const).map(([value, label, hint]) => (
          <label key={value} className={clsx('flex cursor-pointer items-start gap-3 rounded-lg border p-3', draft.access === value ? 'border-green-400' : 'border-neutral-200 dark:border-neutral-800')}>
            <input type="radio" name="provider-access" checked={draft.access === value} onChange={() => setDraft({ access: value })} className="mt-1" />
            <span>
              <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-50">{label}</span>
              <span className="block text-xs text-neutral-600 dark:text-neutral-400">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="block text-sm">
        <span className="font-medium text-neutral-900 dark:text-neutral-50">About your strategy (optional)</span>
        <textarea
          value={draft.bio}
          maxLength={PROVIDER_BIO_MAX}
          rows={4}
          onChange={event => setDraft({ bio: event.target.value })}
          placeholder="Instruments you trade, risk approach, typical holding time…"
          className="mt-1 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-base md:text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <span className="mt-1 block text-end text-xs text-neutral-600 dark:text-neutral-400">{draft.bio.length}/{PROVIDER_BIO_MAX}</span>
      </label>
    </div>
  )
}

function LinksStep({
  draft, setDraft,
}: { draft: ProviderDraft; setDraft: (patch: Partial<ProviderDraft>) => void }) {
  const error = validateSocialProfileLinks(draft.links)
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">Where can people find you?</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Optional. Only https links to the platform's own domain are accepted.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {SOCIAL_PROFILE_PLATFORMS.map(platform => {
          const value = draft.links[platform.key] ?? ''
          const fieldError = value.trim() ? validateSocialProfileLinks({ [platform.key]: value }) : null
          return (
            <label key={platform.key} className="block text-sm">
              <span className="flex items-center gap-2 font-medium text-neutral-900 dark:text-neutral-50">
                <SocialBrandIcon platform={platform.key} /> {platform.label}
              </span>
              <input
                type="url"
                value={value}
                maxLength={500}
                onChange={event => setDraft({ links: { ...draft.links, [platform.key]: event.target.value } })}
                placeholder={platform.placeholder}
                aria-invalid={fieldError != null}
                className={clsx(
                  'mt-1 w-full rounded-lg border bg-white px-3 py-2 text-base md:text-sm dark:bg-neutral-900',
                  fieldError ? 'border-error-500' : 'border-neutral-200 dark:border-neutral-700',
                )}
              />
              {fieldError && <span className="mt-1 block text-xs text-error-600">{fieldError}</span>}
            </label>
          )
        })}
      </div>
      {error && <p className="sr-only">{error}</p>}
    </div>
  )
}

function ReviewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <dt className="text-neutral-600 dark:text-neutral-400">{label}</dt>
      <dd className="text-end font-medium text-neutral-900 dark:text-neutral-50">{children}</dd>
    </div>
  )
}

function ReviewStep({
  draft, account, accepted, onAccept,
}: { draft: ProviderDraft; account: BrokerAccount | null; accepted: boolean; onAccept: (value: boolean) => void }) {
  const cents = priceInputToCents(draft.priceUsd)
  const links = SOCIAL_PROFILE_PLATFORMS.filter(platform => draft.links[platform.key]?.trim())
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">Review and submit</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">An administrator reviews every application before it goes live.</p>
      </div>
      <dl className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 px-4 dark:divide-neutral-800 dark:border-neutral-800">
        <ReviewRow label="Account">{account ? socialBrokerDisplayLabel(account) : '\u2014'}</ReviewRow>
        <ReviewRow label="Platform">{account?.platform?.toUpperCase() ?? '\u2014'}</ReviewRow>
        <ReviewRow label="Type">
          <span className="inline-flex items-center gap-2">
            {draft.accountKind && <AccountKindBadge kind={draft.accountKind} />}
            {draft.accountKind === 'prop' && draft.propFirmName.trim()}
          </span>
        </ReviewRow>
        <ReviewRow label="Balance / equity">
          {account ? `${formatAccountAmount(account.last_balance, account.last_currency)} / ${formatAccountAmount(account.last_equity, account.last_currency)}` : '\u2014'}
        </ReviewRow>
        <ReviewRow label="Price">{cents == null ? '\u2014' : cents === 0 ? 'Free' : `$${(cents / 100).toFixed(2)} / month`}</ReviewRow>
        <ReviewRow label="Followers">{draft.access === 'open' ? 'Anyone' : 'Approval required'}</ReviewRow>
        <ReviewRow label="Social profiles">
          {links.length ? <span className="inline-flex items-center gap-1.5">{links.map(platform => <SocialBrandIcon key={platform.key} platform={platform.key} />)}</span> : 'None'}
        </ReviewRow>
      </dl>
      <div className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <ul className="list-disc space-y-1 ps-5 text-sm text-neutral-700 dark:text-neutral-300">
          {TERMS.map(term => <li key={term}>{term}</li>)}
        </ul>
        <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm font-medium text-neutral-900 dark:text-neutral-50">
          <input type="checkbox" checked={accepted} onChange={event => onAccept(event.target.checked)} className="mt-1" />
          I understand and accept these provider terms.
        </label>
      </div>
    </div>
  )
}

function StatusScreen({
  status, rejectionReason, slug, name, onEdit, children,
}: {
  status: 'pending' | 'approved' | 'rejected' | 'suspended'
  rejectionReason: string | null
  slug: string | null
  name: string
  onEdit?: () => void
  children?: ReactNode
}) {
  const content = {
    pending: { icon: Clock, tone: 'text-amber-600', title: 'Application under review', body: 'An administrator is reviewing your application. You will get a notification as soon as it is decided.' },
    approved: { icon: CheckCircle2, tone: 'text-green-600', title: "You're live in the directory", body: 'Your provider profile is public and your account can be copied.' },
    rejected: { icon: XCircle, tone: 'text-error-600', title: 'Application needs changes', body: rejectionReason ?? 'Your application was not approved.' },
    suspended: { icon: XCircle, tone: 'text-error-600', title: 'Provider profile suspended', body: rejectionReason ?? 'An administrator paused your provider profile. Contact support to learn more.' },
  }[status]
  const Icon = content.icon
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <Icon className={clsx('mt-0.5 h-6 w-6 shrink-0', content.tone)} />
        <div>
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">{content.title}</h2>
          <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">{content.body}</p>
          {onEdit && <Button className="mt-3" size="sm" onClick={onEdit}>{status === 'rejected' ? 'Edit and resubmit' : 'Edit profile'}</Button>}
        </div>
      </div>
      {status === 'approved' && slug && <ProviderShareCard slug={slug} name={name} />}
      {children}
    </div>
  )
}

export function ProviderApplyPage() {
  const app = useProviderApplication()
  const { brokers } = useBrokerAccounts()
  const { profile } = useUserProfile()
  const [step, setStep] = useState<ProviderStep>(1)
  const [accepted, setAccepted] = useState(false)
  const [stepError, setStepError] = useState<string | null>(null)
  const [editingApproved, setEditingApproved] = useState(false)
  const [forceWizard, setForceWizard] = useState(false)

  const account = brokers.find(item => item.id === app.draft.brokerAccountId) ?? null
  const displayName = profile.display_name?.trim() || profile.username?.trim() || 'Provider'
  const status = app.application?.status ?? null

  const goNext = async () => {
    const problem = validateProviderStep(step, app.draft, account)
    setStepError(problem)
    if (problem) return
    try { await app.flush() } catch { return }
    setStep(current => Math.min(4, current + 1) as ProviderStep)
  }

  const submit = async () => {
    for (const value of [1, 2, 3] as ProviderStep[]) {
      const problem = validateProviderStep(value, app.draft, account)
      if (problem) { setStep(value); setStepError(problem); return }
    }
    try {
      await app.submit(accepted)
      setForceWizard(false)
    } catch { /* surfaced through app.saveError */ }
  }

  const saveApproved = async () => {
    for (const value of [2, 3] as ProviderStep[]) {
      const problem = validateProviderStep(value, app.draft, account)
      if (problem) { setStepError(problem); return }
    }
    try { await app.updateApproved(); setEditingApproved(false) } catch { /* shown below */ }
  }

  let body: ReactNode
  if (app.loading && !app.application) {
    body = <p className="text-sm text-neutral-600 dark:text-neutral-400">Loading…</p>
  } else if (app.loadError) {
    body = <Alert variant="error">{app.loadError}</Alert>
  } else if (status === 'approved' && editingApproved) {
    body = (
      <div className="space-y-6">
        <PricingStep draft={app.draft} setDraft={app.setDraft} />
        <LinksStep draft={app.draft} setDraft={app.setDraft} />
        <div className="flex gap-2">
          <Button loading={app.submitting} onClick={() => void saveApproved()}>Save changes</Button>
          <Button variant="ghost" onClick={() => { setEditingApproved(false); void app.reload() }}>Cancel</Button>
        </div>
      </div>
    )
  } else if (status && status !== 'draft' && !(status === 'rejected' && forceWizard)) {
    body = (
      <StatusScreen
        status={status}
        rejectionReason={app.application?.rejectionReason ?? null}
        slug={app.application?.slug ?? null}
        name={displayName}
        onEdit={status === 'approved' ? () => setEditingApproved(true) : status === 'rejected' ? () => { setForceWizard(true); setStep(1) } : undefined}
      />
    )
  } else {
    body = (
      <div className="space-y-6">
        {app.application?.rejectionReason && status === 'draft' && (
          <Alert variant="warning">Previous review feedback: {app.application.rejectionReason}</Alert>
        )}
        <Stepper step={step} maxStep={4} onJump={target => {
          if (target <= step) { setStepError(null); setStep(target) }
        }} />
        <div className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900/50">
          {step === 1 && <AccountStep draft={app.draft} setDraft={app.setDraft} />}
          {step === 2 && <PricingStep draft={app.draft} setDraft={app.setDraft} />}
          {step === 3 && <LinksStep draft={app.draft} setDraft={app.setDraft} />}
          {step === 4 && <ReviewStep draft={app.draft} account={account} accepted={accepted} onAccept={setAccepted} />}
        </div>
        {stepError && <Alert variant="error">{stepError}</Alert>}
        {app.saveError && <Alert variant="error">{app.saveError}</Alert>}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {step > 1 && <Button variant="secondary" onClick={() => { setStepError(null); setStep(current => (current - 1) as ProviderStep) }}>Back</Button>}
            <span className="text-xs text-neutral-600 dark:text-neutral-400" aria-live="polite">
              {app.saveState === 'saving' ? 'Saving draft…' : app.saveState === 'saved' ? 'Draft saved' : ''}
            </span>
          </div>
          {step < 4
            ? <Button onClick={() => void goNext()}>Continue</Button>
            : <Button loading={app.submitting} disabled={!accepted} onClick={() => void submit()}>Submit application</Button>}
        </div>
      </div>
    )
  }

  return (
    <PageShell maxWidth="xl">
      <PageHeader
        title="Become a provider"
        actions={<Link to="/social-trading" className="text-sm font-medium text-green-700 hover:underline dark:text-green-400">Back to Social Trading</Link>}
      />
      <div className="mt-6 max-w-4xl">{body}</div>
    </PageShell>
  )
}
