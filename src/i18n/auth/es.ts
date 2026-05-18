import type { AuthTranslations } from './types'

export const authEs: AuthTranslations = {
  nav: {
    signIn: 'Iniciar sesión',
    createAccount: 'Crear cuenta',
    mobileTagline: 'Un copiador fluido para cada señal de Telegram',
  },
  login: {
    footerPrompt: '¿Nuevo en TSCopier?',
    footerLink: 'Crea una cuenta gratis',
    email: 'Correo electrónico',
    emailPlaceholder: 'tu@ejemplo.com',
    password: 'Contraseña',
    passwordPlaceholder: 'Introduce tu contraseña',
    submit: 'Iniciar sesión',
  },
  signup: {
    footerPrompt: '¿Ya tienes cuenta?',
    footerLink: 'Iniciar sesión',
    firstName: 'Nombre',
    firstNamePlaceholder: 'Nombre',
    lastName: 'Apellido',
    lastNamePlaceholder: 'Apellido',
    email: 'Correo electrónico',
    emailPlaceholder: 'tu@ejemplo.com',
    password: 'Contraseña',
    passwordPlaceholder: 'Elige una contraseña',
    confirmPassword: 'Confirmar contraseña',
    confirmPasswordPlaceholder: 'Vuelve a escribir tu contraseña',
    passwordHint: 'Al menos 6 caracteres',
    passwordTooShort: 'La contraseña debe tener al menos 6 caracteres',
    passwordMismatch: 'Las contraseñas no coinciden',
    submit: 'Crear cuenta',
    terms:
      'Al crear una cuenta, aceptas usar TSCopier de forma responsable y cumplir los términos de tu broker.',
  },
  marketing: {
    headline: 'Un copiador fluido para cada señal de Telegram',
    trustpilotLabel: 'Trustpilot',
    reviews: [
      {
        quote:
          'TSCopier redujo casi a cero mi tiempo copiando a mano. Las señales llegan a mi cuenta MT5 en segundos — justo lo que necesitaba para mis canales de Telegram.',
        author: 'Rob Flemming',
      },
      {
        quote:
          'Panel claro, análisis fiable y los registros del copiador facilitan depurar. El soporte respondió rápido cuando tuve una duda con el broker.',
        author: 'Sarah Mitchell',
      },
      {
        quote:
          'Este es el copiador de señales más sencillo y fiable que he usado. Es mejor que los demás en cuanto a rango y negociación por capas, aunque su función de cierre de entradas es peor. Puedo copiar señales con total tranquilidad.',
        author: 'Eloise Laurent',
      },
    ],
    copyright: '© {year} Tartarix Inc.',
  },
  language: {
    label: 'Idioma',
    choose: 'Elegir idioma',
  },
  theme: {
    light: 'Modo claro',
    dark: 'Modo oscuro',
    switchToLight: 'Cambiar a modo claro',
    switchToDark: 'Cambiar a modo oscuro',
  },
}
