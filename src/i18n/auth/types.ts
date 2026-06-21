export interface AuthTranslations {
  nav: {
    signIn: string
    createAccount: string
    mobileTagline: string
    backHome: string
  }
  oauth: {
    continueWithGoogle: string
    orDivider: string
  }
  login: {
    heading: string
    noAccount: string
    signUpLink: string
    footerPrompt: string
    footerLink: string
    email: string
    emailPlaceholder: string
    password: string
    passwordPlaceholder: string
    forgotPassword: string
    passwordResetSuccess: string
    submit: string
  }
  forgotPassword: {
    heading: string
    subtitle: string
    email: string
    emailPlaceholder: string
    submit: string
    sentHeading: string
    sentSubtitle: string
    sentHint: string
    backToLogin: string
  }
  resetPassword: {
    heading: string
    subtitle: string
    password: string
    passwordPlaceholder: string
    confirmPassword: string
    confirmPasswordPlaceholder: string
    passwordHint: string
    passwordTooShort: string
    passwordMismatch: string
    submit: string
    invalidHeading: string
    invalidSubtitle: string
    requestNewLink: string
    backToLogin: string
  }
  signup: {
    heading: string
    hasAccount: string
    signInLink: string
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
    terms: {
      prefix: string
      termsOfService: string
      conjunction: string
      privacyPolicy: string
    }
  }
  verify: {
    heading: string
    subtitle: string
    instructions?: string
    resend: string
    resent: string
    backToLogin: string
    confirming?: string
    confirmingHint?: string
    confirmPending?: string
    confirmLinkExpired?: string
  }
  welcome: {
    title: string
    subtitle: string
    steps: string[]
    seePricing: string
    exploreDashboard: string
    errorFallback: string
    checkoutFailed: string
  }
  marketing: {
    headline: string
    copyright: string
    trustpilotLabel: string
    reviews: Array<{ headline?: string; quote: string; author: string; role?: string }>
  }
  language: {
    label: string
    choose: string
    searchPlaceholder: string
    noResults: string
  }
  theme: {
    light: string
    dark: string
    switchToLight: string
    switchToDark: string
  }
}
