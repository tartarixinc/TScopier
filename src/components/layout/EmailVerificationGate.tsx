import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useUserProfile } from '../../context/UserProfileContext'
import {
  EMAIL_VERIFICATION_EXEMPT_PATHS,
  isEmailVerified,
  verifyEmailPath,
} from '../../lib/emailVerification'

/** Blocks the app for email/password users until profile.email_verified_at is set. */
export function EmailVerificationGate() {
  const { user, loading } = useAuth()
  const { emailVerifiedAt, loading: profileLoading } = useUserProfile()
  const location = useLocation()

  if (loading || (user && profileLoading)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-primary-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (
    user
    && !isEmailVerified(user, emailVerifiedAt)
    && !EMAIL_VERIFICATION_EXEMPT_PATHS.has(location.pathname)
  ) {
    return <Navigate to={verifyEmailPath(user.email)} replace />
  }

  return <Outlet />
}
