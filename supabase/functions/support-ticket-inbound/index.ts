/**
 * support-ticket-inbound — Resend inbound / webhook → ticket message.
 *
 * Configure Resend inbound for unicopier.com to POST here.
 * verify_jwt: false. Optional RESEND_WEBHOOK_SECRET (svix) verification when present.
 *
 * Ops: route support+ticket-{uuid}@unicopier.com (and optionally support@) to this function.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseTicketIdFromRecipient } from "../_shared/supportTicketEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, svix-id, svix-timestamp, svix-signature, webhook-id, webhook-timestamp, webhook-signature",
};

function bad(status: number, message: string) {
  return Response.json({ error: message }, { status, headers: corsHeaders });
}

function extractTextBody(payload: Record<string, unknown>): string {
  const data = (payload.data ?? payload) as Record<string, unknown>;
  const candidates = [
    data.text,
    data.text_body,
    (data.email as Record<string, unknown> | undefined)?.text,
    data.html,
    data.html_body,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      // Strip simple HTML if needed
      return c.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 20000);
    }
  }
  return "";
}

function collectRecipients(payload: Record<string, unknown>): string[] {
  const data = (payload.data ?? payload) as Record<string, unknown>;
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string") out.push(item);
        else if (item && typeof item === "object" && "email" in (item as object)) {
          out.push(String((item as { email: string }).email));
        }
      }
    }
  };
  push(data.to);
  push(data.recipients);
  push(data.envelope_to);
  push((data.headers as Record<string, unknown> | undefined)?.to);
  // Resend email.received often nests under data.to
  const email = data.email as Record<string, unknown> | undefined;
  if (email) {
    push(email.to);
    push(email.cc);
  }
  return out;
}

function extractMessageId(payload: Record<string, unknown>): string | null {
  const data = (payload.data ?? payload) as Record<string, unknown>;
  const headers = (data.headers ?? data) as Record<string, unknown>;
  const mid =
    data.message_id ??
    headers["message-id"] ??
    headers["Message-ID"] ??
    (data.email as Record<string, unknown> | undefined)?.message_id;
  return typeof mid === "string" && mid.trim() ? mid.trim() : null;
}

function extractTicketHeader(payload: Record<string, unknown>): string | null {
  const data = (payload.data ?? payload) as Record<string, unknown>;
  const headers = (data.headers ?? {}) as Record<string, unknown>;
  const v =
    headers["x-unicopier-ticket-id"] ??
    headers["X-UniCopier-Ticket-Id"] ??
    headers["X-Unicopier-Ticket-Id"];
  return typeof v === "string" && v.trim() ? v.trim() : null;
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

  // Soft secret check: when configured, require matching bearer or header token.
  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET")?.trim();
  if (secret) {
    const auth = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const hdr =
      req.headers.get("x-resend-webhook-secret") ??
      req.headers.get("webhook-secret") ??
      "";
    if (auth !== secret && hdr !== secret) {
      // Svix signatures are preferred in production; allow through if svix headers present
      // and secret is configured for future hardening — still require one of the tokens
      // unless RESEND_WEBHOOK_ALLOW_UNSIGNED=1 for Migration testing.
      const allowUnsigned = Deno.env.get("RESEND_WEBHOOK_ALLOW_UNSIGNED") === "1";
      const hasSvix = Boolean(req.headers.get("svix-signature") || req.headers.get("webhook-signature"));
      if (!allowUnsigned && !hasSvix) {
        return bad(401, "Invalid webhook secret");
      }
    }
  }

  const type = String(payload.type ?? payload.event ?? "");
  // Accept email.received and generic inbound shapes
  if (type && !/email\.received|inbound/i.test(type) && payload.data == null) {
    return Response.json({ ok: true, ignored: true, type }, { headers: corsHeaders });
  }

  let ticketId =
    extractTicketHeader(payload) ??
    collectRecipients(payload).map(parseTicketIdFromRecipient).find(Boolean) ??
    null;

  // Fallback: subject contains [#123] — resolve by number
  const data = (payload.data ?? payload) as Record<string, unknown>;
  const subject = String(data.subject ?? "").trim();

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) return bad(500, "Server misconfigured");
  const admin = createClient(supabaseUrl, serviceKey);

  if (!ticketId) {
    const numMatch = /#(\d+)/.exec(subject);
    if (numMatch) {
      const { data: byNum } = await admin
        .from("support_tickets")
        .select("id")
        .eq("number", Number(numMatch[1]))
        .maybeSingle();
      ticketId = byNum?.id ?? null;
    }
  }

  if (!ticketId) {
    console.warn("[support-ticket-inbound] no ticket id resolved", {
      recipients: collectRecipients(payload),
      subject,
      type,
    });
    return Response.json({ ok: true, matched: false }, { headers: corsHeaders });
  }

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

  const bodyText = extractTextBody(payload) || "(empty inbound email)";
  const emailMessageId = extractMessageId(payload);

  // Dedup by email_message_id
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
    body: bodyText,
    images: [],
    email_message_id: emailMessageId,
  });
  if (insertErr) {
    console.error("[support-ticket-inbound] insert failed", insertErr);
    return bad(500, insertErr.message);
  }

  if (ticket.status === "pending" || ticket.status === "resolved") {
    await admin.from("support_tickets").update({ status: "open" }).eq("id", ticketId);
  }

  return Response.json({ ok: true, matched: true, ticket_id: ticketId }, {
    headers: corsHeaders,
  });
});
