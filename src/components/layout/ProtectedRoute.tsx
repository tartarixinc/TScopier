import { Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useUserProfile } from '../../context/UserProfileContext'
import { isEmailVerified, verifyEmailPath } from '../../lib/emailVerification'

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const { emailVerifiedAt, loading: profileLoading } = useUserProfile()

  if (loading || profileLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-primary-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />

  if (!isEmailVerified(user, emailVerifiedAt)) {
    return <Navigate to={verifyEmailPath(user.email)} replace />
  }

  return <>{children}</>
}
