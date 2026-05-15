import clsx from 'clsx'
import { useTheme } from '../../context/ThemeContext'

const logoLight = '/tscopierlogo.png'
const logoDark = '/tscopierlogo-dark.png'
const logoCollapsed = '/tslogo-collapse.png'

interface TscopierLogoProps {
  className?: string
  /** Sidebar collapsed icon (no separate dark asset). */
  collapsed?: boolean
}

export function TscopierLogo({ className, collapsed }: TscopierLogoProps) {
  const { isDark } = useTheme()

  if (collapsed) {
    return (
      <img
        src={logoCollapsed}
        alt="TSCopier"
        className={clsx('h-10 w-10 object-contain', className)}
      />
    )
  }

  return (
    <img
      src={isDark ? logoDark : logoLight}
      alt="TSCopier"
      className={className}
    />
  )
}
