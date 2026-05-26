import type { ReactNode } from 'react'
import { useSubscription } from '../../context/SubscriptionContext'
import type { PlanFeatureKey } from '../../lib/planLimits'
import { UpgradePrompt } from './UpgradePrompt'

interface FeatureGateProps {
  allowed: boolean
  reason: string
  title?: string
  children: ReactNode
  fallback?: ReactNode
  hideWhenBlocked?: boolean
}

export function FeatureGate({
  allowed,
  reason,
  title,
  children,
  fallback,
  hideWhenBlocked = false,
}: FeatureGateProps) {
  if (allowed) return <>{children}</>
  if (hideWhenBlocked) return null
  if (fallback) return <>{fallback}</>
  return <UpgradePrompt title={title} reason={reason} />
}

interface PlanFeatureGateProps {
  feature: PlanFeatureKey
  reason: string
  title?: string
  children: ReactNode
  fallback?: ReactNode
  hideWhenBlocked?: boolean
}

export function PlanFeatureGate({
  feature,
  reason,
  title,
  children,
  fallback,
  hideWhenBlocked,
}: PlanFeatureGateProps) {
  const { canUseFeature } = useSubscription()
  return (
    <FeatureGate
      allowed={canUseFeature(feature)}
      reason={reason}
      title={title}
      fallback={fallback}
      hideWhenBlocked={hideWhenBlocked}
    >
      {children}
    </FeatureGate>
  )
}
