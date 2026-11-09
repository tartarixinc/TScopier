import { useEffect, useRef, useState } from 'react'
import { ChevronDown, LogOut } from 'lucide-react'
import clsx from 'clsx'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

type AgentProfile = {
  first_name: string | null
  last_name: string | null
  display_name: string | null
  avatar_url: string | null
  is_support_agent: boolean | null
  is_admin: boolean | null
}

function pickAvatarUrl(user: User | null, profile: AgentProfile | null): string | null {
  const fromProfile = profile?.avatar_url?.trim()
  if (fromProfile) return fromProfile
  if (!user) return null
  const meta = user.user_metadata as Record<string, unknown> | undefined
  for (const key of ['avatar_url', 'picture', 'photo_url'] as const) {
    const value = meta?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  for (const identity of user.identities ?? []) {
    const data = identity.identity_data as Record<string, unknown> | undefined
    for (const key of ['avatar_url', 'picture', 'photo_url'] as const) {
      const value = data?.[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return null
}

function displayName(user: User | null, profile: AgentProfile | null): string {
  const fromProfile =
    [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim() ||
    profile?.display_name?.trim()
  if (fromProfile) return fromProfile
  const meta = user?.user_metadata as Record<string, unknown> | undefined
  const fullName = typeof meta?.full_name === 'string' ? meta.full_name.trim() : ''
  if (fullName) return fullName
  return user?.email?.split('@')[0] || 'Agent'
}

function initials(name: string, email?: string | null): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase()
  if (parts[0]) return parts[0].slice(0, 2).toUpperCase()
  return (email?.slice(0, 2) || 'U').toUpperCase()
}

function AgentAvatar({
  user,
  profile,
  size = 'sm',
}: {
  user: User | null
  profile: AgentProfile | null
  size?: 'sm' | 'md'
}) {
  const [failed, setFailed] = useState(false)
  const src = pickAvatarUrl(user, profile)
  const name = displayName(user, profile)
  const sizeClass = size === 'md' ? 'h-10 w-10 text-sm' : 'h-8 w-8 text-xs'

  useEffect(() => {
    setFailed(false)
  }, [src])

  return (
    <span
      className={clsx(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-green-400 font-semibold text-neutral-950',
        sizeClass,
      )}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        initials(name, user?.email)
      )}
    </span>
  )
}

export function UserMenu() {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [profile, setProfile] = useState<AgentProfile | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!user?.id) {
      setProfile(null)
      return
    }
    let cancelled = false
    void supabase
      .from('user_profiles')
      .select('first_name, last_name, display_name, avatar_url, is_support_agent, is_admin')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setProfile((data as AgentProfile | null) ?? null)
      })
    return () => {
      cancelled = true
    }
  }, [user?.id])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const signOut = async () => {
    setOpen(false)
    await supabase.auth.signOut()
  }

  const name = displayName(user, profile)
  const role =
    profile?.is_admin === true
      ? 'Admin'
      : profile?.is_support_agent === true
        ? 'Support agent'
        : 'Agent'

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className={clsx(
          'inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white py-1 pl-1 pr-2.5 text-left transition hover:bg-neutral-50',
          open && 'bg-neutral-50 ring-2 ring-green-400/30',
        )}
      >
        <AgentAvatar user={user} profile={profile} />
        <span className="hidden min-w-0 sm:block">
          <span className="block max-w-[9rem] truncate text-xs font-semibold text-neutral-900">
            {name}
          </span>
        </span>
        <ChevronDown
          className={clsx(
            'h-3.5 w-3.5 text-neutral-400 transition',
            open && 'rotate-180 text-neutral-600',
          )}
        />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Account menu"
          className="absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg"
        >
          <div className="border-b border-neutral-100 px-3 py-3">
            <div className="flex items-center gap-3">
              <AgentAvatar user={user} profile={profile} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-neutral-900">{name}</p>
                <p className="truncate text-xs text-neutral-500">{user?.email}</p>
                <p className="mt-0.5 text-xs font-medium text-green-600">{role}</p>
              </div>
            </div>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => void signOut()}
            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm font-medium text-red-600 transition hover:bg-red-50"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-50 text-red-600">
              <LogOut className="h-4 w-4" />
            </span>
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  )
}
