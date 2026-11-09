/**
 * support-chat — support AI for signed-in users and guests (name + email).
 *
 * POST body:
 *   { action: "send", conversation_id?, message?, images?, image_data_urls?,
 *     guest_name?, guest_email?, guest_token? }
 *   { action: "escalate", conversation_id?, guest_token? }
 *   { action: "list", conversation_id?, guest_token? }
 *
 * Auth: Bearer user JWT optional. Guests authenticate with guest_token (+ name/email on create).
 * verify_jwt must be false so guests can call without a user session.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = Deno.env.get("SUPPORT_OPENAI_MODEL")?.trim() || "gpt-4o-mini";
const MAX_HISTORY = 24;
const MAX_IMAGES = 3;
const MESSAGE_SELECT =
  "id, conversation_id, sender_type, sender_user_id, body, images, created_at";
const CONVO_SELECT =
  "id, user_id, status, assignee_id, subject, last_message_at, created_at, updated_at, guest_name, guest_email, guest_token";

const SUPPORT_SYSTEM_PROMPT = `You are UniCopier Support — a helpful, concise support agent for UniCopier (Telegram/Discord/TradingView trade-copying to MetaTrader and other brokers).

Your job:
- Answer setup, billing, connection, and troubleshooting questions clearly.
- Prefer short practical steps over long essays.
- Users may attach screenshots — describe what you see and map it to UniCopier UI/actions when relevant.
- If the user is frustrated, blocked, asks for a human, or the issue needs account-specific investigation you cannot do, call escalate_to_human.
- Never invent billing charges, credentials, or internal system details you do not know.
- Do not discuss unrelated topics; politely steer back to UniCopier support.
- When escalating, tell the user a human agent will join shortly.`;

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type Actor =
  | { kind: "user"; userId: string }
  | { kind: "guest"; name: string; email: string; token: string | null };

function bad(status: number, message: string) {
  return Response.json({ error: message }, { status, headers: corsHeaders });
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalizeHttpImageUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const url = item.trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (url.length > 2048) continue;
    out.push(url);
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

function normalizeDataUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const url = item.trim();
    if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(url)) continue;
    if (url.length > 1_400_000) continue;
    out.push(url);
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320;
}

function userContent(text: string, images: string[]): string | ContentPart[] {
  const caption = text.trim() || (images.length ? "Please look at the attached image(s)." : "");
  if (images.length === 0) return caption;
  const parts: ContentPart[] = [{ type: "text", text: caption }];
  for (const url of images) {
    parts.push({ type: "image_url", image_url: { url } });
  }
  return parts;
}

function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; contentType: string; ext: string } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  const contentType = match[1].toLowerCase();
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const ext = contentType.includes("png")
      ? "png"
      : contentType.includes("webp")
        ? "webp"
        : contentType.includes("gif")
          ? "gif"
          : "jpg";
    return { bytes, contentType, ext };
  } catch {
    return null;
  }
}

async function uploadDataUrls(
  admin: SupabaseClient,
  folder: string,
  dataUrls: string[],
): Promise<string[]> {
  const urls: string[] = [];
  for (const dataUrl of dataUrls) {
    const decoded = decodeDataUrl(dataUrl);
    if (!decoded) continue;
    const path = `${folder}/${crypto.randomUUID()}.${decoded.ext}`;
    const { error } = await admin.storage.from("support-attachments").upload(path, decoded.bytes, {
      contentType: decoded.contentType,
      upsert: false,
      cacheControl: "3600",
    });
    if (error) {
      console.error("guest image upload failed", error.message);
      continue;
    }
    const { data } = admin.storage.from("support-attachments").getPublicUrl(path);
    urls.push(data.publicUrl);
  }
  return urls;
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

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad(400, "Invalid JSON");
  }

  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  let userId: string | null = null;
  if (bearer) {
    const { data: authData } = await admin.auth.getUser(bearer);
    if (authData.user) userId = authData.user.id;
  }

  const guestName = String(body.guest_name ?? "").trim().slice(0, 120);
  const guestEmail = String(body.guest_email ?? "").trim().toLowerCase().slice(0, 320);
  const guestToken = String(body.guest_token ?? "").trim() || null;

  let actor: Actor | null = null;
  if (userId) {
    actor = { kind: "user", userId };
  } else if (guestToken || (guestName && guestEmail)) {
    if (guestEmail && !isValidEmail(guestEmail) && !guestToken) {
      return bad(400, "Valid email required");
    }
    actor = {
      kind: "guest",
      name: guestName,
      email: guestEmail,
      token: guestToken,
    };
  } else {
    return bad(401, "Sign in or provide name and email to chat");
  }

  const action = String(body.action ?? "send");

  if (action === "list") {
    return await handleList(admin, actor, body);
  }

  if (action === "escalate") {
    return await handleEscalate(admin, actor, body);
  }

  if (action !== "send") return bad(400, "Unknown action");
  return await handleSend(admin, actor, body);
});

async function resolveConversation(
  admin: SupabaseClient,
  actor: Actor,
  conversationId: string | null,
  createIfMissing: boolean,
): Promise<
  | { ok: true; convo: Record<string, unknown> }
  | { ok: false; status: number; error: string }
> {
  if (conversationId) {
    const { data: convo } = await admin
      .from("support_conversations")
      .select(CONVO_SELECT)
      .eq("id", conversationId)
      .maybeSingle();
    if (!convo) return { ok: false, status: 404, error: "Conversation not found" };
    if (actor.kind === "user") {
      if (convo.user_id !== actor.userId) {
        return { ok: false, status: 404, error: "Conversation not found" };
      }
    } else if (!actor.token || convo.guest_token !== actor.token) {
      return { ok: false, status: 404, error: "Conversation not found" };
    }
    return { ok: true, convo };
  }

  if (actor.kind === "user") {
    const { data: existing } = await admin
      .from("support_conversations")
      .select(CONVO_SELECT)
      .eq("user_id", actor.userId)
      .in("status", ["ai", "queued", "active"])
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return { ok: true, convo: existing };
    if (!createIfMissing) return { ok: false, status: 404, error: "No open conversation" };
    const { data: created, error } = await admin
      .from("support_conversations")
      .insert({ user_id: actor.userId, status: "ai" })
      .select(CONVO_SELECT)
      .single();
    if (error || !created) {
      return { ok: false, status: 500, error: error?.message ?? "Failed to create conversation" };
    }
    return { ok: true, convo: created };
  }

  // Guest
  if (actor.token) {
    const { data: byToken } = await admin
      .from("support_conversations")
      .select(CONVO_SELECT)
      .eq("guest_token", actor.token)
      .in("status", ["ai", "queued", "active"])
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byToken) return { ok: true, convo: byToken };
  }

  if (!createIfMissing) return { ok: false, status: 404, error: "No open conversation" };
  if (!actor.name || !isValidEmail(actor.email)) {
    return { ok: false, status: 400, error: "Name and valid email required" };
  }

  const { data: created, error } = await admin
    .from("support_conversations")
    .insert({
      user_id: null,
      status: "ai",
      guest_name: actor.name,
      guest_email: actor.email,
      guest_token: crypto.randomUUID(),
      subject: `${actor.name} (guest)`,
    })
    .select(CONVO_SELECT)
    .single();
  if (error || !created) {
    return { ok: false, status: 500, error: error?.message ?? "Failed to create conversation" };
  }
  return { ok: true, convo: created };
}

async function handleList(
  admin: SupabaseClient,
  actor: Actor,
  body: Record<string, unknown>,
) {
  const conversationId = String(body.conversation_id ?? "").trim() || null;
  const resolved = await resolveConversation(admin, actor, conversationId, false);
  if (!resolved.ok) return bad(resolved.status, resolved.error);
  const convo = resolved.convo;
  const { data: messages, error } = await admin
    .from("support_messages")
    .select(MESSAGE_SELECT)
    .eq("conversation_id", convo.id as string)
    .order("created_at", { ascending: true });
  if (error) return bad(500, error.message);
  return Response.json(
    {
      conversation: {
        id: convo.id,
        status: convo.status,
        guest_token: actor.kind === "guest" ? convo.guest_token : undefined,
        guest_name: convo.guest_name,
        guest_email: convo.guest_email,
        last_message_at: convo.last_message_at,
      },
      messages: messages ?? [],
    },
    { headers: corsHeaders },
  );
}

async function handleEscalate(
  admin: SupabaseClient,
  actor: Actor,
  body: Record<string, unknown>,
) {
  const conversationId = String(body.conversation_id ?? "").trim() || null;
  const resolved = await resolveConversation(admin, actor, conversationId, false);
  if (!resolved.ok) return bad(resolved.status, resolved.error);
  const convo = resolved.convo;
  const id = convo.id as string;

  if (convo.status === "active" || convo.status === "resolved") {
    return bad(400, "Conversation cannot be escalated");
  }
  if (convo.status === "queued") {
    return Response.json(
      { ok: true, conversation_id: id, guest_token: convo.guest_token },
      { headers: corsHeaders },
    );
  }

  const { error: updErr } = await admin
    .from("support_conversations")
    .update({ status: "queued", assignee_id: null })
    .eq("id", id)
    .eq("status", "ai");
  if (updErr) return bad(500, updErr.message);

  await admin.from("support_messages").insert({
    conversation_id: id,
    sender_type: "system",
    sender_user_id: null,
    body: "You requested a human agent. Our support team will join shortly.",
    images: [],
  });

  return Response.json(
    { ok: true, conversation_id: id, guest_token: convo.guest_token },
    { headers: corsHeaders },
  );
}

async function handleSend(
  admin: SupabaseClient,
  actor: Actor,
  body: Record<string, unknown>,
) {
  const message = String(body.message ?? "").trim();
  let images = normalizeHttpImageUrls(body.images);
  const dataUrls = normalizeDataUrls(body.image_data_urls);
  if ((!message && images.length === 0 && dataUrls.length === 0) || message.length > 8000) {
    return bad(400, "message or images required (message ≤ 8000 chars, ≤ 3 images)");
  }

  const conversationId = String(body.conversation_id ?? "").trim() || null;
  const resolved = await resolveConversation(admin, actor, conversationId, true);
  if (!resolved.ok) return bad(resolved.status, resolved.error);
  const convo = resolved.convo;
  const id = convo.id as string;

  if (convo.status === "resolved") {
    return bad(400, "Conversation is resolved — start a new message from Home");
  }

  if (dataUrls.length && images.length < MAX_IMAGES) {
    const folder =
      actor.kind === "user"
        ? `${actor.userId}/${id}`
        : `guest/${convo.guest_token ?? id}/${id}`;
    const uploaded = await uploadDataUrls(admin, folder, dataUrls.slice(0, MAX_IMAGES - images.length));
    images = [...images, ...uploaded].slice(0, MAX_IMAGES);
  }

  const persistBody = message || (images.length ? "Shared an image" : "");

  const { data: userMsg, error: userMsgErr } = await admin
    .from("support_messages")
    .insert({
      conversation_id: id,
      sender_type: "user",
      sender_user_id: actor.kind === "user" ? actor.userId : null,
      body: persistBody,
      images,
    })
    .select(MESSAGE_SELECT)
    .single();

  if (userMsgErr || !userMsg) {
    return bad(500, userMsgErr?.message ?? "Failed to save message");
  }

  if (convo.status === "queued" || convo.status === "active") {
    return Response.json(
      {
        conversation_id: id,
        status: convo.status,
        guest_token: convo.guest_token,
        user_message: userMsg,
        ai_message: null,
        escalated: false,
      },
      { headers: corsHeaders },
    );
  }

  if (!OPENAI_API_KEY) {
    const { data: fallback } = await admin
      .from("support_messages")
      .insert({
        conversation_id: id,
        sender_type: "ai",
        sender_user_id: null,
        body:
          "Thanks for reaching out. Our AI assistant is temporarily unavailable — tap Request human agent and a teammate will help shortly.",
        images: [],
      })
      .select(MESSAGE_SELECT)
      .single();

    return Response.json(
      {
        conversation_id: id,
        status: "ai",
        guest_token: convo.guest_token,
        user_message: userMsg,
        ai_message: fallback,
        escalated: false,
      },
      { headers: corsHeaders },
    );
  }

  const { data: historyRows } = await admin
    .from("support_messages")
    .select("sender_type, body, images")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    .limit(MAX_HISTORY);

  const history: ChatMessage[] = [{ role: "system", content: SUPPORT_SYSTEM_PROMPT }];
  for (const row of historyRows ?? []) {
    const imgs = normalizeHttpImageUrls(row.images);
    if (row.sender_type === "user") {
      history.push({ role: "user", content: userContent(String(row.body ?? ""), imgs) });
    } else if (row.sender_type === "ai" || row.sender_type === "agent") {
      history.push({ role: "assistant", content: String(row.body ?? "") });
    } else if (row.sender_type === "system") {
      history.push({ role: "system", content: String(row.body ?? "") });
    }
  }

  const tools = [
    {
      type: "function",
      function: {
        name: "escalate_to_human",
        description:
          "Escalate this conversation to a human support agent when the user asks for a person, is blocked, or needs account-specific help you cannot resolve.",
        parameters: {
          type: "object",
          properties: {
            reason: { type: "string", description: "Brief reason for escalation" },
          },
        },
      },
    },
  ];

  let escalated = false;
  let assistantText = "";

  try {
    for (let round = 0; round < 3; round++) {
      const oaRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: history,
          tools,
          tool_choice: "auto",
          temperature: 0.4,
        }),
      });

      if (!oaRes.ok) {
        const errText = await oaRes.text().catch(() => "");
        console.error("support-chat OpenAI error", oaRes.status, errText.slice(0, 400));
        assistantText =
          "Sorry — I hit a temporary issue. Please try again or request a human agent.";
        break;
      }

      const oaJson = (await oaRes.json()) as {
        choices?: Array<{ message?: ChatMessage }>;
      };
      const choice = oaJson.choices?.[0]?.message;
      if (!choice) {
        assistantText = "Sorry — I could not generate a reply. Please try again.";
        break;
      }

      history.push(choice);
      const toolCalls = choice.tool_calls ?? [];
      if (toolCalls.length === 0) {
        assistantText = String(choice.content ?? "").trim();
        break;
      }

      for (const call of toolCalls) {
        const name = call.function?.name ?? "";
        const args = parseArgs(call.function?.arguments ?? "{}");
        if (name === "escalate_to_human") {
          const esc = await escalateById(admin, id);
          escalated = esc.ok;
          history.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({
              ok: esc.ok,
              reason: typeof args.reason === "string" ? args.reason : null,
              message: esc.ok
                ? "Escalated. A human agent will join shortly."
                : esc.error,
            }),
          });
        } else {
          history.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ error: "Unknown tool" }),
          });
        }
      }
    }
  } catch (err) {
    console.error("support-chat OpenAI exception", err);
    assistantText =
      "Sorry — I hit a temporary issue. Please try again or request a human agent.";
  }

  if (!assistantText) {
    assistantText = escalated
      ? "I've connected you with our support team. A human agent will join this chat shortly."
      : "Thanks for your message — how else can I help?";
  }

  const { data: aiMsg, error: aiErr } = await admin
    .from("support_messages")
    .insert({
      conversation_id: id,
      sender_type: "ai",
      sender_user_id: null,
      body: assistantText,
      images: [],
    })
    .select(MESSAGE_SELECT)
    .single();
  if (aiErr) console.error("support-chat AI persist error", aiErr);

  const { data: latestConvo } = await admin
    .from("support_conversations")
    .select("status, guest_token")
    .eq("id", id)
    .maybeSingle();

  return Response.json(
    {
      conversation_id: id,
      status: latestConvo?.status ?? (escalated ? "queued" : "ai"),
      guest_token: latestConvo?.guest_token ?? convo.guest_token,
      user_message: userMsg,
      ai_message: aiMsg ?? null,
      escalated,
    },
    { headers: corsHeaders },
  );
}

async function escalateById(
  admin: SupabaseClient,
  conversationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: convo } = await admin
    .from("support_conversations")
    .select("id, status")
    .eq("id", conversationId)
    .maybeSingle();
  if (!convo) return { ok: false, error: "Conversation not found" };
  if (convo.status === "queued") return { ok: true };
  if (convo.status !== "ai") return { ok: false, error: "Cannot escalate" };

  const { error } = await admin
    .from("support_conversations")
    .update({ status: "queued", assignee_id: null })
    .eq("id", conversationId)
    .eq("status", "ai");
  if (error) return { ok: false, error: error.message };

  await admin.from("support_messages").insert({
    conversation_id: conversationId,
    sender_type: "system",
    sender_user_id: null,
    body: "You requested a human agent. Our support team will join shortly.",
    images: [],
  });
  return { ok: true };
}
