export interface AuthTranslations {
  nav: {
    signIn: string
    createAccount: string
    mobileTagline: string
  }
  oauth: {
    continueWithGoogle: string
    orDivider: string
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
    firstName: string
    firstNamePlaceholder: string
    lastName: string
    lastNamePlaceholder: string
    email: string
    emailPlaceholder: string
    password: string
    passwordPlaceholder: string
    confirmPassword: string
    confirmPasswordPlaceholder: string
    passwordHint: string
    passwordTooShort: string
    passwordMismatch: string
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
