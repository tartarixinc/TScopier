import { useMemo } from 'react'
import { useAuth } from '../context/AuthContext'
import { useUserProfile } from '../context/UserProfileContext'
import { isEmailVerified } from '../lib/emailVerification'

/** Welcome modal overlay; dashboard loads behind it for a live preview. */
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
      /** Only defer bootstrap while auth/profile is still resolving. */
      deferAppBootstrap: resolving,
      resolving,
    }
  }, [user, authLoading, profileLoading, emailVerifiedAt, onboardingCompletedAt])
}
