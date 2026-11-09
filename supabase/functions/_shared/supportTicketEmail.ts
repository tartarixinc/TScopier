/**
 * Support ticket email templates (Resend).
 *
 * Ops: verify unicopier.com in Resend; route inbound for support@ / support+ticket-*@
 * to the support-ticket-inbound edge webhook.
 */

import { sendResendEmail, type ResendSendResult } from "./resendSender.ts"

export const SUPPORT_TICKET_FROM_DEFAULT =
  "UniCopier Support <support@unicopier.com>"

export function supportTicketFrom(): string {
  return (
    Deno.env.get("SUPPORT_TICKET_FROM")?.trim() || SUPPORT_TICKET_FROM_DEFAULT
  )
}

export function supportTicketReplyTo(ticketId: string): string {
  const domain =
    Deno.env.get("SUPPORT_TICKET_REPLY_DOMAIN")?.trim() || "unicopier.com"
  return `support+ticket-${ticketId}@${domain}`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function layout(args: { title: string; bodyHtml: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(args.title)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:28px 32px 8px 32px;">
          <p style="margin:0 0 8px 0;font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#4ade80;">UniCopier Support</p>
          <h1 style="margin:0 0 16px 0;font-size:20px;font-weight:600;color:#171717;">${escapeHtml(args.title)}</h1>
        </td></tr>
        <tr><td style="padding:0 32px 32px 32px;font-size:14px;line-height:1.6;color:#404040;">
          ${args.bodyHtml}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

export async function sendTicketAckEmail(opts: {
  to: string
  ticketNumber: number
  subject: string
  requesterName: string
  resendApiKey: string | undefined
  /** When set, Reply-To uses support+ticket-{id}@ so replies stay on this ticket. */
  ticketId?: string
}): Promise<ResendSendResult> {
  const title = `Ticket #${opts.ticketNumber} received`
  const html = layout({
    title,
    bodyHtml: `
      <p>Hi ${escapeHtml(opts.requesterName || "there")},</p>
      <p>We received your support ticket <strong>#${opts.ticketNumber}</strong>.</p>
      <p style="margin:16px 0;padding:12px 14px;background:#f4f4f5;border-radius:8px;"><strong>${escapeHtml(opts.subject)}</strong></p>
      <p>Our team will follow up by email. Reply to this message to add more details to your ticket.</p>
      <p style="margin-top:24px;color:#737373;font-size:13px;">— UniCopier Support</p>
    `,
  })
  return await sendResendEmail({
    to: opts.to,
    subject: `Ticket #${opts.ticketNumber} received — ${opts.subject}`,
    html,
    from: supportTicketFrom(),
    resendApiKey: opts.resendApiKey,
    logPrefix: "[support-tickets-ack]",
    replyTo: opts.ticketId
      ? supportTicketReplyTo(opts.ticketId)
      : "support@unicopier.com",
  })
}

export async function sendTicketAgentReplyEmail(opts: {
  to: string
  ticketId: string
  ticketNumber: number
  subject: string
  body: string
  resendApiKey: string | undefined
  inReplyTo?: string | null
  references?: string | null
}): Promise<ResendSendResult> {
  const title = `Re: Ticket #${opts.ticketNumber} — ${opts.subject}`
  const html = layout({
    title: `Ticket #${opts.ticketNumber}`,
    bodyHtml: `
      <p style="white-space:pre-wrap;">${escapeHtml(opts.body)}</p>
      <p style="margin-top:24px;color:#737373;font-size:13px;">Reply to this email to continue the conversation.</p>
    `,
  })
  const headers: Record<string, string> = {
    "X-UniCopier-Ticket-Id": opts.ticketId,
    "X-UniCopier-Ticket-Number": String(opts.ticketNumber),
  }
  if (opts.inReplyTo) headers["In-Reply-To"] = opts.inReplyTo
  if (opts.references) headers["References"] = opts.references

  return await sendResendEmail({
    to: opts.to,
    subject: title.startsWith("Re:") ? title : `Re: ${title}`,
    html,
    text: opts.body,
    from: supportTicketFrom(),
    replyTo: supportTicketReplyTo(opts.ticketId),
    headers,
    resendApiKey: opts.resendApiKey,
    logPrefix: "[support-tickets-reply]",
  })
}

/** Extract ticket UUID from inbound address like support+ticket-{uuid}@domain */
export function parseTicketIdFromRecipient(raw: string): string | null {
  const s = String(raw || "").trim().toLowerCase()
  const m = /support\+ticket-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i.exec(
    s,
  )
  return m?.[1] ?? null
}
