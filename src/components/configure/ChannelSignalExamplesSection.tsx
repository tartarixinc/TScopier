import { useCallback, useEffect, useRef, useState } from 'react'
import { Pencil, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Alert } from '../ui/Alert'
import { ConfigTitle } from '../ui/InfoTooltip'
import { interpolate } from '../../i18n/interpolate'
import {
  deleteChannelSignalExample,
  fetchChannelSignalExamples,
  formatTradeIntentSummary,
  type ChannelSignalExampleLabel,
  type ChannelSignalExampleRow,
} from '../../lib/channelSignalExamples'
import type { ConfigureModalTranslations } from '../../i18n/locales/configureModal/types'
import { CustomSignalExampleModal } from './CustomSignalExampleModal'

type Props = {
  channelId: string
  userId: string
  labels: ConfigureModalTranslations['aiTraining']
  trainingActive: boolean
  onRetrain?: () => Promise<{ trained: boolean; error?: string }>
}

function labelVariant(label: ChannelSignalExampleLabel): 'success' | 'primary' | 'neutral' {
  if (label === 'entry') return 'success'
  if (label === 'update') return 'primary'
  return 'neutral'
}

function labelText(label: ChannelSignalExampleLabel, labels: ConfigureModalTranslations['aiTraining']): string {
  if (label === 'entry') return labels.exampleLabelEntry
  if (label === 'update') return labels.exampleLabelUpdate
  return labels.exampleLabelIgnore
}

export function ChannelSignalExamplesSection({
  channelId,
  userId,
  labels,
  trainingActive,
  onRetrain,
}: Props) {
  const [examples, setExamples] = useState<ChannelSignalExampleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [trainFeedback, setTrainFeedback] = useState<{ variant: 'success' | 'error'; message: string } | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<ChannelSignalExampleRow | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const prevTrainingActive = useRef(trainingActive)

  const loadExamples = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const rows = await fetchChannelSignalExamples(channelId)
      setExamples(rows)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : labels.signalExamplesLoadError)
      setExamples([])
    } finally {
      setLoading(false)
    }
  }, [channelId, labels.signalExamplesLoadError])

  useEffect(() => {
    void loadExamples()
    setTrainFeedback(null)
  }, [loadExamples])

  useEffect(() => {
    if (prevTrainingActive.current && !trainingActive) {
      void loadExamples()
    }
    prevTrainingActive.current = trainingActive
  }, [trainingActive, loadExamples])

  const handleRetrain = useCallback(async () => {
    if (!onRetrain || trainingActive) return
    setTrainFeedback(null)
    try {
      const result = await onRetrain()
      if (result.error) {
        setTrainFeedback({ variant: 'error', message: result.error })
        return
      }
      if (result.trained) {
        setTrainFeedback({ variant: 'success', message: labels.autoTrainingDone })
        return
      }
      setTrainFeedback({ variant: 'error', message: labels.trainFailed })
    } catch (err) {
      setTrainFeedback({
        variant: 'error',
        message: err instanceof Error ? err.message : labels.trainFailed,
      })
    }
  }, [labels.autoTrainingDone, labels.trainFailed, onRetrain, trainingActive])

  const handleDelete = useCallback(async (row: ChannelSignalExampleRow) => {
    if (!window.confirm(labels.deleteExampleConfirm)) return
    setDeletingId(row.id)
    setTrainFeedback(null)
    try {
      await deleteChannelSignalExample(row.id)
      setExamples(prev => prev.filter(e => e.id !== row.id))
    } catch (err) {
      setTrainFeedback({
        variant: 'error',
        message: err instanceof Error ? err.message : labels.signalExamplesLoadError,
      })
    } finally {
      setDeletingId(null)
    }
  }, [labels.deleteExampleConfirm, labels.signalExamplesLoadError])

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1 min-w-0">
          <ConfigTitle variant="semibold" info={labels.signalExamplesHint}>
            {labels.signalExamplesTitle}
          </ConfigTitle>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{labels.signalExamplesIntro}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={loading || trainingActive}
            onClick={() => void loadExamples()}
            className="min-h-[36px]"
          >
            <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
            {labels.signalExamplesRefresh}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={trainingActive}
            onClick={() => {
              setEditing(null)
              setModalOpen(true)
            }}
            className="min-h-[36px]"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {labels.addCustomExample}
          </Button>
          {onRetrain ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={trainingActive}
              loading={trainingActive}
              onClick={() => void handleRetrain()}
              className="min-h-[36px]"
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              {trainingActive ? labels.training : labels.trainButton}
            </Button>
          ) : null}
        </div>
      </div>

      {trainFeedback ? (
        <Alert variant={trainFeedback.variant === 'success' ? 'success' : 'error'} className="text-sm">
          {trainFeedback.message}
        </Alert>
      ) : null}

      {loadError ? (
        <p className="text-sm text-error-600 dark:text-error-400">{loadError}</p>
      ) : null}

      {loading && examples.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{labels.loadingExisting}</p>
      ) : null}

      {!loading && examples.length === 0 && !loadError ? (
        <div className="rounded-xl border border-dashed border-neutral-200 dark:border-neutral-700 bg-neutral-50/80 dark:bg-neutral-800/30 px-4 py-8 text-center">
          <Sparkles className="mx-auto mb-3 h-8 w-8 text-neutral-300 dark:text-neutral-600" aria-hidden />
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{labels.signalExamplesEmpty}</p>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{labels.signalExamplesEmptyHint}</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button
              type="button"
              className="min-h-[40px]"
              disabled={trainingActive}
              onClick={() => {
                setEditing(null)
                setModalOpen(true)
              }}
            >
              <Plus className="h-4 w-4" aria-hidden />
              {labels.addCustomExample}
            </Button>
            {onRetrain ? (
              <Button
                type="button"
                variant="secondary"
                className="min-h-[40px]"
                disabled={trainingActive}
                loading={trainingActive}
                onClick={() => void handleRetrain()}
              >
                {labels.trainButton}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {examples.length > 0 ? (
        <>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {interpolate(labels.signalExamplesCount, { count: String(examples.length) })}
          </p>
          <ul className="space-y-3">
            {examples.map(example => {
              const summary = formatTradeIntentSummary(example.intent)
              return (
                <li
                  key={example.id}
                  className="rounded-xl border border-neutral-200/65 dark:border-neutral-800/55 bg-white dark:bg-neutral-900/50 overflow-hidden"
                >
                  <div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 dark:border-neutral-800 px-3 py-2 bg-neutral-50/80 dark:bg-neutral-800/40">
                    <Badge variant={labelVariant(example.label)} size="sm">
                      {labelText(example.label, labels)}
                    </Badge>
                    {example.source === 'manual' ? (
                      <Badge variant="primary" size="sm">{labels.manualBadge}</Badge>
                    ) : null}
                    {summary ? (
                      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300 truncate max-w-full">
                        {summary}
                      </span>
                    ) : null}
                    <div className="ml-auto flex items-center gap-1">
                      <button
                        type="button"
                        className="rounded-md p-1.5 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 dark:hover:text-neutral-200 dark:hover:bg-neutral-800"
                        aria-label={labels.editExample}
                        onClick={() => {
                          setEditing(example)
                          setModalOpen(true)
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="rounded-md p-1.5 text-neutral-400 hover:text-error-600 hover:bg-error-50 dark:hover:text-error-400 dark:hover:bg-error-950/40 disabled:opacity-40"
                        aria-label={labels.deleteExample}
                        disabled={deletingId === example.id}
                        onClick={() => void handleDelete(example)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </div>
                  </div>
                  <pre className="px-3 py-3 text-sm text-neutral-700 dark:text-neutral-200 whitespace-pre-wrap font-sans leading-relaxed max-h-48 overflow-y-auto">
                    {example.raw_message}
                  </pre>
                </li>
              )
            })}
          </ul>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{labels.multilingualRetrainHint}</p>
        </>
      ) : null}

      <CustomSignalExampleModal
        open={modalOpen}
        channelId={channelId}
        userId={userId}
        labels={labels}
        initial={editing}
        onClose={() => {
          setModalOpen(false)
          setEditing(null)
        }}
        onSaved={row => {
          setTrainFeedback({ variant: 'success', message: labels.exampleSaved })
          setExamples(prev => {
            const without = prev.filter(e => e.id !== row.id)
            return [row, ...without].sort((a, b) => a.sort_order - b.sort_order)
          })
        }}
      />
    </section>
  )
}
