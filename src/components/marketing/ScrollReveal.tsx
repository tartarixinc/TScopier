import clsx from 'clsx'
import { motion, useReducedMotion, type HTMLMotionProps } from 'framer-motion'
import type { ReactNode } from 'react'

type ScrollRevealProps = {
  children: ReactNode
  className?: string
  /** Extra delay after the element enters the viewport (seconds). */
  delay?: number
  /** Starting vertical offset in px. */
  y?: number
  /** Animate only the first time it enters view. */
  once?: boolean
  /** How much of the element must be visible (0–1). */
  amount?: number
} & Omit<
  HTMLMotionProps<'div'>,
  'children' | 'initial' | 'animate' | 'whileInView' | 'viewport' | 'transition'
>

/**
 * Fades/slides content in when it scrolls into view.
 * Respects `prefers-reduced-motion`.
 */
export function ScrollReveal({
  children,
  className,
  delay = 0,
  y = 28,
  once = true,
  amount = 0.16,
  ...rest
}: ScrollRevealProps) {
  const reduceMotion = useReducedMotion()

  if (reduceMotion) {
    return <div className={className}>{children}</div>
  }

  return (
    <motion.div
      className={clsx(className)}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once, amount, margin: '0px 0px -6% 0px' }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1], delay }}
      {...rest}
    >
      {children}
    </motion.div>
  )
}
