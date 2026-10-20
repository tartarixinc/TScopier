import { Sparkles } from 'lucide-react'
import clsx from 'clsx'
import type { AssistantChatMessage } from '../../lib/assistantClient'
import { AssistantMessageContent } from './AssistantMessageContent'

export function AssistantChatBubble({
  message,
  hidePlainCaption,
}: {
  message: AssistantChatMessage
  /** When true, omit text that is only the default image-only caption. */
  hidePlainCaption?: boolean
}) {
  const isUser = message.role === 'user'
  const showText = Boolean(message.content?.trim()) && !hidePlainCaption
  const images = message.images ?? []

  return (
    <div
      className={clsx(
        'animate-assistant-msg-in flex w-full gap-2.5',
        isUser ? 'justify-end' : 'justify-start',
      )}
    >
      {!isUser ? (
        <div
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-green-400 to-green-500 text-neutral-950 shadow-xs shadow-green-400/25"
          aria-hidden
        >
          <Sparkles className="h-3.5 w-3.5" />
        </div>
      ) : null}

      <div
        className={clsx(
          'min-w-0 max-w-[min(100%,22rem)] text-[13.5px] leading-relaxed',
          isUser ? 'items-end' : 'items-start',
        )}
      >
        <div
          className={clsx(
            'overflow-hidden px-3.5 py-2.5 shadow-xs',
            isUser
              ? 'rounded-2xl rounded-ee-md bg-green-400 text-neutral-950 shadow-green-500/15'
              : 'rounded-2xl rounded-es-md border border-neutral-200/60 bg-white text-neutral-900 shadow-neutral-900/5 dark:border-neutral-800/55 dark:bg-neutral-950 dark:text-neutral-100',
          )}
        >
          {images.length > 0 ? (
            <div
              className={clsx(
                'grid gap-1.5',
                images.length === 1 ? 'grid-cols-1' : 'grid-cols-2',
                showText && 'mb-2.5',
              )}
            >
              {images.map((src, imgIdx) => (
                <img
                  key={imgIdx}
                  src={src}
                  alt=""
                  className={clsx(
                    'w-full object-cover',
                    images.length === 1
                      ? 'max-h-52 rounded-xl'
                      : 'aspect-square rounded-lg',
                    isUser ? 'ring-1 ring-white/20' : 'ring-1 ring-neutral-200/80 dark:ring-neutral-700',
                  )}
                />
              ))}
            </div>
          ) : null}

          {showText ? (
            <AssistantMessageContent text={message.content} variant={isUser ? 'user' : 'assistant'} />
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function AssistantTypingIndicator({ label }: { label: string }) {
  return (
    <div className="animate-assistant-msg-in flex items-start gap-2.5">
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-green-400 to-green-500 text-neutral-950 shadow-xs shadow-green-400/25"
        aria-hidden
      >
        <Sparkles className="h-3.5 w-3.5" />
      </div>
      <div
        className="rounded-2xl rounded-es-md border border-neutral-200/60 bg-white px-3.5 py-3 shadow-xs dark:border-neutral-800/55 dark:bg-neutral-950"
        aria-live="polite"
        aria-label={label}
      >
        <div className="flex items-center gap-1.5">
          {[0, 1, 2].map(i => (
            <span
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-neutral-400 dark:bg-neutral-500"
              style={{
                animation: 'assistant-typing-dot 1.05s ease-in-out infinite',
                animationDelay: `${i * 0.16}s`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
