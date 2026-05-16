import type { AuthTranslations } from './types'

export const authEs: AuthTranslations = {
  nav: {
    signIn: 'Iniciar sesión',
    createAccount: 'Crear cuenta',
    mobileTagline: 'Un copiador fluido para cada señal de Telegram',
  },
  login: {
    title: 'Bienvenido de nuevo',
    subtitle: 'Inicia sesión para gestionar tu copiador, canales y operaciones en vivo.',
    footerPrompt: '¿Nuevo en TSCopier?',
    footerLink: 'Crea una cuenta gratis',
    email: 'Correo electrónico',
    emailPlaceholder: 'tu@ejemplo.com',
    password: 'Contraseña',
    passwordPlaceholder: 'Introduce tu contraseña',
    submit: 'Iniciar sesión',
  },
  signup: {
    title: 'Crea tu cuenta',
    subtitle:
      'Configúralo en minutos: conecta Telegram, vincula un broker y empieza a copiar señales.',
    footerPrompt: '¿Ya tienes cuenta?',
    footerLink: 'Iniciar sesión',
    email: 'Correo electrónico',
    emailPlaceholder: 'tu@ejemplo.com',
    password: 'Contraseña',
    passwordPlaceholder: 'Elige una contraseña',
    passwordHint: 'Al menos 6 caracteres',
    passwordTooShort: 'La contraseña debe tener al menos 6 caracteres',
    submit: 'Crear cuenta',
    terms:
      'Al crear una cuenta, aceptas usar TSCopier de forma responsable y cumplir los términos de tu broker.',
  },
  marketing: {
    headline: 'Un copiador fluido para cada señal de Telegram',
    features: [
      {
        title: 'Conecta cualquier canal de señales',
        description: 'Vincula canales de Telegram y copia operaciones a tu broker en segundos.',
      },
      {
        title: 'Ejecuta con precisión',
        description: 'Análisis por palabras clave, escalones de TP y lógica de cesta para canales reales.',
      },
      {
        title: 'Mantén el control',
        description: 'Reglas por canal, límites de riesgo y registros en vivo de cada señal.',
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
