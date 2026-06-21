import type { ContactSupportPageTranslations } from './types'

export const contactSupportEs: ContactSupportPageTranslations = {
  channelsTitle: '¿Cómo podemos ayudarte?',
  channelsSubtitle: 'Contacta al equipo de TScopier por correo, consulta la documentación o inicia un chat en vivo.',
  email: {
    title: 'Soporte por correo',
    description: 'Preguntas de cuenta, facturación o copier — solemos responder en un día hábil.',
    cta: 'Enviar correo',
  },
  docs: {
    title: 'Documentación',
    description: 'Guías paso a paso para brokers, canales de Telegram, estilos de trade y solución de problemas.',
    cta: 'Abrir docs',
  },
  liveChat: {
    title: 'Chat en vivo',
    description: 'Habla con nosotros en tiempo real para ayuda rápida mientras usas el panel.',
    cta: 'Iniciar chat',
  },
  faq: {
    title: 'Preguntas frecuentes',
    subtitle: 'Respuestas rápidas antes de contactarnos.',
    items: [
      {
        question: '¿Cómo conecto mi cuenta MetaTrader?',
        answer:
          'Abre Configuración, añade una cuenta de broker, introduce tus credenciales de MetaTrader y espera el estado conectado. Guarda estilo de trade, tamaño de lote y selección de canal antes de que empiece la copia.',
      },
      {
        question: '¿Por qué no se copian mis señales de Telegram?',
        answer:
          'Comprueba que el broker esté conectado, el canal de Telegram vinculado y activo, el canal seleccionado en el broker en Configuración, tu suscripción activa y el correo verificado. Revisa Copier Logs para motivos de skip.',
      },
      {
        question: '¿Cómo añado un canal de señales de Telegram?',
        answer:
          'Ve a Canales, conecta Telegram si hace falta y añade el usuario o enlace de invitación. Activa el canal y asígnalo a las cuentas de broker en Configuración.',
      },
      {
        question: '¿Qué hace el blackout de noticias / calendario económico?',
        answer:
          'Con el trading de noticias desactivado, TScopier puede pausar entradas y opcionalmente cerrar trades alrededor de eventos de alto impacto. Usa el Calendario económico y configura reglas en Configuración de cuenta.',
      },
      {
        question: '¿Necesito una suscripción de pago para copiar?',
        answer:
          'Se requiere un plan de pago activo para la ejecución live del copier de Telegram. Consulta Facturación para tu plan y renovación.',
      },
      {
        question: '¿Por qué debo verificar mi correo?',
        answer:
          'La verificación confirma tu acceso y permite enviar recibos y alertas importantes. Usa el enlace de reenvío o contacta soporte con el correo de registro.',
      },
      {
        question: 'Mi broker aparece desconectado — ¿qué hago?',
        answer:
          'Confirma que MetaTrader funciona en el broker, que las credenciales son válidas y que la cuenta no está bloqueada. Actualiza desde Configuración y revisa Copier Logs. Si persiste, escribe a soporte con el nombre del broker y el login (nunca la contraseña).',
      },
      {
        question: '¿Puedo copiar el mismo canal en varios brokers?',
        answer:
          'Sí. Vincula cada cuenta MetaTrader por separado en Configuración y selecciona el mismo canal de Telegram en cada broker. Lote y riesgo se configuran por cuenta.',
      },
    ],
  },
}
