import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { isSupportAccessActive } from '../lib/supportAccess'

export function SupportGuard({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth()
  const [loading, setLoading] = useState(true)
  const [allowed, setAllowed] = useState(false)

  useEffect(() => {
    if (!user?.id) {
      setLoading(false)
      setAllowed(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void supabase
      .from('user_profiles')
      .select('is_admin, admin_until, is_support_agent')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setAllowed(false)
        else setAllowed(isSupportAccessActive(data))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user?.id])

  if (authLoading || loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-neutral-50 text-sm text-neutral-900">
        Checking support access…
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />
  if (!allowed) {
    return (
      <div className="grid min-h-screen place-items-center bg-neutral-50 px-4">
        <p className="text-center text-sm text-neutral-900">
          Support agent access required. Sign in with a support or admin account.
        </p>
      </div>
    )
  }

  return <>{children}</>
}
