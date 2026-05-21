import { useState } from 'react'
import clsx from 'clsx'

/** Wordmark for auth header — do not apply CSS invert/filter. */
const AUTH_LOGIN_LOGO = '/tscopier-login-logo.png'
const AUTH_LOGIN_LOGO_FALLBACK = '/tscopierlogo.png'

interface AuthBrandLogoProps {
  className?: string
}

export function AuthBrandLogo({ className }: AuthBrandLogoProps) {
  const [src, setSrc] = useState(AUTH_LOGIN_LOGO)

  return (
    <img
      src={src}
      alt="TSCopier"
      className={clsx('h-8 w-auto max-w-[140px] object-contain', className)}
      draggable={false}
      onError={() => {
        if (src !== AUTH_LOGIN_LOGO_FALLBACK) setSrc(AUTH_LOGIN_LOGO_FALLBACK)
      }}
    />
  )
}
