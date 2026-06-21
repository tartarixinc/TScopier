import { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { User } from '@supabase/supabase-js'
import { resolveUserAvatarUrl, userInitials, type UserInitialsSource } from '../../lib/userAvatar'

export interface UserAvatarProps {
  user: User | null | undefined
  profile: UserInitialsSource
  email?: string | null
  size?: 'sm' | 'md'
  className?: string
}

const sizeClasses = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
}

export function UserAvatar({ user, profile, email, size = 'sm', className }: UserAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false)
  const avatarUrl = resolveUserAvatarUrl(user)
  const initials = userInitials(profile, email)

  useEffect(() => {
    setImageFailed(false)
  }, [avatarUrl])

  const showImage = Boolean(avatarUrl && !imageFailed)

  return (
    <div
      className={clsx(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-teal-600 font-semibold text-white',
        sizeClasses[size],
        className,
      )}
    >
      {showImage ? (
        <img
          src={avatarUrl!}
          alt=""
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      ) : (
        initials
      )}
    </div>
  )
}
