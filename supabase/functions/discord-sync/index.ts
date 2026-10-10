import { createClient } from "npm:@supabase/supabase-js@2"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  })
}

type DiscordChannel = { id?: string; type?: number; name?: string }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" })

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? ""
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  const botToken = (Deno.env.get("DISCORD_BOT_TOKEN") ?? "").trim()
  const auth = req.headers.get("Authorization") ?? ""
  if (!supabaseUrl || !anonKey || !serviceKey) return json(500, { error: "not_configured" })

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: auth } },
  })
  const { data: userData } = await userClient.auth.getUser()
  const user = userData.user
  if (!user) return json(401, { error: "unauthorized" })

  const body = await req.json().catch(() => ({})) as { guild_id?: string }
  const guildId = String(body.guild_id ?? "").trim()
  if (!/^\d{5,30}$/.test(guildId)) return json(400, { error: "invalid_guild" })

  const { data: install } = await userClient
    .from("discord_installations")
    .select("id")
    .eq("user_id", user.id)
    .eq("guild_id", guildId)
    .maybeSingle()
  if (!install) return json(403, { error: "not_installed" })
  if (!botToken) return json(503, { error: "bot_not_configured" })

  const headers = { Authorization: `Bot ${botToken}` }
  const guildRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, { headers })
  const admin = createClient(supabaseUrl, serviceKey)
  if (guildRes.ok) {
    const guild = await guildRes.json() as { name?: string }
    await admin
      .from("discord_installations")
      .update({ guild_name: String(guild.name ?? "") })
      .eq("guild_id", guildId)
  }

  const channelsRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, { headers })
  if (!channelsRes.ok) return json(502, { error: "discord_unavailable" })
  const channels = await channelsRes.json() as DiscordChannel[]
  const text = channels.filter(channel => channel.type === 0 && channel.id)
  if (text.length > 0) {
    const now = new Date().toISOString()
    const { error } = await admin.from("discord_guild_channels").upsert(
      text.map(channel => ({
        guild_id: guildId,
        discord_channel_id: channel.id,
        name: String(channel.name ?? "channel"),
        updated_at: now,
      })),
      { onConflict: "guild_id,discord_channel_id" },
    )
    if (error) return json(500, { error: "cache_failed" })
  }

  return json(200, {
    channels: text.map(channel => ({
      discord_channel_id: channel.id,
      name: String(channel.name ?? "channel"),
    })),
  })
})
