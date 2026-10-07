const COMPANY_FOOTER = `Tartarix Inc.<br>
131 Continental Dr<br>
Suite 305<br>
Newark, DE 19713 US`

export function buildAuthEmailHtml(args: {
  title: string
  greeting: string
  bodyHtml: string
  buttonLabel: string
  buttonUrl: string
  footerNote?: string
  logoUrl?: string | null
}): string {
  const footerNote = args.footerNote
    ? `<p style="margin:0 0 24px 0;font-size:13px;line-height:1.6;color:#737373;">${args.footerNote}</p>`
    : ""

  const logoBlock = args.logoUrl
    ? `<img src="${args.logoUrl}" alt="UniCopier" width="148" height="36" style="display:block;margin:0 0 20px 0;height:36px;width:auto;max-width:180px;border:0;" />`
    : `<p style="margin:0 0 8px 0;font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#0d9488;">UniCopier</p>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${args.title}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="padding:40px 40px 0 40px;">
              ${logoBlock}
              <h1 style="margin:0 0 24px 0;font-size:22px;font-weight:600;color:#171717;line-height:1.3;">
                ${args.title}
              </h1>
              <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#404040;">
                ${args.greeting}
              </p>
              <div style="margin:0 0 32px 0;font-size:15px;line-height:1.6;color:#404040;">
                ${args.bodyHtml}
              </div>
              ${footerNote}
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 40px 40px;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>
                  <td style="border-radius:8px;background-color:#0d9488;">
                    <a href="${args.buttonUrl}" target="_blank" style="display:inline-block;padding:12px 32px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                      ${args.buttonLabel}
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px;">
              <hr style="border:none;border-top:1px solid #e5e5e5;margin:0;">
            </td>
          </tr>
          <tr>
            <td style="padding:32px 40px 40px 40px;text-align:center;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#a3a3a3;">
                ${COMPANY_FOOTER}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}
