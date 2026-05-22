import type { AuthTranslations } from './types'

export const authFr: AuthTranslations = {
  nav: {
    signIn: 'Connexion',
    createAccount: 'Créer un compte',
    mobileTagline: 'Un copieur fluide pour chaque signal Telegram',
  },
  oauth: {
    continueWithGoogle: 'Continuer avec Google',
    orDivider: 'ou',
  },
  login: {
    footerPrompt: 'Nouveau sur TSCopier ?',
    footerLink: 'Créer un compte gratuit',
    email: 'E-mail',
    emailPlaceholder: 'vous@exemple.com',
    password: 'Mot de passe',
    passwordPlaceholder: 'Entrez votre mot de passe',
    submit: 'Se connecter',
  },
  signup: {
    footerPrompt: 'Vous avez déjà un compte ?',
    footerLink: 'Se connecter',
    firstName: 'Prénom',
    firstNamePlaceholder: 'Prénom',
    lastName: 'Nom',
    lastNamePlaceholder: 'Nom',
    email: 'E-mail',
    emailPlaceholder: 'vous@exemple.com',
    password: 'Mot de passe',
    passwordPlaceholder: 'Choisissez un mot de passe',
    confirmPassword: 'Confirmer le mot de passe',
    confirmPasswordPlaceholder: 'Saisissez à nouveau votre mot de passe',
    passwordHint: 'Au moins 6 caractères',
    passwordTooShort: 'Le mot de passe doit contenir au moins 6 caractères',
    passwordMismatch: 'Les mots de passe ne correspondent pas',
    submit: 'Créer un compte',
    terms:
      "En créant un compte, vous acceptez d'utiliser TSCopier de manière responsable et de respecter les conditions de votre broker.",
  },
  marketing: {
    headline: 'Un copieur fluide pour chaque signal Telegram',
    trustpilotLabel: 'Trustpilot',
    reviews: [
      {
        quote:
          'TSCopier a presque éliminé mon temps de copie manuelle. Les signaux arrivent sur mon compte MT5 en quelques secondes — exactement ce qu’il me fallait pour mes canaux Telegram.',
        author: 'Rob Flemming',
      },
      {
        quote:
          'Tableau de bord clair, analyse fiable et journaux du copieur faciles à déboguer. Le support a répondu vite pour une question broker.',
        author: 'Sarah Mitchell',
      },
      {
        quote:
          'C\'est le copieur de signaux le plus simple et le plus fiable que j\'aie jamais utilisé. Meilleur que les autres grâce à son système de trading par plage et par couches, et malgré une fonction de fermeture automatique des entrées moins performante, je peux copier les signaux en toute sérénité.',
        author: 'Eloise Laurent',
      },
    ],
    copyright: '© {year} Tartarix Inc.',
  },
  language: {
    label: 'Langue',
    choose: 'Choisir la langue',
  },
  theme: {
    light: 'Mode clair',
    dark: 'Mode sombre',
    switchToLight: 'Passer en mode clair',
    switchToDark: 'Passer en mode sombre',
  },
}
