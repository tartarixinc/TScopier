import { useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { useAuth } from '../context/AuthContext'
import {
  readAuthPresenceAvatarCookie,
  setAuthPresenceAvatarCookie,
  type AuthPresenceAvatar,
} from '../lib/authPresenceCookie'
import { resolveUserAvatarUrl, userInitials } from '../lib/userAvatar'
import { supabase } from '../lib/supabase'

function avatarFromUser(user: User): AuthPresenceAvatar {
  return {
    url: resolveUserAvatarUrl(user),
    initials: userInitials({}, user.email),
  }
}

/**
 * Avatar for the marketing header.
 * Prefer the live session + user_profiles row; fall back to the shared cookie
 * written by the app host (marketing and app do not share localStorage).
 */
export function useMarketingHeaderAvatar(): AuthPresenceAvatar {
  const { user } = useAuth()
  const [avatar, setAvatar] = useState<AuthPresenceAvatar>(() => {
    if (user) return avatarFromUser(user)
    return readAuthPresenceAvatarCookie() ?? { url: null, initials: null }
  })

  useEffect(() => {
    let cancelled = false

    const apply = (next: AuthPresenceAvatar) => {
      if (cancelled) return
      setAvatar(next)
      if (next.url || next.initials) setAuthPresenceAvatarCookie(next)
    }

    if (!user) {
      apply(readAuthPresenceAvatarCookie() ?? { url: null, initials: null })
      return () => {
        cancelled = true
      }
    }

    // Paint OAuth / metadata photo immediately, then upgrade from profile.
    apply(avatarFromUser(user))

    void (async () => {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('avatar_url, first_name, last_name')
        .eq('user_id', user.id)
        .maybeSingle()
      if (cancelled || error || !data) return
      const profile = {
        avatar_url: data.avatar_url ?? null,
        first_name: data.first_name ?? null,
        last_name: data.last_name ?? null,
      }
      apply({
        url: resolveUserAvatarUrl(user, profile),
        initials: userInitials(profile, user.email),
      })
    })()

    return () => {
      cancelled = true
    }
  }, [user])

  return avatar
}
