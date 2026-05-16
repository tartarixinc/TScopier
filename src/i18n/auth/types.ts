export interface AuthTranslations {
  nav: {
    signIn: string
    createAccount: string
    mobileTagline: string
  }
  login: {
    title: string
    subtitle: string
    footerPrompt: string
    footerLink: string
    email: string
    emailPlaceholder: string
    password: string
    passwordPlaceholder: string
    submit: string
  }
  signup: {
    title: string
    subtitle: string
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
    features: Array<{ title: string; description: string }>
    copyright: string
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
