import type { AuthTranslations } from './types'

export const authFr: AuthTranslations = {
  nav: {
    signIn: 'Connexion',
    createAccount: 'Créer un compte',
    mobileTagline: 'Un copieur fluide pour chaque signal Telegram',
  },
  login: {
    title: 'Bon retour',
    subtitle: 'Connectez-vous pour gérer votre copieur, vos canaux et vos trades en direct.',
    footerPrompt: 'Nouveau sur TSCopier ?',
    footerLink: 'Créer un compte gratuit',
    email: 'E-mail',
    emailPlaceholder: 'vous@exemple.com',
    password: 'Mot de passe',
    passwordPlaceholder: 'Entrez votre mot de passe',
    submit: 'Se connecter',
  },
  signup: {
    title: 'Créez votre compte',
    subtitle:
      'Configuration en quelques minutes — connectez Telegram, liez un broker et copiez les signaux.',
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
    features: [
      {
        title: 'Connectez tout canal de signaux',
        description: 'Liez des canaux Telegram et copiez les trades vers votre broker en quelques secondes.',
      },
      {
        title: 'Exécutez avec précision',
        description: 'Analyse par mots-clés, paliers de TP et logique panier pour de vrais canaux.',
      },
      {
        title: 'Gardez le contrôle',
        description: 'Règles par canal, limites de risque et journaux en direct pour chaque signal.',
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
