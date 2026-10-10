/** UniCopier campaign email shell — matches app brand (teal accent, slate neutrals). */

export const BRAND = {
  teal: "#0d9488",
  tealDark: "#0f766e",
  tealLight: "#ccfbf1",
  pageBg: "#f8fafc",
  cardBg: "#ffffff",
  text: "#0f172a",
  textMuted: "#475569",
  textSubtle: "#64748b",
  border: "#e2e8f0",
  headerBg: "#0f172a",
} as const

const COMPANY_FOOTER = `Tartarix Inc. · 131 Continental Dr, Suite 305<br>
Newark, DE 19713 US`

function escapeHtml(raw: string): string {
  return String(raw ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function buildFeatureList(items: string[]): string {
  const rows = items.map((item) => `
    <tr>
      <td style="padding:0 0 10px 0;vertical-align:top;width:22px;">
        <span style="display:inline-block;width:18px;height:18px;line-height:18px;text-align:center;border-radius:999px;background-color:${BRAND.tealLight};color:${BRAND.teal};font-size:12px;font-weight:700;">✓</span>
      </td>
      <td style="padding:0 0 10px 8px;font-size:14px;line-height:1.55;color:${BRAND.textMuted};">
        ${escapeHtml(item)}
      </td>
    </tr>`).join("")
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 8px 0;">${rows}</table>`
}

export function buildInfoBox(title: string, bodyHtml: string): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;background-color:${BRAND.pageBg};border:1px solid ${BRAND.border};border-radius:10px;">
      <tr>
        <td style="padding:18px 20px;">
          <p style="margin:0 0 8px 0;font-size:13px;font-weight:600;color:${BRAND.text};">${escapeHtml(title)}</p>
          <div style="font-size:14px;line-height:1.6;color:${BRAND.textMuted};">${bodyHtml}</div>
        </td>
      </tr>
    </table>`
}

export function buildCampaignEmailHtml(args: {
  appUrl: string
  logoUrl: string
  preheader: string
  eyebrow: string
  title: string
  greeting: string
  bodyHtml: string
  featureList?: string[]
  infoBox?: { title: string; bodyHtml: string }
  primaryCta: { label: string; url: string }
  secondaryCta?: { label: string; url: string }
  closingHtml: string
  unsubscribeUrl: string
}): string {
  const nameSafe = escapeHtml(args.greeting)
  const features = args.featureList?.length
    ? `<div style="margin:20px 0 4px 0;">
        <p style="margin:0 0 12px 0;font-size:13px;font-weight:600;letter-spacing:0.03em;text-transform:uppercase;color:${BRAND.textSubtle};">What you get with an active plan</p>
        ${buildFeatureList(args.featureList)}
      </div>`
    : ""
  const info = args.infoBox ? buildInfoBox(args.infoBox.title, args.infoBox.bodyHtml) : ""
  const secondary = args.secondaryCta
    ? `<p style="margin:20px 0 0 0;text-align:center;font-size:14px;line-height:1.5;">
        <a href="${args.secondaryCta.url}" style="color:${BRAND.teal};font-weight:600;text-decoration:none;">${escapeHtml(args.secondaryCta.label)} →</a>
      </p>`
    : ""

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(args.title)}</title>
  <!--[if mso]><style type="text/css">body,table,td{font-family:Arial,sans-serif!important;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:${BRAND.pageBg};font-family:'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(args.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.pageBg};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:${BRAND.cardBg};border-radius:16px;overflow:hidden;border:1px solid ${BRAND.border};box-shadow:0 4px 24px rgba(15,23,42,0.06);">
          <tr>
            <td style="background:linear-gradient(135deg,${BRAND.headerBg} 0%,#134e4a 100%);padding:28px 32px 24px;text-align:center;">
              <img src="${args.logoUrl}" alt="UniCopier" width="160" height="40" style="display:block;margin:0 auto 16px;height:40px;width:auto;max-width:200px;border:0;" />
              <p style="margin:0;font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#5eead4;">${escapeHtml(args.eyebrow)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 32px 8px 32px;">
              <h1 style="margin:0 0 12px 0;font-size:24px;font-weight:600;line-height:1.25;color:${BRAND.text};">${escapeHtml(args.title)}</h1>
              <p style="margin:0 0 20px 0;font-size:16px;line-height:1.5;color:${BRAND.textMuted};">Hi ${nameSafe},</p>
              <div style="font-size:15px;line-height:1.65;color:${BRAND.textMuted};">${args.bodyHtml}</div>
              ${features}
              ${info}
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 32px 32px;text-align:center;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>
                  <td style="border-radius:10px;background-color:${BRAND.teal};box-shadow:0 2px 8px rgba(13,148,136,0.35);">
                    <a href="${args.primaryCta.url}" target="_blank" style="display:inline-block;padding:14px 36px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">
                      ${escapeHtml(args.primaryCta.label)}
                    </a>
                  </td>
                </tr>
              </table>
              ${secondary}
              <p style="margin:28px 0 0 0;font-size:13px;line-height:1.6;color:${BRAND.textSubtle};text-align:left;">${args.closingHtml}</p>
            </td>
          </tr>
          <tr>
            <td style="background-color:${BRAND.pageBg};padding:22px 32px;border-top:1px solid ${BRAND.border};text-align:center;">
              <p style="margin:0 0 10px 0;font-size:12px;line-height:1.6;color:${BRAND.textSubtle};">${COMPANY_FOOTER}</p>
              <p style="margin:0;font-size:12px;color:${BRAND.textSubtle};">
                <a href="${args.unsubscribeUrl}" style="color:${BRAND.textSubtle};text-decoration:underline;">Unsubscribe</a> from subscription reminder emails
              </p>
            </td>
          </tr>
        </table>
        <p style="margin:16px 0 0 0;font-size:11px;color:${BRAND.textSubtle};text-align:center;">
          <a href="${args.appUrl}" style="color:${BRAND.textSubtle};text-decoration:none;">${escapeHtml(args.appUrl.replace(/^https?:\/\//, ""))}</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`
}

export function recipientFirstName(recipient: {
  first_name: string | null
  display_name: string | null
}): string {
  const first = recipient.first_name?.trim()
  if (first) return first
  const display = recipient.display_name?.trim()
  if (display) return display.split(/\s+/)[0] ?? display
  return "there"
}
