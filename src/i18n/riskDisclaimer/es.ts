import type { RiskDisclaimerPageTranslations } from './types'

export const riskDisclaimerEs: RiskDisclaimerPageTranslations = {
  title: 'Aviso de riesgo',
  intro:
    'Operar divisas, CFDs y otros productos apalancados conlleva un riesgo sustancial de pérdida. TScopier es una herramienta de copia de operaciones — no un bróker, asesor de inversiones ni planificador financiero. Nada en esta página constituye asesoramiento financiero. Usted es el único responsable de sus decisiones de trading y de cualquier pérdida.',
  sections: [
    {
      title: 'Riesgo general de trading',
      paragraphs: [
        'Puede perder parte o la totalidad de su capital depositado. El apalancamiento amplifica ganancias y pérdidas. El rendimiento pasado de un proveedor de señales, un backtest o su propio historial no garantiza resultados futuros.',
        'Los mercados pueden abrir con huecos, detenerse o moverse con violencia durante noticias. TScopier no garantiza que las señales se reciban, interpreten o ejecuten a un precio u hora determinados.',
      ],
    },
    {
      title: 'Riesgo del proveedor de señales',
      paragraphs: [
        'Copie solo proveedores en los que confíe y que entienda. Los proveedores pueden tener incentivos en conflicto con sus intereses. Capturas de marketing, tasas de acierto y resultados seleccionados pueden no reflejar su experiencia real según cuenta, lote, bróker o latencia.',
        'Verifique el rendimiento de forma independiente cuando sea posible. Un proveedor que funciona para otros puede no ser adecuado para su tolerancia al riesgo, tamaño de cuenta u horario.',
      ],
    },
    {
      title: 'Repintado y engaño en canales',
      paragraphs: [
        'Algunos canales de Telegram editan o eliminan mensajes tras una operación fallida para que el historial público parezca impecable. Una llamada “exitosa” puede haberse revisado; una perdedora puede desaparecer por completo.',
        'No confíe solo en el historial visible del canal ni en capturas de terceros. Compare con sus Copier Logs, extractos del bróker y registros con marca de tiempo. El repintado facilita que los proveedores parezcan más precisos de lo que son.',
      ],
    },
    {
      title: 'Limitaciones de interpretación y ejecución',
      paragraphs: [
        'Las señales se interpretan automáticamente desde texto. Errores tipográficos en stop loss (SL) o take profit (TP) — dígitos incorrectos, decimales omitidos, símbolos ambiguos o unidades mezcladas — pueden generar precios inválidos. TScopier puede omitir la señal, ignorar niveles inválidos o aplicar valores por defecto de su configuración en lugar de la intención del proveedor.',
        'La ejecución puede diferir de la entrada del proveedor: deslizamiento, recotizaciones, ejecuciones parciales, distancias mínimas y desconexiones de sesión del bróker afectan los resultados. Entrada estricta, pendientes de rango y estilos multi-leg añaden complejidad. Revise siempre las posiciones abiertas en su bróker.',
      ],
    },
    {
      title: 'Riesgos operativos y de configuración',
      paragraphs: [
        'Blackouts de noticias, filtros de canal, objetivos de beneficio, pérdida máxima, estado de suscripción y ajustes por canal pueden bloquear o alterar la copia. Tamaño de lote, mapeo de símbolos o canales no vinculados mal configurados son motivos frecuentes por los que las operaciones no se copian como espera.',
        'El cierre automático al alcanzar límites cierra operaciones atribuidas al canal en TScopier, pero no deshace pérdidas de mercado ya incurridas. Los cambios de configuración surten efecto tras guardar — los borradores no guardados no protegen su cuenta.',
      ],
    },
    {
      title: 'Manténgase involucrado mientras copia',
      paragraphs: [
        'La copia automática no es “configurar y olvidar”. Supervise operaciones abiertas, capital, margen y Copier Logs con regularidad. Intervenga en su bróker cuando cambien las condiciones o cuando ya no esté de acuerdo con la exposición del proveedor.',
        'Si no puede supervisar activamente su cuenta, copiar señales en vivo puede no ser adecuado para usted.',
      ],
    },
    {
      title: 'Mejorar sus probabilidades (no es asesoramiento)',
      paragraphs: [
        'Empiece con cuenta demo o el tamaño en vivo más pequeño que pueda permitirse perder. Evalúe canales con el tiempo; use backtests cuando existan; active pérdida máxima y objetivos de beneficio; ajuste filtros; diversifique proveedores en lugar de concentrar riesgo.',
        'Lea los motivos de omisión en Copier Logs cuando las señales no operen. Mantenga expectativas realistas — ventajas pequeñas y constantes con control estricto del riesgo son muy distintas del marketing de “hacerse rico rápido”.',
      ],
    },
  ],
  closing:
    'Al usar TScopier reconoce que el trading es arriesgado, que los proveedores de señales pueden ser poco fiables o engañosos, y que acepta plena responsabilidad por todas las operaciones en sus cuentas vinculadas.',
}
