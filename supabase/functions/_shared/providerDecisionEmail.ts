import { BRAND } from "./campaignEmailLayout.ts"

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export type ProviderApprovalEmailArgs = {
  /** First name, display name or username; falls back to "there". */
  name: string | null | undefined
  appUrl: string
  logoUrl: string
  /** Public profile slug; the public link is omitted when missing. */
  slug: string | null | undefined
  /** True when a suspended provider was reinstated rather than newly approved. */
  reinstated?: boolean
}

export function providerApprovalEmailSubject(reinstated = false): string {
  return reinstated
    ? "Your UniCopier provider profile is live again"
    : "You're approved as a UniCopier provider"
}

/** Transactional email sent when an admin approves (or reinstates) a provider. */
export function buildProviderApprovalEmail(args: ProviderApprovalEmailArgs): { subject: string; html: string } {
  const appUrl = args.appUrl.replace(/\/$/, "")
  const name = args.name?.trim() || "there"
  const reinstated = args.reinstated === true
  const slug = args.slug?.trim()
  const publicUrl = slug ? `${appUrl}/p/${encodeURIComponent(slug)}` : null
  const dashboardUrl = `${appUrl}/social-trading/provider`

  const headline = reinstated ? "Your provider profile is live again" : "Your provider application was approved"
  const lead = reinstated
    ? "Your provider profile was reinstated. It is back in the Social Trading directory and your account can be copied again."
    : "Congratulations! Your profile is now live in the Social Trading directory and traders can start copying your account."

  const publicBlock = publicUrl
    ? `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:${BRAND.textMuted};">Your public profile: <a href="${esc(publicUrl)}" style="color:${BRAND.tealDark};font-weight:600;text-decoration:none;">${esc(publicUrl.replace(/^https?:\/\//, ""))}</a></p>`
    : ""

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(headline)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.pageBg};font-family:'SF Pro','SF Pro Text','SF Pro Display',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(lead)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.pageBg};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:${BRAND.cardBg};border-radius:16px;overflow:hidden;border:1px solid ${BRAND.border};">
          <tr>
            <td style="background-color:${BRAND.headerBg};padding:24px 32px;text-align:center;">
              <img src="${esc(args.logoUrl)}" alt="UniCopier" width="160" height="40" style="display:block;margin:0 auto;height:40px;width:auto;max-width:200px;border:0;" />
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:600;line-height:1.3;color:${BRAND.text};">${esc(headline)}</h1>
              <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:${BRAND.textMuted};">Hi ${esc(name)},</p>
              <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:${BRAND.textMuted};">${esc(lead)}</p>
              ${publicBlock}
              <p style="margin:24px 0 0 0;text-align:center;">
                <a href="${esc(dashboardUrl)}" style="display:inline-block;padding:12px 28px;border-radius:10px;background-color:${BRAND.teal};font-size:15px;font-weight:600;color:#052e16;text-decoration:none;">Manage your provider profile</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:${BRAND.pageBg};padding:18px 32px;border-top:1px solid ${BRAND.border};text-align:center;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.textSubtle};">This is a service message about your UniCopier provider account.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  return { subject: providerApprovalEmailSubject(reinstated), html }
}
