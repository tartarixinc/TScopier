import type { LegalDocumentPageTranslations } from './types'
import { legalContactEs } from './contactEs'

export const cookiePolicyEs: LegalDocumentPageTranslations = {
  title: 'Política de cookies',
  lastUpdated: 'Última actualización: 8 de junio de 2026',
  intro:
    'Esta Política de cookies explica cómo Tartarix, Inc. («nosotros» o «nuestro») utiliza cookies y tecnologías similares en los sitios web y aplicaciones de TScopier. Debe leerse junto con nuestra Política de privacidad.',
  sections: [
    {
      title: '1. ¿Qué son las cookies?',
      paragraphs: [
        'Las cookies son pequeños archivos de texto almacenados en su dispositivo cuando visita un sitio web. Las tecnologías similares incluyen almacenamiento local, almacenamiento de sesión y píxeles. Ayudan a los sitios a recordar preferencias, mantenerle conectado y comprender cómo se utiliza el Servicio.',
      ],
    },
    {
      title: '2. Cómo utilizamos las cookies',
      paragraphs: [
        'Cookies esenciales: necesarias para la autenticación, la seguridad, la atribución de referidos y la funcionalidad principal (p. ej., estado de sesión, presencia de autenticación entre subdominios cuando esté configurado). No pueden desactivarse mientras utiliza el Servicio.',
        'Cookies de preferencias: recuerdan opciones como el idioma, el estado del consentimiento de cookies y los banners descartados.',
        'Cookies de analítica: cuando acepta las cookies en nuestro banner, podemos utilizar Google Analytics e identificadores relacionados para comprender el tráfico y el uso de funciones. Los eventos de analítica pueden incluir rutas de página, códigos de referido e identificadores seudónimos — no sus contraseñas de bróker ni instrucciones de trading.',
      ],
    },
    {
      title: '3. Cookies que establecemos',
      paragraphs: [
        'Los ejemplos incluyen: cookies de autenticación/sesión de nuestro proveedor de autenticación; tsc_tracking_consent y tsc_tracking_seen_ts (su elección en el banner de cookies); tsc_analytics_id (identificador de analítica seudónimo cuando la analítica está activa); tsc_ref y tsc_ref_ts (atribución de referidos); tsc_auth (indicador breve de inicio de sesión entre subdominios cuando esté habilitado).',
        'Los nombres y periodos de vigencia pueden cambiar a medida que mejoremos el Servicio. Las cookies esenciales generalmente expiran cuando cierra sesión o tras un periodo de seguridad definido.',
      ],
    },
    {
      title: '4. Cookies de terceros',
      paragraphs: [
        'Terceros como Google (Analytics), Stripe (pago) y nuestros proveedores de alojamiento pueden establecer sus propias cookies cuando interactúa con sus funciones. Su uso se rige por sus políticas.',
      ],
    },
    {
      title: '5. Sus opciones',
      paragraphs: [
        'En su primera visita, nuestro banner de cookies le permite aceptar o rechazar el seguimiento no esencial. Puede cambiar la configuración de su navegador para bloquear o eliminar cookies; bloquear las cookies esenciales puede impedir el inicio de sesión o el funcionamiento de funciones principales.',
        'Para excluirse de Google Analytics en las regiones compatibles, también puede utilizar el complemento del navegador de Google o los controles de privacidad de su navegador.',
      ],
    },
    {
      title: '6. Actualizaciones',
      paragraphs: [
        'Podemos actualizar esta Política de cookies periódicamente. La fecha de «Última actualización» en la parte superior refleja la versión más reciente.',
      ],
    },
  ],
  closing:
    '¿Preguntas sobre cookies? Contacte con legal@tscopier.ai o consulte nuestra Política de privacidad.',
  contact: legalContactEs,
}
