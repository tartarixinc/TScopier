import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSubscription } from '../../context/SubscriptionContext'

/** Legacy /pricing route — opens the plan modal and returns to the dashboard. */
export function PricingPageRedirect() {
  const navigate = useNavigate()
  const { openPricingModal } = useSubscription()

  useEffect(() => {
    openPricingModal()
    navigate('/dashboard', { replace: true })
  }, [navigate, openPricingModal])

  return null
}
