import { type InputHTMLAttributes, forwardRef } from 'react'
import clsx from 'clsx'
import { FieldLabelWithInfo } from './InfoTooltip'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
  /** When true, hint shows on an info icon by the label instead of below the input. */
  hintInTooltip?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, hintInTooltip, className, ...props }, ref) => {
    const showHintInTooltip = hintInTooltip === true
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          showHintInTooltip && hint && !error
            ? <FieldLabelWithInfo label={label} hint={hint} />
            : (
              <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                {label}
              </label>
            )
        )}
        <input
          ref={ref}
          className={clsx(
            'w-full px-3 py-2 text-base md:text-sm rounded-lg border transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent',
            error
              ? 'border-error-500 bg-error-50 dark:bg-error-950/40 text-neutral-900 dark:text-neutral-100'
              : 'border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 hover:border-neutral-300 dark:hover:border-neutral-600',
            className
          )}
          {...props}
        />
        {error && <p className="text-xs text-error-600">{error}</p>}
        {hint && !error && !showHintInTooltip && <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>}
      </div>
    )
  }
)

Input.displayName = 'Input'
