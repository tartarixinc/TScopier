import { createContext, useContext, useEffect, useState } from 'react'
import type { User, Session } from '@supabase/supabase-js'
import { clearAuthPresenceCookie, setAuthPresenceCookie } from '../lib/authPresenceCookie'
import { supabase } from '../lib/supabase'
import { invalidateRealtimeReadyCache } from '../lib/whenRealtimeReady'
import { clearDashboardSessionCache } from '../lib/dashboardSessionCache'
import { clearPerformanceSessionCache } from '../lib/performanceSessionCache'
import { clearTradesSessionCache } from '../lib/tradesSessionCache'

interface AuthContextValue {
  user: User | null
  session: Session | null
  loading: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  session: null,
  loading: true,
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const applySession = (next: Session | null) => {
      setSession(next)
      setUser(prev => {
        const nextUser = next?.user ?? null
        // TOKEN_REFRESHED fires on tab focus with a new object reference — keep
        // the stable reference so downstream [user] effects don't remount the app.
        if (prev?.id != null && nextUser?.id === prev.id) return prev
        return nextUser
      })
      if (next?.user) setAuthPresenceCookie()
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      applySession(session)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      applySession(session)
      if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') {
        invalidateRealtimeReadyCache()
      }
      if (event === 'SIGNED_OUT') clearAuthPresenceCookie()
      setLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  const signOut = async () => {
    const uid = user?.id ?? null
    clearDashboardSessionCache(uid)
    clearPerformanceSessionCache(uid)
    clearTradesSessionCache(uid)
    await supabase.auth.signOut()
    clearAuthPresenceCookie()
  }

  return (
    <AuthContext.Provider value={{ user, session, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
