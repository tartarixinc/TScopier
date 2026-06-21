import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { useTheme } from '../../context/ThemeContext'

const AUTH_LOGO_LIGHT = '/tscopierlogo.png'
const AUTH_LOGO_DARK = '/tscopierlogo-dark.png'

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
      alt="TScopier"
      className={clsx('h-8 w-auto max-w-[140px] object-contain', className)}
      draggable={false}
      onError={() => {
        if (src !== AUTH_LOGO_LIGHT) setSrc(AUTH_LOGO_LIGHT)
      }}
    />
  )
}
