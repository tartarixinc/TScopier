import { useEffect, useState } from 'react'
import {
  PRICING_SOCIAL_PROOF_BASE_COUNT,
  prefersReducedMotion,
  schedulePricingSocialProofLoop,
  type PricingSocialProofEvent,
} from '../lib/pricingSocialProof'

export interface UsePricingSocialProofResult {
  purchaseCount: number
  activeToast: PricingSocialProofEvent | null
  toastVisible: boolean
  reduceMotion: boolean
}

export function usePricingSocialProof(): UsePricingSocialProofResult {
  const [purchaseCount, setPurchaseCount] = useState(PRICING_SOCIAL_PROOF_BASE_COUNT)
  const [activeToast, setActiveToast] = useState<PricingSocialProofEvent | null>(null)
  const [toastVisible, setToastVisible] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(() => prefersReducedMotion())

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduceMotion(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const stop = schedulePricingSocialProofLoop({
      onToast: event => {
        setActiveToast(event)
        setToastVisible(true)
        setPurchaseCount(count => count + 1)
      },
      onDismiss: () => {
        setToastVisible(false)
      },
    })

    return stop
  }, [])

  return {
    purchaseCount,
    activeToast,
    toastVisible,
    reduceMotion,
  }
}
