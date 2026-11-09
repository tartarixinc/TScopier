/**
 * Shared Resend transactional/campaign sender.
 *
 * Canonical implementation — the near-identical private copies in
 * `send-subscription-campaigns/index.ts` and `_shared/billingPaymentNotification.ts`
 * predate this module and are pending migration here (send-subscription-campaigns
 * cannot be redeployed until its prod-only invoice_due source is reconciled).
 * New code must import this instead of POSTing to Resend directly.
 */

export type ResendSendResult = {
  ok: boolean
  resendId?: string
  /** SMTP Message-ID if Resend returns one in the response body (rare); callers may also synthesize. */
  emailMessageId?: string
}

export async function sendResendEmail(opts: {
  to: string
  subject: string
  html: string
  from: string
  resendApiKey: string | undefined
  /** Prefix for error logs, e.g. "[email-unsubscribe]" */
  logPrefix: string
  replyTo?: string
  text?: string
  headers?: Record<string, string>
}): Promise<ResendSendResult> {
  if (!opts.resendApiKey) {
    console.error(`${opts.logPrefix} RESEND_API_KEY missing — email not sent`)
    return { ok: false }
  }
  try {
    const payload: Record<string, unknown> = {
      from: opts.from,
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
    }
    if (opts.text) payload.text = opts.text
    if (opts.replyTo) payload.reply_to = opts.replyTo
    if (opts.headers && Object.keys(opts.headers).length > 0) {
      payload.headers = opts.headers
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
    const data = await res.json() as { id?: string; message?: string }
    if (!res.ok) {
      console.error(`${opts.logPrefix} Resend error:`, data)
      return { ok: false }
    }
    return { ok: true, resendId: data.id }
  } catch (err) {
    console.error(`${opts.logPrefix} send failed:`, err)
    return { ok: false }
  }
}
