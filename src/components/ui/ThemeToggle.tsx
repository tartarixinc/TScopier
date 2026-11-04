import { Moon, Sun } from 'lucide-react'
import clsx from 'clsx'
import { useTheme } from '../../context/ThemeContext'

interface ThemeToggleProps {
  className?: string
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme()
  const isDark = theme === 'dark'

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={clsx(
        'p-2 rounded-lg transition-colors',
        'text-neutral-900 dark:text-neutral-50 hover:text-neutral-900 dark:hover:text-neutral-50 hover:bg-neutral-100',
        'dark:text-neutral-50 dark:hover:text-neutral-100 dark:hover:bg-neutral-800',
        className,
      )}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Light mode' : 'Dark mode'}
    >
      {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
    </button>
  )
}
