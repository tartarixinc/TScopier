import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export type AssistantEventType =
  | "assistant_tool_call"
  | "telegram_link_attempt"
  | "telegram_link_success"
  | "telegram_link_failed"
  | "telegram_link_disconnect";

let _supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
  }
  return _supabase;
}

export async function logAssistantEvent(args: {
  userId: string;
  eventType: AssistantEventType;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("listener_events").insert({
    user_id: args.userId,
    channel_row_id: null,
    telegram_message_id: null,
    event_type: args.eventType,
    detail: args.detail ?? {},
  });
  if (error) {
    console.warn(
      `[listenerEvents] insert failed type=${args.eventType} user=${args.userId}:`,
      error.message,
    );
  }
}
