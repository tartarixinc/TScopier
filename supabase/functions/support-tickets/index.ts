/**
 * support-tickets — create/list/get tickets; agent reply + status (Resend round-trip).
 *
 * POST { action, ... }
 * verify_jwt: false (optional user JWT; guests use guest_token / name+email)
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  sendTicketAckEmail,
  sendTicketAgentReplyEmail,
} from "../_shared/supportTicketEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const TICKET_SELECT =
  "id, number, user_id, guest_name, guest_email, guest_token, subject, status, priority, assignee_id, last_message_at, created_at, updated_at";
const MSG_SELECT =
  "id, ticket_id, sender_type, sender_user_id, body, images, resend_id, email_message_id, created_at";

function bad(status: number, message: string) {
  return Response.json({ error: message }, { status, headers: corsHeaders });
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320;
}

type Actor =
  | { kind: "user"; userId: string; email: string | null }
  | { kind: "guest"; name: string; email: string; token: string | null }
  | { kind: "agent"; userId: string };

async function isSupportAgent(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { data } = await admin
    .from("user_profiles")
    .select("is_support_agent, is_admin, admin_until")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return false;
  if (data.is_support_agent === true) return true;
  if (data.is_admin !== true) return false;
  if (data.admin_until == null || data.admin_until === "") return true;
  return new Date(String(data.admin_until)).getTime() > Date.now();
}

async function resolveUserEmail(
  admin: SupabaseClient,
  userId: string,
): Promise<string | null> {
  try {
    const { data } = await admin.auth.admin.getUserById(userId);
    return data.user?.email?.trim().toLowerCase() ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") return bad(405, "Method not allowed");

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) return bad(500, "Server misconfigured");
  const admin = createClient(supabaseUrl, serviceKey);
  const resendKey = Deno.env.get("RESEND_API_KEY");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad(400, "Invalid JSON");
  }

  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  let userId: string | null = null;
  let userEmail: string | null = null;
  if (bearer && bearer !== Deno.env.get("SUPABASE_ANON_KEY")) {
    const { data: authData } = await admin.auth.getUser(bearer);
    if (authData.user) {
      userId = authData.user.id;
      userEmail = authData.user.email?.trim().toLowerCase() ?? null;
    }
  }

  const action = String(body.action ?? "");
  const guestName = String(body.guest_name ?? "").trim().slice(0, 120);
  const guestEmail = String(body.guest_email ?? "").trim().toLowerCase().slice(0, 320);
  const guestToken = String(body.guest_token ?? "").trim() || null;

  // Agent-only actions
  if (["agent_reply", "claim", "update_status", "agent_list", "agent_get"].includes(action)) {
    if (!userId) return bad(401, "Unauthorized");
    if (!(await isSupportAgent(admin, userId))) return bad(403, "Support agent access required");
    const actor: Actor = { kind: "agent", userId };
    if (action === "agent_list") return await agentList(admin, body);
    if (action === "agent_get") return await getTicket(admin, actor, body, true);
    if (action === "claim") return await claimTicket(admin, userId, body);
    if (action === "update_status") return await updateStatus(admin, userId, body);
    if (action === "agent_reply") return await agentReply(admin, userId, body, resendKey);
  }

  let actor: Actor | null = null;
  if (userId) {
    actor = { kind: "user", userId, email: userEmail };
  } else if (guestToken || (guestName && guestEmail)) {
    if (guestEmail && !isValidEmail(guestEmail) && !guestToken) {
      return bad(400, "Valid email required");
    }
    actor = { kind: "guest", name: guestName, email: guestEmail, token: guestToken };
  } else {
    return bad(401, "Sign in or provide name and email");
  }

  if (action === "create") return await createTicket(admin, actor, body, resendKey);
  if (action === "list") return await listTickets(admin, actor);
  if (action === "get") return await getTicket(admin, actor, body, false);

  return bad(400, "Unknown action");
});

async function createTicket(
  admin: SupabaseClient,
  actor: Actor,
  body: Record<string, unknown>,
  resendKey: string | undefined,
) {
  if (actor.kind === "agent") return bad(400, "Use agent actions");
  const subject = String(body.subject ?? "").trim().slice(0, 200);
  const message = String(body.message ?? body.body ?? "").trim().slice(0, 20000);
  if (!subject || !message) return bad(400, "subject and message required");

  const insert: Record<string, unknown> = {
    subject,
    status: "open",
    priority: "normal",
  };

  if (actor.kind === "user") {
    insert.user_id = actor.userId;
  } else {
    if (!actor.name || !isValidEmail(actor.email)) {
      return bad(400, "Name and valid email required");
    }
    insert.user_id = null;
    insert.guest_name = actor.name;
    insert.guest_email = actor.email;
    insert.guest_token = crypto.randomUUID();
  }

  const { data: ticket, error } = await admin
    .from("support_tickets")
    .insert(insert)
    .select(TICKET_SELECT)
    .single();
  if (error || !ticket) return bad(500, error?.message ?? "Failed to create ticket");

  const { data: msg, error: msgErr } = await admin
    .from("support_ticket_messages")
    .insert({
      ticket_id: ticket.id,
      sender_type: "user",
      sender_user_id: actor.kind === "user" ? actor.userId : null,
      body: message,
      images: [],
    })
    .select(MSG_SELECT)
    .single();
  if (msgErr) console.error("ticket first message failed", msgErr);

  await admin.from("support_ticket_messages").insert({
    ticket_id: ticket.id,
    sender_type: "system",
    body: "Ticket created. A confirmation email was sent.",
    images: [],
  });

  const toEmail =
    actor.kind === "user"
      ? actor.email ?? (await resolveUserEmail(admin, actor.userId))
      : actor.email;
  const requesterName =
    actor.kind === "user" ? (actor.email?.split("@")[0] ?? "there") : actor.name;

  if (toEmail) {
    const ack = await sendTicketAckEmail({
      to: toEmail,
      ticketNumber: ticket.number as number,
      subject,
      requesterName,
      resendApiKey: resendKey,
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
  }

  return Response.json(
    {
      ticket,
      message: msg,
      guest_token: ticket.guest_token,
    },
    { headers: corsHeaders },
  );
}

async function listTickets(admin: SupabaseClient, actor: Actor) {
  if (actor.kind === "agent") return bad(400, "Use agent_list");
  let q = admin.from("support_tickets").select(TICKET_SELECT).order("last_message_at", {
    ascending: false,
  });
  if (actor.kind === "user") {
    q = q.eq("user_id", actor.userId);
  } else {
    if (!actor.token) return bad(400, "guest_token required");
    q = q.eq("guest_token", actor.token);
  }
  const { data, error } = await q.limit(50);
  if (error) return bad(500, error.message);
  return Response.json({ tickets: data ?? [] }, { headers: corsHeaders });
}

async function getTicket(
  admin: SupabaseClient,
  actor: Actor,
  body: Record<string, unknown>,
  asAgent: boolean,
) {
  const ticketId = String(body.ticket_id ?? "").trim();
  if (!ticketId) return bad(400, "ticket_id required");

  const { data: ticket, error } = await admin
    .from("support_tickets")
    .select(TICKET_SELECT)
    .eq("id", ticketId)
    .maybeSingle();
  if (error || !ticket) return bad(404, "Ticket not found");

  if (!asAgent) {
    if (actor.kind === "user" && ticket.user_id !== actor.userId) {
      return bad(404, "Ticket not found");
    }
    if (actor.kind === "guest") {
      if (!actor.token || ticket.guest_token !== actor.token) {
        return bad(404, "Ticket not found");
      }
    }
  }

  const { data: messages, error: msgErr } = await admin
    .from("support_ticket_messages")
    .select(MSG_SELECT)
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  if (msgErr) return bad(500, msgErr.message);

  return Response.json(
    { ticket, messages: messages ?? [] },
    { headers: corsHeaders },
  );
}

async function agentList(admin: SupabaseClient, body: Record<string, unknown>) {
  const filter = String(body.filter ?? "open");
  const agentId = String(body.agent_user_id ?? "").trim();
  let q = admin.from("support_tickets").select(TICKET_SELECT).order("last_message_at", {
    ascending: false,
  }).limit(100);
  if (filter === "open") q = q.in("status", ["open", "pending"]);
  else if (filter === "mine" && agentId) {
    q = q.eq("assignee_id", agentId).in("status", ["open", "pending"]);
  }
  const { data, error } = await q;
  if (error) return bad(500, error.message);
  return Response.json({ tickets: data ?? [] }, { headers: corsHeaders });
}

async function claimTicket(
  admin: SupabaseClient,
  agentUserId: string,
  body: Record<string, unknown>,
) {
  const ticketId = String(body.ticket_id ?? "").trim();
  if (!ticketId) return bad(400, "ticket_id required");
  // Use service role path (auth.uid() null under service client) — do claim manually
  const { data: ticket, error } = await admin
    .from("support_tickets")
    .update({
      assignee_id: agentUserId,
      status: "open",
    })
    .eq("id", ticketId)
    .select(TICKET_SELECT)
    .single();
  if (error || !ticket) return bad(404, error?.message ?? "Ticket not found");
  await admin.from("support_ticket_messages").insert({
    ticket_id: ticketId,
    sender_type: "system",
    sender_user_id: agentUserId,
    body: "A support agent claimed this ticket.",
    images: [],
  });
  return Response.json({ ticket }, { headers: corsHeaders });
}

async function updateStatus(
  admin: SupabaseClient,
  agentUserId: string,
  body: Record<string, unknown>,
) {
  const ticketId = String(body.ticket_id ?? "").trim();
  const status = String(body.status ?? "").trim();
  if (!ticketId || !["open", "pending", "resolved", "closed"].includes(status)) {
    return bad(400, "ticket_id and valid status required");
  }
  const { data: ticket, error } = await admin
    .from("support_tickets")
    .update({ status })
    .eq("id", ticketId)
    .select(TICKET_SELECT)
    .single();
  if (error || !ticket) return bad(404, error?.message ?? "Ticket not found");
  await admin.from("support_ticket_messages").insert({
    ticket_id: ticketId,
    sender_type: "system",
    sender_user_id: agentUserId,
    body: `Ticket status set to ${status}.`,
    images: [],
  });
  return Response.json({ ticket }, { headers: corsHeaders });
}

async function agentReply(
  admin: SupabaseClient,
  agentUserId: string,
  body: Record<string, unknown>,
  resendKey: string | undefined,
) {
  const ticketId = String(body.ticket_id ?? "").trim();
  const message = String(body.message ?? body.body ?? "").trim().slice(0, 20000);
  if (!ticketId || !message) return bad(400, "ticket_id and message required");

  const { data: ticket, error } = await admin
    .from("support_tickets")
    .select(TICKET_SELECT)
    .eq("id", ticketId)
    .maybeSingle();
  if (error || !ticket) return bad(404, "Ticket not found");

  // Ensure claimed
  if (!ticket.assignee_id) {
    await admin
      .from("support_tickets")
      .update({ assignee_id: agentUserId, status: ticket.status === "closed" ? "open" : ticket.status })
      .eq("id", ticketId);
  }

  const toEmail = ticket.guest_email
    ? String(ticket.guest_email)
    : ticket.user_id
      ? await resolveUserEmail(admin, String(ticket.user_id))
      : null;
  if (!toEmail) return bad(400, "Ticket has no recipient email");

  // Prior message-id for threading
  const { data: prior } = await admin
    .from("support_ticket_messages")
    .select("email_message_id")
    .eq("ticket_id", ticketId)
    .not("email_message_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const send = await sendTicketAgentReplyEmail({
    to: toEmail,
    ticketId: String(ticket.id),
    ticketNumber: ticket.number as number,
    subject: String(ticket.subject),
    body: message,
    resendApiKey: resendKey,
    inReplyTo: prior?.email_message_id ?? null,
    references: prior?.email_message_id ?? null,
  });

  const syntheticMsgId = send.resendId
    ? `<${send.resendId}@unicopier.resend>`
    : null;

  const { data: msg, error: msgErr } = await admin
    .from("support_ticket_messages")
    .insert({
      ticket_id: ticketId,
      sender_type: "agent",
      sender_user_id: agentUserId,
      body: message,
      images: [],
      resend_id: send.resendId ?? null,
      email_message_id: syntheticMsgId,
    })
    .select(MSG_SELECT)
    .single();
  if (msgErr) return bad(500, msgErr.message);

  await admin
    .from("support_tickets")
    .update({ status: "pending" })
    .eq("id", ticketId)
    .in("status", ["open", "pending"]);

  if (!send.ok) {
    return Response.json(
      { message: msg, email_sent: false, warning: "Reply saved but email failed to send" },
      { headers: corsHeaders },
    );
  }

  return Response.json({ message: msg, email_sent: true }, { headers: corsHeaders });
}
