export interface AuthTranslations {
  nav: {
    signIn: string
    createAccount: string
    mobileTagline: string
  }
  login: {
    footerPrompt: string
    footerLink: string
    email: string
    emailPlaceholder: string
    password: string
    passwordPlaceholder: string
    submit: string
  }
  signup: {
    footerPrompt: string
    footerLink: string
    email: string
    emailPlaceholder: string
    password: string
    passwordPlaceholder: string
    passwordHint: string
    passwordTooShort: string
    submit: string
    terms: string
  }
  marketing: {
    headline: string
    copyright: string
    trustpilotLabel: string
    reviews: Array<{ quote: string; author: string }>
  }
  language: {
    label: string
    choose: string
  }
  theme: {
    light: string
    dark: string
    switchToLight: string
    switchToDark: string
  }
}
