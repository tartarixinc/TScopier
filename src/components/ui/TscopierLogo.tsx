import clsx from 'clsx'
import { useTheme } from '../../context/ThemeContext'

const logoLight = '/tscopierlogo.png'
const logoDark = '/tscopierlogo-dark.png'
const logoCollapsed = '/tslogo-collapse.png'
/** Black wordmark. Shown on the light sidebar. */
const unicopierForLight = '/unicopier_dark.png'
/** White wordmark. Shown on the dark sidebar. */
const unicopierForDark = '/unicopier_light.png'

interface TscopierLogoProps {
  className?: string
  /** Sidebar collapsed icon (no separate dark asset). */
  collapsed?: boolean
  /** Product wordmark. */
  brand?: 'tscopier' | 'unicopier'
}

export function TscopierLogo({ className, collapsed, brand = 'unicopier' }: TscopierLogoProps) {
  const { isDark } = useTheme()

  if (brand === 'unicopier') {
    return (
      <img
        src={isDark ? unicopierForDark : unicopierForLight}
        alt="UniCopier"
        className={clsx(
          collapsed ? 'h-9 w-9 object-cover object-left' : className,
        )}
      />
    )
  }

  if (collapsed) {
    return (
      <img
        src={logoCollapsed}
        alt="UniCopier"
        className={clsx('h-10 w-10 object-contain', className)}
      />
    )
  }

  return (
    <img
      src={isDark ? logoDark : logoLight}
      alt="UniCopier"
      className={className}
    />
  )
}
