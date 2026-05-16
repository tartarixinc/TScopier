import clsx from 'clsx'

/** Wordmark for dark auth surfaces — do not apply CSS invert/filter. */
const AUTH_LOGIN_LOGO = '/tscopier-login-logo.png'

interface AuthBrandLogoProps {
  className?: string
}

export function AuthBrandLogo({ className }: AuthBrandLogoProps) {
  return (
    <img
      src={AUTH_LOGIN_LOGO}
      alt="TSCopier AI"
      className={clsx('h-8 w-auto max-w-[140px] object-contain', className)}
      draggable={false}
    />
  )
}
