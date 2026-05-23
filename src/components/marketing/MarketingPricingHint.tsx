interface MarketingPricingHintProps {
  basic: string
  advanced: string
  className?: string
}

export function MarketingPricingHint({ basic, advanced, className }: MarketingPricingHintProps) {
  return (
    <p
      className={
        className ??
        'mt-3 text-center text-[0.625rem] leading-relaxed text-neutral-500 dark:text-neutral-400'
      }
    >
      {basic}
      <span className="mx-2 text-neutral-300 dark:text-neutral-600" aria-hidden>
        ·
      </span>
      {advanced}
    </p>
  )
}
