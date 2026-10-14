import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useT } from '../../context/LocaleContext'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { brokerAccountHealthPatchFromMtStatus } from '../../lib/brokerHealth'
import {
  exchangeCtraderCodeOnce,
  linkCtraderAccount,
  type CtraderAccountChoice,
} from '../../lib/ctraderBroker'
import { Button } from '../../components/ui/Button'
import { PaywallErrorAlert } from '../../components/billing/PaywallErrorAlert'

export function CtraderCallbackPage() {
  const t = useT()
  const cf = t.accountConfig.connectForm
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { upsertBroker } = useBrokerAccounts()
  const [error, setError] = useState('')
  const [linking, setLinking] = useState(true)
  const [handoff, setHandoff] = useState('')
  const [accounts, setAccounts] = useState<CtraderAccountChoice[]>([])
  const [chosen, setChosen] = useState('')

  useEffect(() => {
    const oauthError = params.get('error_description') || params.get('error')
    const code = params.get('code')?.trim() ?? ''
    const state = params.get('state')?.trim() ?? ''
    if (oauthError) {
      setError(oauthError)
      setLinking(false)
      return
    }
    if (!code) {
      setError(cf.ctraderNotConfigured)
      setLinking(false)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const exchanged = await exchangeCtraderCodeOnce(code, state)
        if (cancelled) return
        if (exchanged.accounts.length === 1) {
          const linked = await linkCtraderAccount({
            handoff: exchanged.handoff,
            accountId: exchanged.accounts[0]!.accountId,
          })
          upsertBroker(linked.status
            ? { ...linked.account, ...brokerAccountHealthPatchFromMtStatus(linked.status) }
            : linked.account)
          navigate('/brokers', { replace: true })
          return
        }
        setHandoff(exchanged.handoff)
        setAccounts(exchanged.accounts)
        setChosen(exchanged.accounts[0]?.accountId ?? '')
        setLinking(false)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : cf.connectFailed)
        setLinking(false)
      }
    })()
    return () => { cancelled = true }
  }, [cf.connectFailed, cf.ctraderNotConfigured, navigate, params, upsertBroker])

  const linkChosen = async () => {
    if (!chosen || !handoff) return
    setLinking(true)
    setError('')
    try {
      const linked = await linkCtraderAccount({ handoff, accountId: chosen })
      upsertBroker(linked.status
        ? { ...linked.account, ...brokerAccountHealthPatchFromMtStatus(linked.status) }
        : linked.account)
      navigate('/brokers', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : cf.connectFailed)
      setLinking(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-[50vh] w-full max-w-lg flex-col justify-center px-4 py-10">
      <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
        {accounts.length > 1 ? cf.ctraderPickAccount : cf.platformCtrader}
      </h1>
      {error ? <PaywallErrorAlert message={error} className="mt-4" /> : null}
      {linking && !error ? (
        <p className="mt-4 text-sm text-neutral-900 dark:text-neutral-50">{cf.ctraderConnectHint}</p>
      ) : null}
      {accounts.length > 1 ? (
        <div className="mt-4 space-y-2">
          {accounts.map(account => (
            <label
              key={account.accountId}
              className="flex cursor-pointer items-center gap-3 rounded-xl border border-neutral-200 px-4 py-3 dark:border-neutral-800"
            >
              <input
                type="radio"
                name="ctrader-account"
                value={account.accountId}
                checked={chosen === account.accountId}
                onChange={() => setChosen(account.accountId)}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-50">
                  {account.brokerName || account.accountNumber || account.accountId}
                </span>
                <span className="block text-sm text-neutral-900 dark:text-neutral-50">
                  {account.accountNumber ? `${account.accountNumber} · ` : ''}
                  {account.live ? cf.ctraderLive : cf.ctraderDemo}
                </span>
              </span>
            </label>
          ))}
          <Button type="button" size="sm" className="mt-3" loading={linking} onClick={() => void linkChosen()}>
            {cf.ctraderLinkButton}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
