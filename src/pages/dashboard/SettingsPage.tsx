import { useEffect, useMemo, useState } from 'react'
import {
  Globe,
  Lock,
  Loader2,
  Save,
  Shield,
  User,
} from 'lucide-react'
import clsx from 'clsx'
import { useAuth } from '../../context/AuthContext'
import { useLocale, useT } from '../../context/LocaleContext'
import { useUserProfile } from '../../context/UserProfileContext'
import { updatePassword } from '../../lib/userProfile'
import { buildCountryOptions } from '../../lib/countryOptions'
import { buildBaseCurrencyOptions } from '../../lib/baseCurrencies'
import { TIMEZONE_OPTIONS } from '../../lib/timezoneOptions'
import { Input } from '../../components/ui/Input'
import { SearchableSelect } from '../../components/ui/SearchableSelect'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'

type SettingsSection = 'personal' | 'general' | 'security'

function SettingsCard({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <section className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
      <div className="px-5 sm:px-6 py-4 border-b border-neutral-100 dark:border-neutral-800">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">{title}</h2>
        {description ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">{description}</p>
        ) : null}
      </div>
      <div className="p-5 sm:p-6">{children}</div>
      {footer ? (
        <div className="px-5 sm:px-6 py-4 border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50/80 dark:bg-neutral-800/30 flex justify-end">
          {footer}
        </div>
      ) : null}
    </section>
  )
}

export function SettingsPage() {
  const t = useT()
  const { locale } = useLocale()
  const { user } = useAuth()
  const { profile, loading, patchProfile, persistProfile } = useUserProfile()

  const countryOptions = useMemo(
    () => buildCountryOptions(locale, t.settings.placeholders.selectCountry),
    [locale, t.settings.placeholders.selectCountry],
  )
  const currencyOptions = useMemo(
    () => buildBaseCurrencyOptions(profile.base_currency),
    [profile.base_currency],
  )
  const [section, setSection] = useState<SettingsSection>('personal')
  const [email, setEmail] = useState('')

  const [personalSaving, setPersonalSaving] = useState(false)
  const [generalSaving, setGeneralSaving] = useState(false)
  const [passwordSaving, setPasswordSaving] = useState(false)

  const [personalMsg, setPersonalMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [generalMsg, setGeneralMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [securityMsg, setSecurityMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const sections: { id: SettingsSection; label: string; icon: typeof User }[] = [
    { id: 'personal', label: t.settings.sections.personal, icon: User },
    { id: 'general', label: t.settings.sections.general, icon: Globe },
    { id: 'security', label: t.settings.sections.security, icon: Shield },
  ]

  useEffect(() => {
    setEmail(user?.email ?? '')
  }, [user?.email])

  const applyPreference = async (
    patch: Partial<typeof profile>,
    setMsg: (msg: { type: 'success' | 'error'; text: string } | null) => void,
  ) => {
    patchProfile(patch)
    try {
      await persistProfile(patch)
      setMsg({ type: 'success', text: t.settings.saved })
    } catch (e) {
      setMsg({
        type: 'error',
        text: e instanceof Error ? e.message : t.settings.saveError,
      })
    }
  }

  const handleSavePersonal = async () => {
    if (!user) return
    setPersonalSaving(true)
    setPersonalMsg(null)
    try {
      await persistProfile()
      setPersonalMsg({ type: 'success', text: t.settings.saved })
    } catch (e) {
      setPersonalMsg({
        type: 'error',
        text: e instanceof Error ? e.message : t.settings.saveError,
      })
    } finally {
      setPersonalSaving(false)
    }
  }

  const handleSaveGeneral = async () => {
    setGeneralSaving(true)
    setGeneralMsg(null)
    try {
      await persistProfile()
      setGeneralMsg({ type: 'success', text: t.settings.saved })
    } catch (e) {
      setGeneralMsg({
        type: 'error',
        text: e instanceof Error ? e.message : t.settings.saveError,
      })
    } finally {
      setGeneralSaving(false)
    }
  }

  const handleChangePassword = async () => {
    setSecurityMsg(null)
    if (newPassword.length < 8) {
      setSecurityMsg({ type: 'error', text: t.settings.passwordTooShort })
      return
    }
    if (newPassword !== confirmPassword) {
      setSecurityMsg({ type: 'error', text: t.settings.passwordMismatch })
      return
    }
    setPasswordSaving(true)
    try {
      await updatePassword(newPassword)
      setNewPassword('')
      setConfirmPassword('')
      setSecurityMsg({ type: 'success', text: t.settings.passwordUpdated })
    } catch (e) {
      setSecurityMsg({
        type: 'error',
        text: e instanceof Error ? e.message : t.settings.passwordError,
      })
    } finally {
      setPasswordSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <header className="mb-6 sm:mb-8">
        <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">
          {t.settings.title}
        </h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
          {t.settings.subtitle}
        </p>
      </header>

      <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">
        <nav className="lg:w-52 shrink-0 flex lg:flex-col gap-1 overflow-x-auto pb-1 lg:pb-0">
          {sections.map(({ id, label, icon: Icon }) => {
            const active = section === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                className={clsx(
                  'shrink-0 flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors whitespace-nowrap',
                  active
                    ? 'bg-teal-50 text-teal-800 border border-teal-200 dark:bg-teal-950/50 dark:text-teal-200 dark:border-teal-900'
                    : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 border border-transparent',
                )}
              >
                <Icon className={clsx('h-4 w-4', active ? 'text-teal-600 dark:text-teal-400' : 'text-neutral-400')} />
                {label}
              </button>
            )
          })}
        </nav>

        <div className="flex-1 min-w-0 space-y-4">
          {section === 'personal' ? (
            <SettingsCard
              title={t.settings.personal.title}
              description={t.settings.personal.description}
              footer={(
                <Button onClick={() => void handleSavePersonal()} loading={personalSaving}>
                  <Save className="h-4 w-4" />
                  {t.common.save}
                </Button>
              )}
            >
              {personalMsg ? (
                <Alert variant={personalMsg.type === 'success' ? 'success' : 'error'} className="mb-4">
                  {personalMsg.text}
                </Alert>
              ) : null}
              <div className="grid sm:grid-cols-2 gap-4">
                <Input
                  label={t.settings.fields.firstName}
                  value={profile.first_name}
                  onChange={e => patchProfile({ first_name: e.target.value })}
                />
                <Input
                  label={t.settings.fields.lastName}
                  value={profile.last_name}
                  onChange={e => patchProfile({ last_name: e.target.value })}
                />
                <Input
                  label={t.settings.fields.username}
                  value={profile.username}
                  onChange={e => patchProfile({ username: e.target.value })}
                  autoComplete="username"
                />
                <Input
                  label={t.settings.fields.email}
                  value={email}
                  readOnly
                  disabled
                  className="opacity-80"
                  hint={t.settings.emailHint}
                />
                <SearchableSelect
                  label={t.settings.fields.country}
                  value={profile.country}
                  onChange={country => patchProfile({ country })}
                  options={countryOptions}
                  placeholder={t.settings.placeholders.selectCountry}
                  searchPlaceholder={t.settings.placeholders.searchCountry}
                  noMatchesLabel={t.settings.placeholders.noMatches}
                  className="sm:col-span-2"
                />
                <Input
                  label={t.settings.fields.city}
                  value={profile.city}
                  onChange={e => patchProfile({ city: e.target.value })}
                />
                <Input
                  label={t.settings.fields.mobile}
                  type="tel"
                  value={profile.mobile_number}
                  onChange={e => patchProfile({ mobile_number: e.target.value })}
                  autoComplete="tel"
                />
                <div className="sm:col-span-2">
                  <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    {t.settings.fields.address}
                  </label>
                  <textarea
                    value={profile.address}
                    onChange={e => patchProfile({ address: e.target.value })}
                    rows={3}
                    className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-y min-h-[88px]"
                    placeholder={t.settings.placeholders.address}
                  />
                </div>
              </div>
            </SettingsCard>
          ) : null}

          {section === 'general' ? (
            <SettingsCard
              title={t.settings.general.title}
              description={t.settings.general.description}
              footer={(
                <Button onClick={() => void handleSaveGeneral()} loading={generalSaving}>
                  <Save className="h-4 w-4" />
                  {t.common.save}
                </Button>
              )}
            >
              {generalMsg ? (
                <Alert variant={generalMsg.type === 'success' ? 'success' : 'error'} className="mb-4">
                  {generalMsg.text}
                </Alert>
              ) : null}
              <div className="grid sm:grid-cols-2 gap-4">
                <SearchableSelect
                  label={t.settings.fields.baseCurrency}
                  value={profile.base_currency}
                  onChange={code => void applyPreference({ base_currency: code }, setGeneralMsg)}
                  options={currencyOptions}
                  placeholder={t.settings.placeholders.selectCurrency}
                  searchPlaceholder={t.settings.placeholders.searchCurrency}
                  noMatchesLabel={t.settings.placeholders.noMatches}
                  className="sm:col-span-2"
                />
                <SearchableSelect
                  label={t.settings.fields.timezone}
                  value={profile.timezone}
                  onChange={timezone => void applyPreference({ timezone }, setGeneralMsg)}
                  options={TIMEZONE_OPTIONS}
                  placeholder={t.settings.placeholders.selectTimezone}
                  searchPlaceholder={t.settings.placeholders.searchTimezone}
                  noMatchesLabel={t.settings.placeholders.noMatches}
                  required
                  className="sm:col-span-2"
                />
              </div>
            </SettingsCard>
          ) : null}

          {section === 'security' ? (
            <SettingsCard
              title={t.settings.security.title}
              description={t.settings.security.description}
              footer={(
                <Button onClick={() => void handleChangePassword()} loading={passwordSaving}>
                  <Lock className="h-4 w-4" />
                  {t.settings.security.updatePassword}
                </Button>
              )}
            >
              {securityMsg ? (
                <Alert variant={securityMsg.type === 'success' ? 'success' : 'error'} className="mb-4">
                  {securityMsg.text}
                </Alert>
              ) : null}
              <div className="grid sm:grid-cols-2 gap-4 max-w-xl">
                <Input
                  label={t.settings.fields.newPassword}
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  hint={t.settings.passwordHint}
                />
                <Input
                  label={t.settings.fields.confirmPassword}
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
            </SettingsCard>
          ) : null}
        </div>
      </div>
    </div>
  )
}
