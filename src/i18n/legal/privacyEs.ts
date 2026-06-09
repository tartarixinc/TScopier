import type { LegalDocumentPageTranslations } from './types'
import { legalContactEs } from './contactEs'

export const privacyPolicyEs: LegalDocumentPageTranslations = {
  title: 'Política de privacidad',
  lastUpdated: 'Última actualización: 8 de junio de 2026',
  intro:
    'Tartarix, Inc. («Tartarix», «nosotros» o «nuestro») respeta su privacidad. Esta Política de privacidad explica cómo recopilamos, utilizamos, divulgamos y protegemos la información cuando usted utiliza los sitios web y aplicaciones de TSCopier (el «Servicio»).',
  sections: [
    {
      title: '1. Información que recopilamos',
      paragraphs: [
        'Información de la cuenta: nombre, dirección de correo electrónico, hash de contraseña, preferencias de idioma y perfil, estado de suscripción y códigos de referido.',
        'Configuración de bróker y trading: etiquetas de bróker, inicios de sesión de cuenta (las contraseñas no se almacenan en texto plano), tipo de plataforma, selección de canales, ajustes del copiador y registros de ejecución necesarios para operar el Servicio.',
        'Datos de trading y señales: identificadores de canales de Telegram, contenido de señales analizado, registros de operaciones, motivos de omisión y métricas de rendimiento asociadas a su cuenta.',
        'Información de pago: estado de facturación e identificadores de cliente de nuestro procesador de pagos. Los datos de la tarjeta son gestionados por el procesador, no por nosotros.',
        'Datos técnicos: dirección IP, tipo de navegador, información del dispositivo, cookies, identificadores de analítica y eventos de uso (consulte nuestra Política de cookies).',
        'Comunicaciones: mensajes que envíe a las direcciones de correo de soporte, legal o disputas.',
      ],
    },
    {
      title: '2. Cómo utilizamos la información',
      paragraphs: [
        'Proporcionar, mantener y mejorar el Servicio; autenticar usuarios; procesar suscripciones; ejecutar flujos de copia de operaciones configurados; mostrar paneles y registros.',
        'Enviar correos transaccionales (verificación, facturación, avisos de seguridad) y responder a solicitudes de soporte.',
        'Supervisar la fiabilidad, prevenir fraude y abuso, hacer cumplir nuestros Términos y cumplir obligaciones legales.',
        'Analizar el uso agregado para mejorar las funciones del producto (sujeto a sus preferencias de cookies cuando corresponda).',
      ],
    },
    {
      title: '3. Bases legales (usuarios del EEE/Reino Unido)',
      paragraphs: [
        'Cuando se aplica el RGPD o leyes similares, tratamos los datos personales sobre la base de: ejecución de un contrato (prestación del Servicio), intereses legítimos (seguridad, analítica, mejora del producto), consentimiento (cookies no esenciales/marketing cuando sea necesario) y obligación legal.',
      ],
    },
    {
      title: '4. Cómo compartimos la información',
      paragraphs: [
        'Proveedores de servicios: alojamiento y base de datos (p. ej., Supabase), procesamiento de pagos (p. ej., Stripe), envío de correo, analítica (p. ej., Google Analytics cuando haya consentimiento), APIs de conectividad con brókers y herramientas de atención al cliente — únicamente según sea necesario para operar el Servicio.',
        'No vendemos su información personal. Podemos divulgar información si la ley lo exige, para proteger derechos y seguridad, o en relación con una fusión, adquisición o venta de activos con las salvaguardas adecuadas.',
      ],
    },
    {
      title: '5. Transferencias internacionales',
      paragraphs: [
        'Podemos procesar y almacenar información en los Estados Unidos y en otros países donde operamos nosotros o nuestros proveedores. Utilizamos salvaguardas apropiadas para las transferencias transfronterizas cuando la ley lo exija.',
      ],
    },
    {
      title: '6. Conservación',
      paragraphs: [
        'Conservamos la información mientras su cuenta esté activa y según sea necesario para prestar el Servicio, resolver disputas, hacer cumplir acuerdos y cumplir requisitos legales. Puede solicitar la eliminación, sujeto a excepciones (p. ej., registros de facturación que debamos conservar).',
      ],
    },
    {
      title: '7. Seguridad',
      paragraphs: [
        'Utilizamos medidas administrativas, técnicas y organizativas diseñadas para proteger la información. Ningún método de transmisión o almacenamiento es 100 % seguro; no podemos garantizar una seguridad absoluta.',
      ],
    },
    {
      title: '8. Sus derechos y opciones',
      paragraphs: [
        'Según su ubicación, puede tener derecho a acceder, rectificar, eliminar, restringir o portar sus datos personales, y a oponerse a determinados tratamientos. Puede actualizar la configuración del perfil en la aplicación y gestionar las preferencias de cookies mediante nuestro banner de cookies.',
        'Para ejercer sus derechos de privacidad, contacte con legal@tscopier.ai. Podemos verificar su identidad antes de responder. También puede presentar una reclamación ante su autoridad local de protección de datos.',
      ],
    },
    {
      title: '9. Menores',
      paragraphs: [
        'El Servicio no está dirigido a menores de 18 años. No recopilamos conscientemente información personal de menores. Contáctenos si cree que un menor ha proporcionado datos y los eliminaremos.',
      ],
    },
    {
      title: '10. Cambios',
      paragraphs: [
        'Podemos actualizar esta Política de privacidad periódicamente. Publicaremos la política revisada con una nueva fecha de «Última actualización» y, cuando sea necesario, proporcionaremos un aviso adicional.',
      ],
    },
  ],
  closing:
    'Para consultas o solicitudes de privacidad, contacte con legal@tscopier.ai.',
  contact: legalContactEs,
}
