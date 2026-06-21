import { type SelectHTMLAttributes, forwardRef } from 'react'
import clsx from 'clsx'
import { FieldLabelWithInfo } from './InfoTooltip'

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  hint?: string
  hintInTooltip?: boolean
  options: { value: string; label: string }[]
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, hint, hintInTooltip, options, className, ...props }, ref) => {
    const showHintInTooltip = hintInTooltip === true
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          showHintInTooltip && hint && !error
            ? <FieldLabelWithInfo label={label} hint={hint} />
            : (
              <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{label}</label>
            )
        )}
        <select
          ref={ref}
          className={clsx(
            'w-full px-3 py-2 text-base md:text-sm rounded-lg border bg-white dark:bg-neutral-900 transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent appearance-none',
            error
              ? 'border-error-500 text-neutral-900 dark:text-neutral-100'
              : 'border-neutral-200 dark:border-neutral-700 text-neutral-900 dark:text-neutral-100 hover:border-neutral-300 dark:hover:border-neutral-600',
            className
          )}
          {...props}
        >
          {options.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        {error && <p className="text-xs text-error-600">{error}</p>}
        {hint && !error && !showHintInTooltip && <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>}
      </div>
    )
  }
)

Select.displayName = 'Select'
