import type { AuthTranslations } from './types'

export const authEn: AuthTranslations = {
  nav: {
    signIn: 'Sign in',
    createAccount: 'Create account',
    mobileTagline: 'One seamless copier for every Telegram signal',
  },
  login: {
    title: 'Welcome back',
    subtitle: 'Sign in to manage your copier, channels, and live trades.',
    footerPrompt: 'New to TSCopier?',
    footerLink: 'Create a free account',
    email: 'Email',
    emailPlaceholder: 'you@example.com',
    password: 'Password',
    passwordPlaceholder: 'Enter your password',
    submit: 'Sign in',
  },
  signup: {
    title: 'Create your account',
    subtitle: 'Set up in minutes — connect Telegram, link a broker, and start copying signals.',
    footerPrompt: 'Already have an account?',
    footerLink: 'Sign in',
    email: 'Email',
    emailPlaceholder: 'you@example.com',
    password: 'Password',
    passwordPlaceholder: 'Choose a password',
    passwordHint: 'At least 6 characters',
    passwordTooShort: 'Password must be at least 6 characters',
    submit: 'Create account',
    terms:
      "By creating an account, you agree to use TSCopier responsibly and comply with your broker's terms.",
  },
  marketing: {
    headline: 'One Seamless Copier for every Telegram Signal',
    features: [
      {
        title: 'Connect any signal channel',
        description: 'Link Telegram channels and copy trades to your broker in seconds.',
      },
      {
        title: 'Execute with precision',
        description: 'Keyword parsing, TP ladders, and basket logic built for real channels.',
      },
      {
        title: 'Stay in control',
        description: 'Per-channel rules, risk limits, and live logs on every signal.',
      },
    ],
    copyright: '© {year} Tartarix Inc.',
  },
  language: {
    label: 'Language',
    choose: 'Choose language',
  },
  theme: {
    light: 'Light mode',
    dark: 'Dark mode',
    switchToLight: 'Switch to light mode',
    switchToDark: 'Switch to dark mode',
  },
}
