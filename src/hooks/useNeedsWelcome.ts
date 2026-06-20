import { useMemo } from 'react'
import { useAuth } from '../context/AuthContext'
import { useUserProfile } from '../context/UserProfileContext'
import { isEmailVerified } from '../lib/emailVerification'

/** Welcome modal + defer heavy dashboard/broker bootstrap until onboarding is done. */
export function useNeedsWelcome() {
  const { user, loading: authLoading } = useAuth()
  const { onboardingCompletedAt, emailVerifiedAt, loading: profileLoading } = useUserProfile()

  return useMemo(() => {
    const resolving = authLoading || profileLoading
    const needsWelcome = Boolean(
      user
      && !resolving
      && isEmailVerified(user, emailVerifiedAt)
      && !onboardingCompletedAt,
    )
    return {
      needsWelcome,
      /** Skip broker/dashboard/notifications fetches while welcome may appear. */
      deferAppBootstrap: resolving || needsWelcome,
      resolving,
    }
  }, [user, authLoading, profileLoading, emailVerifiedAt, onboardingCompletedAt])
}
