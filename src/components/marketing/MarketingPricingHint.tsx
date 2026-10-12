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
        'mt-3 text-center text-[0.625rem] leading-relaxed text-neutral-900 dark:text-neutral-50'
      }
    >
      {basic}
      <span className="mx-2 text-neutral-900 dark:text-neutral-50" aria-hidden>
        ·
      </span>
      {advanced}
    </p>
  )
}
