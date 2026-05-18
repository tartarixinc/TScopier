import type { AuthTranslations } from './types'

export const authFr: AuthTranslations = {
  nav: {
    signIn: 'Connexion',
    createAccount: 'Créer un compte',
    mobileTagline: 'Un copieur fluide pour chaque signal Telegram',
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
    email: 'E-mail',
    emailPlaceholder: 'vous@exemple.com',
    password: 'Mot de passe',
    passwordPlaceholder: 'Choisissez un mot de passe',
    passwordHint: 'Au moins 6 caractères',
    passwordTooShort: 'Le mot de passe doit contenir au moins 6 caractères',
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
          'Nous gérons plusieurs canaux de signaux sur deux comptes. La logique panier et les paliers de TP surpassent notre ancienne stack.',
        author: 'James Okonkwo',
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
