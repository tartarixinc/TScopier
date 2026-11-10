import { forwardRef, useImperativeHandle, useRef } from 'react'
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile'
import { isTurnstileEnabled, turnstileSiteKey } from '../lib/turnstile'

export type TurnstileWidgetHandle = {
  reset: () => void
}

type TurnstileWidgetProps = {
  onToken: (token: string) => void
  onExpire?: () => void
  onError?: () => void
  className?: string
}

export const TurnstileWidget = forwardRef<TurnstileWidgetHandle, TurnstileWidgetProps>(
  function TurnstileWidget({ onToken, onExpire, onError, className }, ref) {
    const widgetRef = useRef<TurnstileInstance>(null)

    useImperativeHandle(ref, () => ({
      reset: () => {
        widgetRef.current?.reset()
      },
    }))

    if (!isTurnstileEnabled()) {
      return null
    }

    return (
      <div className={className}>
        <Turnstile
          ref={widgetRef}
          siteKey={turnstileSiteKey()}
          onSuccess={onToken}
          onExpire={() => {
            onExpire?.()
          }}
          onError={() => {
            onError?.()
          }}
          options={{
            theme: 'auto',
            size: 'flexible',
          }}
        />
      </div>
    )
  },
)
