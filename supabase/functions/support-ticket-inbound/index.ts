/**
 * support-ticket-inbound — Resend inbound webhook.
 *
 * - Replies to support+ticket-{uuid}@… append to that ticket
 * - New mail to support@unicopier.com creates a ticket + acknowledgement email
 *
 * verify_jwt: false. Optional RESEND_WEBHOOK_SECRET.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  parseTicketIdFromRecipient,
  sendTicketAckEmail,
} from "../_shared/supportTicketEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, svix-id, svix-timestamp, svix-signature, webhook-id, webhook-timestamp, webhook-signature",
};

const SUPPORT_INBOX =
  (Deno.env.get("SUPPORT_TICKET_INBOX") ?? "support@unicopier.com").trim().toLowerCase();

function bad(status: number, message: string) {
  return Response.json({ error: message }, { status, headers: corsHeaders });
}

function asData(payload: Record<string, unknown>): Record<string, unknown> {
  return (payload.data ?? payload) as Record<string, unknown>;
}

function extractTextBody(payload: Record<string, unknown>): string {
  const data = asData(payload);
  const candidates = [
    data.text,
    data.text_body,
    data.plain_text,
    (data.email as Record<string, unknown> | undefined)?.text,
    data.html,
    data.html_body,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      return c.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 20000);
    }
  }
  return "";
}

function collectAddresses(v: unknown, out: string[]) {
  if (typeof v === "string") {
    out.push(v);
    return;
  }
  if (!Array.isArray(v)) return;
  for (const item of v) {
    if (typeof item === "string") out.push(item);
    else if (item && typeof item === "object" && "email" in (item as object)) {
      out.push(String((item as { email: string }).email));
    }
  }
}

function collectRecipients(payload: Record<string, unknown>): string[] {
  const data = asData(payload);
  const out: string[] = [];
  collectAddresses(data.to, out);
  collectAddresses(data.recipients, out);
  collectAddresses(data.envelope_to, out);
  collectAddresses((data.headers as Record<string, unknown> | undefined)?.to, out);
  const email = data.email as Record<string, unknown> | undefined;
  if (email) {
    collectAddresses(email.to, out);
    collectAddresses(email.cc, out);
  }
  return out;
}

function parseFromAddress(raw: unknown): { email: string; name: string } | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  const angled = /^(.*?)\s*<([^>]+)>\s*$/.exec(s);
  if (angled) {
    const email = angled[2].trim().toLowerCase();
    const name = angled[1].replace(/^["']|["']$/g, "").trim() || email.split("@")[0] || "Guest";
    if (!email.includes("@")) return null;
    return { email, name: name.slice(0, 120) };
  }
  if (s.includes("@")) {
    const email = s.toLowerCase();
    return { email, name: email.split("@")[0]?.slice(0, 120) || "Guest" };
  }
  return null;
}

function extractFrom(payload: Record<string, unknown>): { email: string; name: string } | null {
  const data = asData(payload);
  const candidates = [
    data.from,
    data.sender,
    data.envelope_from,
    (data.email as Record<string, unknown> | undefined)?.from,
    (data.headers as Record<string, unknown> | undefined)?.from,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) {
      const first = c[0];
      if (typeof first === "object" && first && "email" in first) {
        const email = String((first as { email: string }).email).toLowerCase();
        const name =
          String((first as { name?: string }).name ?? "").trim() ||
          email.split("@")[0] ||
          "Guest";
        if (email.includes("@")) return { email, name: name.slice(0, 120) };
      }
      const parsed = parseFromAddress(first);
      if (parsed) return parsed;
    } else {
      const parsed = parseFromAddress(c);
      if (parsed) return parsed;
    }
  }
  return null;
}

function extractMessageId(payload: Record<string, unknown>): string | null {
  const data = asData(payload);
  const headers = (data.headers ?? data) as Record<string, unknown>;
  const mid =
    data.message_id ??
    headers["message-id"] ??
    headers["Message-ID"] ??
    (data.email as Record<string, unknown> | undefined)?.message_id;
  return typeof mid === "string" && mid.trim() ? mid.trim() : null;
}

function extractTicketHeader(payload: Record<string, unknown>): string | null {
  const data = asData(payload);
  const headers = (data.headers ?? {}) as Record<string, unknown>;
  const v =
    headers["x-unicopier-ticket-id"] ??
    headers["X-UniCopier-Ticket-Id"] ??
    headers["X-Unicopier-Ticket-Id"];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function extractEmailId(payload: Record<string, unknown>): string | null {
  const data = asData(payload);
  const id = data.email_id ?? data.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function isSupportInboxRecipient(recipients: string[]): boolean {
  return recipients.some((r) => {
    const lower = r.toLowerCase();
    // Exact support@ or display-name form containing it (not plus-addressed ticket routes)
    if (lower.includes(SUPPORT_INBOX)) return true;
    if (/support@unicopier\.com/i.test(lower) && !/support\+ticket-/i.test(lower)) return true;
    return false;
  });
}

/** Resend webhooks are metadata-only — body/headers come from Receiving API. */
async function fetchReceivingEmail(
  emailId: string,
  apiKey: string,
): Promise<{
  text: string;
  subject: string | null;
  from: string | null;
  to: string[];
  messageId: string | null;
}> {
  const empty = { text: "", subject: null, from: null, to: [] as string[], messageId: null };
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.warn("[support-ticket-inbound] receiving API", res.status, await res.text());
      return empty;
    }
    const json = (await res.json()) as Record<string, unknown>;
    const raw =
      (typeof json.text === "string" && json.text) ||
      (typeof json.html === "string" && json.html) ||
      "";
    const text = String(raw).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 20000);
    const to: string[] = [];
    collectAddresses(json.to, to);
    const headers = (json.headers ?? {}) as Record<string, unknown>;
    const mid =
      (typeof json.message_id === "string" && json.message_id) ||
      (typeof headers["message-id"] === "string" && headers["message-id"]) ||
      (typeof headers["Message-ID"] === "string" && headers["Message-ID"]) ||
      null;
    return {
      text,
      subject: typeof json.subject === "string" ? json.subject : null,
      from: typeof json.from === "string" ? json.from : null,
      to,
      messageId: mid,
    };
  } catch (err) {
    console.warn("[support-ticket-inbound] fetch receiving email failed", err);
    return empty;
  }
}

async function appendToTicket(
  admin: SupabaseClient,
  ticketId: string,
  bodyText: string,
  emailMessageId: string | null,
): Promise<Response> {
  const { data: ticket } = await admin
    .from("support_tickets")
    .select("id, status")
    .eq("id", ticketId)
    .maybeSingle();
  if (!ticket) {
    return Response.json({ ok: true, matched: false, reason: "unknown_ticket" }, {
      headers: corsHeaders,
    });
  }

  if (emailMessageId) {
    const { data: existing } = await admin
      .from("support_ticket_messages")
      .select("id")
      .eq("email_message_id", emailMessageId)
      .maybeSingle();
    if (existing) {
      return Response.json({ ok: true, duplicate: true }, { headers: corsHeaders });
    }
  }

  const { error: insertErr } = await admin.from("support_ticket_messages").insert({
    ticket_id: ticketId,
    sender_type: "email_inbound",
    sender_user_id: null,
    body: bodyText || "(empty inbound email)",
    images: [],
    email_message_id: emailMessageId,
  });
  if (insertErr) {
    console.error("[support-ticket-inbound] insert failed", insertErr);
    return bad(500, insertErr.message);
  }

  if (ticket.status === "pending" || ticket.status === "resolved" || ticket.status === "closed") {
    await admin.from("support_tickets").update({ status: "open" }).eq("id", ticketId);
  }

  return Response.json({ ok: true, matched: true, ticket_id: ticketId }, {
    headers: corsHeaders,
  });
}

async function createTicketFromEmail(
  admin: SupabaseClient,
  opts: {
    from: { email: string; name: string };
    subject: string;
    bodyText: string;
    emailMessageId: string | null;
    resendKey: string | undefined;
  },
): Promise<Response> {
  if (opts.emailMessageId) {
    const { data: existing } = await admin
      .from("support_ticket_messages")
      .select("id, ticket_id")
      .eq("email_message_id", opts.emailMessageId)
      .maybeSingle();
    if (existing) {
      return Response.json({ ok: true, duplicate: true, ticket_id: existing.ticket_id }, {
        headers: corsHeaders,
      });
    }
  }

  const subject =
    (opts.subject || "Email to support").trim().slice(0, 200) || "Email to support";
  const body =
    opts.bodyText.trim().slice(0, 20000) || "(empty inbound email)";

  const { data: ticket, error } = await admin
    .from("support_tickets")
    .insert({
      user_id: null,
      guest_name: opts.from.name,
      guest_email: opts.from.email,
      guest_token: crypto.randomUUID(),
      subject,
      status: "open",
      priority: "normal",
    })
    .select("id, number, subject, guest_name, guest_email")
    .single();

  if (error || !ticket) {
    console.error("[support-ticket-inbound] create ticket failed", error);
    return bad(500, error?.message ?? "Failed to create ticket");
  }

  await admin.from("support_ticket_messages").insert({
    ticket_id: ticket.id,
    sender_type: "email_inbound",
    sender_user_id: null,
    body,
    images: [],
    email_message_id: opts.emailMessageId,
  });

  await admin.from("support_ticket_messages").insert({
    ticket_id: ticket.id,
    sender_type: "system",
    body: "Ticket created from inbound email to support@unicopier.com.",
    images: [],
  });

  const ack = await sendTicketAckEmail({
    to: opts.from.email,
    ticketNumber: ticket.number as number,
    subject: String(ticket.subject),
    requesterName: opts.from.name,
    resendApiKey: opts.resendKey,
    ticketId: String(ticket.id),
  });

  if (ack.resendId) {
    await admin.from("support_ticket_messages").insert({
      ticket_id: ticket.id,
      sender_type: "system",
      body: `Acknowledgement email sent (Resend ${ack.resendId}).`,
      images: [],
      resend_id: ack.resendId,
    });
  }

  return Response.json(
    {
      ok: true,
      created: true,
      ticket_id: ticket.id,
      ticket_number: ticket.number,
      ack_sent: ack.ok,
    },
    { headers: corsHeaders },
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") return bad(405, "Method not allowed");

  const rawBody = await req.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return bad(400, "Invalid JSON");
  }

  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET")?.trim();
  if (secret) {
    const auth = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const hdr =
      req.headers.get("x-resend-webhook-secret") ??
      req.headers.get("webhook-secret") ??
      "";
    if (auth !== secret && hdr !== secret) {
      const allowUnsigned = Deno.env.get("RESEND_WEBHOOK_ALLOW_UNSIGNED") === "1";
      const hasSvix = Boolean(
        req.headers.get("svix-signature") || req.headers.get("webhook-signature"),
      );
      if (!allowUnsigned && !hasSvix) {
        return bad(401, "Invalid webhook secret");
      }
    }
  }

  const type = String(payload.type ?? payload.event ?? "");
  if (type && !/email\.received|inbound/i.test(type) && payload.data == null) {
    return Response.json({ ok: true, ignored: true, type }, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) return bad(500, "Server misconfigured");
  const admin = createClient(supabaseUrl, serviceKey);
  const resendKey = Deno.env.get("RESEND_API_KEY");

  const data = asData(payload);
  let recipients = collectRecipients(payload);
  let subject = String(data.subject ?? "").trim();
  let emailMessageId = extractMessageId(payload);
  let from = extractFrom(payload);
  let bodyText = extractTextBody(payload);

  // Resend email.received webhooks omit body/headers — always hydrate from Receiving API
  const emailId = extractEmailId(payload);
  if (emailId && resendKey) {
    const full = await fetchReceivingEmail(emailId, resendKey);
    if (full.text) bodyText = full.text;
    if (full.subject && !subject) subject = full.subject.trim();
    if (full.from && !from) from = parseFromAddress(full.from);
    if (full.to.length && recipients.length === 0) recipients = full.to;
    if (full.messageId && !emailMessageId) emailMessageId = full.messageId;
  }

  // 1) Threaded reply to an existing ticket
  let ticketId =
    extractTicketHeader(payload) ??
    recipients.map(parseTicketIdFromRecipient).find(Boolean) ??
    null;

  if (!ticketId) {
    const numMatch = /(?:ticket\s*)?#(\d+)/i.exec(subject);
    if (numMatch) {
      const { data: byNum } = await admin
        .from("support_tickets")
        .select("id")
        .eq("number", Number(numMatch[1]))
        .maybeSingle();
      ticketId = byNum?.id ?? null;
    }
  }

  if (ticketId) {
    return await appendToTicket(admin, ticketId, bodyText, emailMessageId);
  }

  // 2) New email to support@ → create ticket + ack
  if (isSupportInboxRecipient(recipients) || recipients.length === 0) {
    if (!from?.email) {
      console.warn("[support-ticket-inbound] missing from address for new ticket", {
        recipients,
        subject,
        type,
      });
      return Response.json({ ok: true, matched: false, reason: "missing_from" }, {
        headers: corsHeaders,
      });
    }

    // Ignore our own outbound/ack loops
    if (from.email === SUPPORT_INBOX || from.email.endsWith("@unicopier.com")) {
      return Response.json({ ok: true, ignored: true, reason: "own_domain" }, {
        headers: corsHeaders,
      });
    }

    return await createTicketFromEmail(admin, {
      from,
      subject,
      bodyText,
      emailMessageId,
      resendKey,
    });
  }

  console.warn("[support-ticket-inbound] no ticket match and not support inbox", {
    recipients,
    subject,
    type,
  });
  return Response.json({ ok: true, matched: false }, { headers: corsHeaders });
});
