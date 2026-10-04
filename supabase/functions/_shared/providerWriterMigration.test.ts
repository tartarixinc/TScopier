import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts"

const migrationUrl = new URL(
  "../../migrations/20260929130000_provider_writer_fencing.sql",
  import.meta.url,
)

Deno.test("provider writer migration declares the fence, transition shape, leases, and service-only RPCs", async () => {
  const sql = await Deno.readTextFile(migrationUrl)
  for (const required of [
    "writer_epoch bigint not null default 1",
    "provider_transition_state text not null default 'stable'",
    "provider_transition_target text",
    "create table if not exists public.broker_write_leases",
    "create or replace function public.acquire_broker_write_lease",
    "create or replace function public.begin_broker_provider_transition",
    "create or replace function public.finish_broker_provider_transition",
    "create or replace function public.abort_broker_provider_transition",
    "grant execute on function public.acquire_broker_write_lease",
  ]) assertStringIncludes(sql, required)

  assertStringIncludes(sql, "provider_transition_state = 'transition'")
  assertStringIncludes(sql, "writer_epoch = writer_epoch + 1")
  assertStringIncludes(sql, "provider_transition_state = 'stable'")
  assertStringIncludes(sql, "provider = p_target_provider")
  assert(!/drop\s+(table|column)\s+public\.broker_accounts/i.test(sql))
  assert(!/delete\s+from\s+public\.broker_accounts/i.test(sql))
})
