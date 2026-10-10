import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { useTheme } from '../../context/ThemeContext'

/** Black wordmark for light backgrounds. */
const AUTH_LOGO_LIGHT = '/unicopier_dark.png'
/** White wordmark for dark backgrounds. */
const AUTH_LOGO_DARK = '/unicopier_light.png'

interface AuthBrandLogoProps {
  className?: string
}

export function AuthBrandLogo({ className }: AuthBrandLogoProps) {
  const { isDark } = useTheme()
  const themedSrc = isDark ? AUTH_LOGO_DARK : AUTH_LOGO_LIGHT
  const [src, setSrc] = useState(themedSrc)

  useEffect(() => {
    setSrc(isDark ? AUTH_LOGO_DARK : AUTH_LOGO_LIGHT)
  }, [isDark])

  return (
    <img
      src={src}
      alt="UniCopier"
      className={clsx('h-14 w-auto max-w-[200px] object-contain', className)}
      draggable={false}
      onError={() => {
        if (src !== AUTH_LOGO_LIGHT) setSrc(AUTH_LOGO_LIGHT)
      }}
    />
  )
}
