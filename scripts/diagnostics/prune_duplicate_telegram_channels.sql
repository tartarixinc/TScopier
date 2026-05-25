-- Deactivate duplicate active telegram_channels rows that share a display name.
-- Keeps the row with the most recent last_seen_at (or newest created_at).
-- Run in Supabase SQL Editor, then re-link brokers in Copier Engine if needed.

with ranked as (
  select id,
         user_id,
         display_name,
         channel_id,
         row_number() over (
           partition by user_id, lower(trim(display_name))
           order by coalesce(last_seen_at, created_at) desc nulls last, created_at desc
         ) as rn
  from telegram_channels
  where is_active = true
)
update telegram_channels tc
set is_active = false,
    updated_at = now()
from ranked r
where tc.id = r.id
  and r.rn > 1
returning tc.id, tc.display_name, tc.channel_id;
