import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { Button } from '../ui/Button'
import type { ConfigurationBrokerOption } from './AddConfigurationChannelModal'

export function AddConfigurationDestinationModal({
  brokers,
  emptyLabel,
  onClose,
  onSelect,
  onAddBroker,
}: {
  brokers: ConfigurationBrokerOption[]
  emptyLabel: string
  onClose: () => void
  onSelect: (brokerId: string) => void
  onAddBroker: () => void
}) {
  const t = useT()
  const copy = t.configurationsPage

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-configuration-destination-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/55"
        aria-label={t.accountConfig.configureModal.close}
        onClick={onClose}
      />
      <div className="relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-200/65 bg-white shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <h2 id="add-configuration-destination-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
            {copy.addDestination}
          </h2>
          <button
            type="button"
            className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            aria-label={t.accountConfig.configureModal.close}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          {brokers.length === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{emptyLabel}</p>
          ) : (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {brokers.map(broker => (
                <li key={broker.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 py-2.5 text-start hover:bg-neutral-50 dark:hover:bg-neutral-900"
                    onClick={() => onSelect(broker.id)}
                  >
                    <img
                      src={`/${broker.platform.toUpperCase()}.png`}
                      alt=""
                      aria-hidden
                      className="h-7 w-7 shrink-0 object-contain"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">{broker.label}</span>
                      {broker.login ? (
                        <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">{copy.login} {broker.login}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button type="button" className="mt-4 w-full" onClick={onAddBroker}>
            {copy.addBroker}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
