import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchMyProviderApplication, type ProviderApplicationStatus } from '../lib/providerApplication'

/** Lightweight read of the caller's provider application status (null = never applied). */
export function useProviderStatus(): { status: ProviderApplicationStatus | null; slug: string | null; loading: boolean } {
  const [state, setState] = useState<{ status: ProviderApplicationStatus | null; slug: string | null; loading: boolean }>({ status: null, slug: null, loading: true })
  useEffect(() => {
    let active = true
    fetchMyProviderApplication(supabase)
      .then(application => { if (active) setState({ status: application?.status ?? null, slug: application?.slug ?? null, loading: false }) })
      .catch(() => { if (active) setState({ status: null, slug: null, loading: false }) })
    return () => { active = false }
  }, [])
  return state
}

export function providerEntryLabel(status: ProviderApplicationStatus | null): string {
  switch (status) {
    case 'approved': return 'Manage provider profile'
    case 'pending': return 'Application under review'
    case 'rejected': return 'Update your application'
    case 'suspended': return 'Provider profile suspended'
    case 'draft': return 'Continue your application'
    default: return 'Become a provider'
  }
}
