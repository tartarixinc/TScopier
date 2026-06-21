import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { isAdminAccessActive } from '../lib/adminAccess'

export function AdminGuard({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth()
  const [loading, setLoading] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    if (!user?.id) {
      setLoading(false)
      setIsAdmin(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void supabase
      .from('user_profiles')
      .select('is_admin, admin_until')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          setIsAdmin(false)
        } else {
          setIsAdmin(isAdminAccessActive(data))
        }
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user?.id])

  if (authLoading || loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-neutral-50 text-sm text-neutral-500 dark:bg-neutral-950">
        Checking admin access…
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />
  if (!isAdmin) {
    return (
      <div className="grid min-h-screen place-items-center bg-neutral-50 px-4 dark:bg-neutral-950">
        <p className="text-center text-sm text-neutral-600 dark:text-neutral-400">
          Admin access required. Sign in with an admin account.
        </p>
      </div>
    )
  }

  return <>{children}</>
}
