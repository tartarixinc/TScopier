import {
  Activity,
  BookOpen,
  CalendarDays,
  ChartNoAxesCombined,
  ClipboardList,
  CreditCard,
  Flag,
  Flame,
  FlaskConical,
  Handshake,
  Landmark,
  LayoutDashboard,
  LifeBuoy,
  Lightbulb,
  Newspaper,
  Radio,
  Repeat,
  Settings,
  Share2,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'

/** Single source of truth for app navigation icons (sidebar, search, previews). */
export const APP_ROUTE_ICONS: Record<string, LucideIcon> = {
  '/dashboard': LayoutDashboard,
  '/brokers': Landmark,
  '/account-trades': ChartNoAxesCombined,
  '/activities': Activity,
  '/settings': Settings,
  '/channels': Radio,
  '/popular-channels': Flame,
  '/backtest': FlaskConical,
  '/copier-logs': ClipboardList,
  '/reported-trades': Flag,
  '/manage-signals': SlidersHorizontal,
  '/performance': TrendingUp,
  '/market-news': Newspaper,
  '/economic-calendar': CalendarDays,
  '/contact-support': LifeBuoy,
  '/feature-request': Lightbulb,
  '/partner-with-us': Handshake,
  '/affiliate-program': Share2,
  '/billing': CreditCard,
  '/subscriptions': Repeat,
  '/updates': Sparkles,
}

export const APP_HELP_ICONS = {
  documentation: BookOpen,
} as const

export function getAppRouteIcon(path: string): LucideIcon {
  return APP_ROUTE_ICONS[path] ?? LayoutDashboard
}
