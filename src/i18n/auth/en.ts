import type { AuthTranslations } from './types'

export const authEn: AuthTranslations = {
  nav: {
    signIn: 'Sign in',
    createAccount: 'Create account',
    mobileTagline: 'One seamless copier for every Telegram signal',
  },
  login: {
    footerPrompt: 'New to TSCopier?',
    footerLink: 'Create a free account',
    email: 'Email',
    emailPlaceholder: 'you@example.com',
    password: 'Password',
    passwordPlaceholder: 'Enter your password',
    submit: 'Sign in',
  },
  signup: {
    footerPrompt: 'Already have an account?',
    footerLink: 'Sign in',
    firstName: 'First name',
    firstNamePlaceholder: 'First name',
    lastName: 'Last name',
    lastNamePlaceholder: 'Last name',
    email: 'Email',
    emailPlaceholder: 'you@example.com',
    password: 'Password',
    passwordPlaceholder: 'Choose a password',
    confirmPassword: 'Confirm password',
    confirmPasswordPlaceholder: 'Re-enter your password',
    passwordHint: 'At least 6 characters',
    passwordTooShort: 'Password must be at least 6 characters',
    passwordMismatch: 'Passwords do not match',
    submit: 'Create account',
    terms:
      "By creating an account, you agree to use TSCopier responsibly and comply with your broker's terms.",
  },
  marketing: {
    headline: 'One Seamless Copier for every Telegram Signal',
    trustpilotLabel: 'Trustpilot',
    reviews: [
      {
        quote:
          'TSCopier cut my manual copying time to almost zero. Signals land on my MT5 account within seconds — exactly what I needed for my Telegram channels.',
        author: 'Rob Flemming',
      },
      {
        quote:
          'Clean dashboard, reliable parsing, and the copier logs make debugging easy. Support answered quickly when I had a broker question.',
        author: 'Sarah Mitchell',
      },
      {
        quote:
          'This is the simplest and most reliable signal copier I have ever used. Better than the rest with it\'s range and layer trading, worse entries closing feature, I can copy signals with rest of mind.',
        author: 'Eloise Laurent',
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
