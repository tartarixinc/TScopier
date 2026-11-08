-- Phase A foundation for legacy/static/dynamic range-layering modes.
-- Additive only: existing range_pending_legs rows keep null plan fields and
-- continue to resolve as legacy behavior.

alter table public.range_pending_legs
  add column if not exists layer_plan_id text,
  add column if not exists layer_plan_metadata jsonb;

comment on column public.range_pending_legs.layer_plan_id is
  'Immutable range-layer plan identifier for future static/dynamic execution. Null legacy rows preserve existing behavior.';

comment on column public.range_pending_legs.layer_plan_metadata is
  'JSON snapshot for future layer plans: mode, original range, anchor, configured counts/step, planned layer count/lot, and lock timestamps. Null means legacy.';

create index if not exists range_pending_legs_layer_plan_id_idx
  on public.range_pending_legs(layer_plan_id)
  where layer_plan_id is not null;
