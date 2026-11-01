/*
  Provider onboarding — RPCs (phase 1).

  save_provider_draft / get_my_provider_application / submit_provider_application
  admin_review_provider_application (approve | reject | suspend | reinstate)
  update_provider_profile (approved providers edit price / access / bio / links)
  refresh_social_source_snapshot (+ cron every 5 min)
  get_provider_public_profile (anon-readable public profile by slug)
  get_social_directory extended with slug, provider status, bio and account snapshot
  publish_social_copy_source now requires an approved provider
*/

-- Helpers ------------------------------------------------------------------------------
create or replace function public.provider_account_ineligibility(p_user_id uuid, p_broker_account_id uuid)
returns text
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if p_broker_account_id is null then return 'account_missing'; end if;
  if not exists (
    select 1 from public.broker_accounts b where b.id = p_broker_account_id and b.user_id = p_user_id
  ) then return 'account_not_owned'; end if;
  if not exists (
    select 1 from public.broker_accounts b
    where b.id = p_broker_account_id and b.user_id = p_user_id
      and b.is_active = true
      and lower(coalesce(b.connection_status, '')) in ('connected', 'healthy')
  ) then return 'account_not_connected'; end if;
  if not exists (
    select 1 from public.broker_accounts b
    where b.id = p_broker_account_id
      and lower(coalesce(nullif(b.provider, ''), 'fxsocket')) in ('fxsocket', 'mtapi')
      and upper(coalesce(b.platform, '')) in ('MT4', 'MT5')
  ) then return 'platform_unsupported'; end if;
  if public.social_broker_account_mode(p_broker_account_id) not in ('demo', 'live') then
    return 'mode_unverified';
  end if;
  return null;
end;
$$;

create or replace function public.provider_notify(
  p_user_id uuid, p_actor uuid, p_event_type text, p_title text, p_body text, p_metadata jsonb default '{}'::jsonb
) returns void
language sql security definer set search_path = pg_catalog, public as $$
  insert into public.in_app_notifications
    (user_id, actor_user_id, event_type, event_key, title, body, action_url, metadata)
  values (
    p_user_id, p_actor, p_event_type,
    p_event_type || ':' || gen_random_uuid()::text,
    p_title, p_body, '/social-trading/provider', coalesce(p_metadata, '{}'::jsonb)
  )
$$;

create or replace function public.provider_audit(
  p_target uuid, p_action text, p_reason text, p_before jsonb, p_after jsonb
) returns void
language sql security definer set search_path = pg_catalog, public as $$
  insert into public.admin_audit_logs
    (actor_user_id, target_user_id, action, entity_type, entity_id, reason, before_state, after_state)
  values (auth.uid(), p_target, p_action, 'provider_application', p_target::text, p_reason, p_before, p_after)
$$;

revoke all on function public.provider_account_ineligibility(uuid, uuid) from public, anon, authenticated;
revoke all on function public.provider_notify(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.provider_audit(uuid, text, text, jsonb, jsonb) from public, anon, authenticated;

-- Snapshot refresh ----------------------------------------------------------------------
create or replace function public.refresh_social_source_snapshots_internal(p_source_id uuid default null)
returns integer
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_count integer;
begin
  update public.social_copy_sources s
  set account_kind = case
        when exists (
          select 1 from public.provider_applications pa
          where pa.user_id = s.trader_user_id
            and pa.broker_account_id = s.broker_account_id
            and pa.declared_account_kind = 'prop'
            and pa.status in ('approved', 'suspended')
        ) then 'prop'
        else public.social_broker_account_mode(s.broker_account_id)
      end,
      platform = upper(nullif(btrim(b.platform), '')),
      snapshot_balance = b.last_balance,
      snapshot_equity = b.last_equity,
      snapshot_currency = upper(nullif(btrim(b.last_currency), '')),
      snapshot_at = b.last_synced_at
  from public.broker_accounts b
  where b.id = s.broker_account_id
    and (p_source_id is null or s.id = p_source_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.refresh_social_source_snapshots_internal(uuid) from public, anon, authenticated;

create or replace function public.refresh_social_source_snapshot(p_source_id uuid)
returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.social_copy_sources s where s.id = p_source_id and s.trader_user_id = v_actor
  ) and not public.is_admin() then
    raise exception 'Copy source was not found' using errcode = 'P0002';
  end if;
  perform public.refresh_social_source_snapshots_internal(p_source_id);
end;
$$;
revoke all on function public.refresh_social_source_snapshot(uuid) from public, anon;
grant execute on function public.refresh_social_source_snapshot(uuid) to authenticated;

do $$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'refresh-social-source-snapshots';
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
end $$;
select cron.schedule(
  'refresh-social-source-snapshots', '*/5 * * * *',
  $$select public.refresh_social_source_snapshots_internal(null)$$
);

-- Draft ---------------------------------------------------------------------------------
create or replace function public.save_provider_draft(
  p_broker_account_id uuid default null,
  p_declared_account_kind text default null,
  p_prop_firm_name text default null,
  p_monthly_price_cents integer default null,
  p_access_mode text default 'open',
  p_bio text default null,
  p_social_links jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor uuid := auth.uid();
  v_status text;
  v_kind text := nullif(btrim(p_declared_account_kind), '');
  v_firm text := nullif(btrim(p_prop_firm_name), '');
  v_bio text := nullif(btrim(p_bio), '');
  v_links jsonb := coalesce(p_social_links, '{}'::jsonb);
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.social_follow_actor_is_verified(v_actor) then
    raise exception 'Becoming a provider requires a verified account' using errcode = '42501';
  end if;
  if v_kind is not null and v_kind not in ('demo', 'live', 'prop') then
    raise exception 'Invalid account type' using errcode = '22023';
  end if;
  if p_access_mode not in ('open', 'private') then
    raise exception 'Invalid access mode' using errcode = '22023';
  end if;
  if p_monthly_price_cents is not null and p_monthly_price_cents not between 0 and 10000000 then
    raise exception 'Invalid price' using errcode = '22023';
  end if;
  if v_bio is not null and char_length(v_bio) > 500 then
    raise exception 'Bio is too long' using errcode = '22023';
  end if;
  if not public.social_profile_links_are_valid(v_links) then
    raise exception 'Invalid social profile links' using errcode = '22023';
  end if;
  if p_broker_account_id is not null and not exists (
    select 1 from public.broker_accounts b where b.id = p_broker_account_id and b.user_id = v_actor
  ) then
    raise exception 'Broker account is not owned by the current user' using errcode = '42501';
  end if;
  if v_kind is distinct from 'prop' then v_firm := null; end if;

  select status into v_status from public.provider_applications where user_id = v_actor for update;
  if v_status = 'pending' then
    raise exception 'Your application is under review' using errcode = '55000';
  elsif v_status in ('approved', 'suspended') then
    raise exception 'Provider applications that were already reviewed cannot be redrafted' using errcode = '55000';
  end if;

  insert into public.provider_applications as pa
    (user_id, status, broker_account_id, declared_account_kind, prop_firm_name,
     monthly_price_cents, access_mode, bio, social_links)
  values (v_actor, 'draft', p_broker_account_id, v_kind, v_firm,
          p_monthly_price_cents, p_access_mode, v_bio, v_links)
  on conflict (user_id) do update set
    status = 'draft',
    broker_account_id = excluded.broker_account_id,
    declared_account_kind = excluded.declared_account_kind,
    prop_firm_name = excluded.prop_firm_name,
    monthly_price_cents = excluded.monthly_price_cents,
    access_mode = excluded.access_mode,
    bio = excluded.bio,
    social_links = excluded.social_links,
    updated_at = now();
end;
$$;

create or replace function public.get_my_provider_application()
returns table (
  status text, broker_account_id uuid, declared_account_kind text, prop_firm_name text,
  monthly_price_cents integer, access_mode text, bio text, social_links jsonb,
  terms_accepted_at timestamptz, submitted_at timestamptz, reviewed_at timestamptz,
  rejection_reason text, slug text, updated_at timestamptz
)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  return query
  select pa.status, pa.broker_account_id, pa.declared_account_kind, pa.prop_firm_name,
         pa.monthly_price_cents, pa.access_mode, pa.bio, pa.social_links,
         pa.terms_accepted_at, pa.submitted_at, pa.reviewed_at, pa.rejection_reason,
         sp.slug, pa.updated_at
  from public.provider_applications pa
  left join public.social_profiles sp on sp.user_id = pa.user_id
  where pa.user_id = v_actor;
end;
$$;

-- Submit --------------------------------------------------------------------------------
create or replace function public.submit_provider_application(p_accept_terms boolean default false)
returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor uuid := auth.uid();
  v_app public.provider_applications;
  v_problem text;
  v_mode text;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.social_follow_actor_is_verified(v_actor) then
    raise exception 'Becoming a provider requires a verified account' using errcode = '42501';
  end if;
  if p_accept_terms is not true then
    raise exception 'You must accept the provider terms' using errcode = '22023';
  end if;

  select * into v_app from public.provider_applications where user_id = v_actor for update;
  if not found then raise exception 'Save your application before submitting' using errcode = 'P0002'; end if;
  if v_app.status not in ('draft', 'rejected') then
    raise exception 'This application cannot be submitted in its current state' using errcode = '55000';
  end if;
  if v_app.submit_count >= 10 then
    raise exception 'Too many submissions; contact support' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.user_profiles up
    where up.user_id = v_actor
      and coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')) is not null
  ) then
    raise exception 'Add a display name or username to your profile first' using errcode = '55000';
  end if;

  v_problem := public.provider_account_ineligibility(v_actor, v_app.broker_account_id);
  if v_problem is not null then
    raise exception 'Selected account is not eligible (%)', v_problem using errcode = '55000';
  end if;
  if v_app.declared_account_kind is null then
    raise exception 'Select the account type' using errcode = '22023';
  end if;
  if v_app.declared_account_kind = 'prop' and v_app.prop_firm_name is null then
    raise exception 'Enter the prop firm name' using errcode = '22023';
  end if;
  v_mode := public.social_broker_account_mode(v_app.broker_account_id);
  if v_app.declared_account_kind in ('demo', 'live') and v_app.declared_account_kind <> v_mode then
    raise exception 'Declared account type does not match the connected account' using errcode = '22023';
  end if;
  if v_app.monthly_price_cents is null then
    raise exception 'Set a price (0 for free)' using errcode = '22023';
  end if;

  update public.provider_applications
  set status = 'pending', submitted_at = now(), terms_accepted_at = now(),
      submit_count = submit_count + 1, rejection_reason = null,
      reviewed_by = null, reviewed_at = null, updated_at = now()
  where user_id = v_actor;

  insert into public.social_profiles (user_id, is_listed, provider_status)
  values (v_actor, false, 'pending')
  on conflict (user_id) do update set provider_status = 'pending';
end;
$$;

-- Admin review --------------------------------------------------------------------------
create or replace function public.admin_review_provider_application(
  p_user_id uuid, p_decision text, p_reason text default null, p_account_kind text default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_admin uuid := auth.uid();
  v_app public.provider_applications;
  v_before jsonb;
  v_reason text := nullif(btrim(p_reason), '');
  v_kind text;
  v_problem text;
  v_source_id uuid;
  v_name text;
begin
  if v_admin is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.is_admin() then raise exception 'Admin access required' using errcode = '42501'; end if;
  if p_decision not in ('approve', 'reject', 'suspend', 'reinstate') then
    raise exception 'Invalid decision' using errcode = '22023';
  end if;

  select * into v_app from public.provider_applications where user_id = p_user_id for update;
  if not found then raise exception 'Application was not found' using errcode = 'P0002'; end if;
  v_before := to_jsonb(v_app) - 'social_links';

  select coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), ''), 'Trader')
  into v_name from public.user_profiles up where up.user_id = p_user_id;

  if p_decision = 'approve' or p_decision = 'reinstate' then
    if p_decision = 'approve' and v_app.status <> 'pending' then
      raise exception 'Only pending applications can be approved' using errcode = '55000';
    end if;
    if p_decision = 'reinstate' and v_app.status <> 'suspended' then
      raise exception 'Only suspended providers can be reinstated' using errcode = '55000';
    end if;
    v_problem := public.provider_account_ineligibility(p_user_id, v_app.broker_account_id);
    if v_problem is not null then
      raise exception 'Selected account is not eligible (%)', v_problem using errcode = '55000';
    end if;
    v_kind := coalesce(nullif(btrim(p_account_kind), ''), v_app.declared_account_kind);
    if v_kind not in ('demo', 'live', 'prop') then
      raise exception 'Invalid account type' using errcode = '22023';
    end if;

    update public.provider_applications
    set status = 'approved', declared_account_kind = v_kind, reviewed_by = v_admin,
        reviewed_at = now(), rejection_reason = null, updated_at = now()
    where user_id = p_user_id;

    insert into public.social_profiles
      (user_id, is_listed, access_mode, monthly_copy_price_cents, bio, provider_status)
    values (p_user_id, true, v_app.access_mode, v_app.monthly_price_cents, v_app.bio, 'approved')
    on conflict (user_id) do update set
      is_listed = true, access_mode = excluded.access_mode,
      monthly_copy_price_cents = excluded.monthly_copy_price_cents,
      bio = excluded.bio, provider_status = 'approved';

    update public.user_profiles
    set social_links = v_app.social_links, updated_at = now()
    where user_id = p_user_id;

    insert into public.social_copy_sources (trader_user_id, broker_account_id, status)
    values (p_user_id, v_app.broker_account_id, 'published')
    on conflict (broker_account_id) do update set status = 'published', updated_at = now()
    where public.social_copy_sources.trader_user_id = p_user_id
    returning id into v_source_id;
    if v_source_id is null then
      raise exception 'Copy source belongs to another trader' using errcode = '42501';
    end if;
    perform public.refresh_social_source_snapshots_internal(v_source_id);

    perform public.provider_notify(
      p_user_id, v_admin,
      case when p_decision = 'approve' then 'provider_application_approved' else 'provider_reinstated' end,
      case when p_decision = 'approve' then 'Your provider application was approved'
           else 'Your provider profile was reinstated' end,
      'Your profile is live in the Social Trading directory and your account can now be copied.',
      jsonb_build_object('decision', p_decision)
    );

  elsif p_decision = 'reject' then
    if v_app.status <> 'pending' then
      raise exception 'Only pending applications can be rejected' using errcode = '55000';
    end if;
    if v_reason is null then
      raise exception 'A rejection reason is required' using errcode = '22023';
    end if;
    update public.provider_applications
    set status = 'rejected', rejection_reason = left(v_reason, 1000),
        reviewed_by = v_admin, reviewed_at = now(), updated_at = now()
    where user_id = p_user_id;
    update public.social_profiles set provider_status = 'rejected' where user_id = p_user_id;
    perform public.provider_notify(
      p_user_id, v_admin, 'provider_application_rejected',
      'Your provider application needs changes', left(v_reason, 500),
      jsonb_build_object('decision', 'reject')
    );

  else -- suspend
    if v_app.status <> 'approved' then
      raise exception 'Only approved providers can be suspended' using errcode = '55000';
    end if;
    update public.provider_applications
    set status = 'suspended', rejection_reason = v_reason,
        reviewed_by = v_admin, reviewed_at = now(), updated_at = now()
    where user_id = p_user_id;
    update public.social_profiles
    set provider_status = 'suspended', is_listed = false
    where user_id = p_user_id;
    update public.social_copy_sources
    set status = 'paused', updated_at = now()
    where trader_user_id = p_user_id and status = 'published';
    update public.social_copy_subscriptions sub
    set desired_status = 'paused', updated_at = now()
    where sub.source_id in (select id from public.social_copy_sources where trader_user_id = p_user_id)
      and sub.status not in ('stopped', 'emergency_stopped')
      and sub.desired_status <> 'stopped';
    perform public.provider_notify(
      p_user_id, v_admin, 'provider_suspended',
      'Your provider profile was suspended',
      coalesce(left(v_reason, 500), 'Your provider profile was paused by an administrator.'),
      jsonb_build_object('decision', 'suspend')
    );
  end if;

  perform public.provider_audit(
    p_user_id, 'provider_application.' || p_decision, v_reason, v_before,
    (select to_jsonb(pa) - 'social_links' from public.provider_applications pa where pa.user_id = p_user_id)
  );

  return jsonb_build_object('user_id', p_user_id, 'name', v_name, 'decision', p_decision);
end;
$$;

-- Approved providers: edit price / access / bio / links ---------------------------------
create or replace function public.update_provider_profile(
  p_monthly_price_cents integer, p_access_mode text, p_bio text, p_social_links jsonb
) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor uuid := auth.uid();
  v_links jsonb := coalesce(p_social_links, '{}'::jsonb);
  v_bio text := nullif(btrim(p_bio), '');
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.social_profiles where user_id = v_actor and provider_status = 'approved'
  ) then raise exception 'Only approved providers can edit a provider profile' using errcode = '42501'; end if;
  if p_monthly_price_cents is null or p_monthly_price_cents not between 0 and 10000000 then
    raise exception 'Invalid price' using errcode = '22023';
  end if;
  if p_access_mode not in ('open', 'private') then
    raise exception 'Invalid access mode' using errcode = '22023';
  end if;
  if v_bio is not null and char_length(v_bio) > 500 then
    raise exception 'Bio is too long' using errcode = '22023';
  end if;
  if not public.social_profile_links_are_valid(v_links) then
    raise exception 'Invalid social profile links' using errcode = '22023';
  end if;

  update public.social_profiles
  set monthly_copy_price_cents = p_monthly_price_cents, access_mode = p_access_mode, bio = v_bio
  where user_id = v_actor;
  update public.user_profiles set social_links = v_links, updated_at = now() where user_id = v_actor;
  update public.provider_applications
  set monthly_price_cents = p_monthly_price_cents, access_mode = p_access_mode,
      bio = v_bio, social_links = v_links, updated_at = now()
  where user_id = v_actor;
end;
$$;

-- Publishing requires an approved provider ---------------------------------------------
create or replace function public.publish_social_copy_source(p_broker_account_id uuid, p_label text default null)
returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid(); v_id uuid;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.social_follow_actor_is_verified(v_actor) then
    raise exception 'Social copy source publishing requires a verified account' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.social_profiles sp where sp.user_id = v_actor and sp.provider_status = 'approved'
  ) then
    raise exception 'Your provider application must be approved before publishing a copy source'
      using errcode = '55000';
  end if;
  if not public.social_follow_profile_is_eligible(v_actor) then
    raise exception 'Join the social directory before publishing a copy source' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.broker_accounts b where b.id = p_broker_account_id and b.user_id = v_actor
  ) then
    raise exception 'Broker account is not owned by the current user' using errcode = '42501';
  end if;
  if public.provider_account_ineligibility(v_actor, p_broker_account_id) is not null then
    raise exception 'Broker account is not connected, supported, or mode-verified for Social Trading'
      using errcode = '55000';
  end if;

  insert into public.social_copy_sources (trader_user_id, broker_account_id, status, label)
  values (v_actor, p_broker_account_id, 'published', nullif(btrim(p_label), ''))
  on conflict (broker_account_id) do update set
    status = 'published', label = excluded.label, updated_at = now()
  where public.social_copy_sources.trader_user_id = v_actor
  returning id into v_id;
  if v_id is null then raise exception 'Copy source belongs to another trader' using errcode = '42501'; end if;
  perform public.refresh_social_source_snapshots_internal(v_id);
  return v_id;
end;
$$;

-- Directory -----------------------------------------------------------------------------
drop function if exists public.get_social_directory();
create function public.get_social_directory()
returns table (
  profile_user_id uuid, display_name text, username text, country text,
  access_mode text, is_self boolean, follower_count bigint, following_count bigint,
  viewer_relationship_status text, follows_viewer_status text, average_rating numeric,
  review_count bigint, viewer_rating smallint, shares_trade_history boolean,
  created_at timestamptz, monthly_copy_price_cents integer, is_synthetic_demo boolean,
  social_links jsonb,
  slug text, provider_status text, bio text,
  account_kind text, platform text, balance numeric, equity numeric, currency text, snapshot_at timestamptz
)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  return query
  select sp.user_id,
    coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')),
    coalesce(nullif(btrim(up.username), ''), ''), coalesce(nullif(btrim(up.country), ''), ''),
    sp.access_mode, sp.user_id = v_actor,
    (select count(*) from public.social_follow_relationships incoming
      join public.social_profiles ip on ip.user_id = incoming.follower_user_id
      join public.user_profiles ii on ii.user_id = incoming.follower_user_id
      where incoming.followed_user_id = sp.user_id and incoming.status = 'accepted'
        and ip.is_listed = true
        and coalesce(nullif(btrim(ii.display_name), ''), nullif(btrim(ii.username), '')) is not null),
    (select count(*) from public.social_follow_relationships outgoing_count
      join public.social_profiles fp on fp.user_id = outgoing_count.followed_user_id
      join public.user_profiles fi on fi.user_id = outgoing_count.followed_user_id
      where outgoing_count.follower_user_id = sp.user_id and outgoing_count.status = 'accepted'
        and fp.is_listed = true
        and coalesce(nullif(btrim(fi.display_name), ''), nullif(btrim(fi.username), '')) is not null),
    outgoing.status, incoming_viewer.status,
    (select round(avg(r.rating)::numeric, 2) from public.social_trader_reviews r where r.trader_user_id = sp.user_id),
    (select count(*) from public.social_trader_reviews r where r.trader_user_id = sp.user_id),
    (select r.rating from public.social_trader_reviews r where r.trader_user_id = sp.user_id and r.reviewer_user_id = v_actor),
    sp.share_trade_history, sp.created_at, sp.monthly_copy_price_cents,
    sp.is_synthetic_demo, coalesce(up.social_links, '{}'::jsonb),
    sp.slug, sp.provider_status, sp.bio,
    src.account_kind, src.platform, src.snapshot_balance, src.snapshot_equity,
    src.snapshot_currency, src.snapshot_at
  from public.social_profiles sp
  join public.user_profiles up on up.user_id = sp.user_id
  left join public.social_follow_relationships outgoing
    on outgoing.follower_user_id = v_actor and outgoing.followed_user_id = sp.user_id
  left join public.social_follow_relationships incoming_viewer
    on incoming_viewer.follower_user_id = sp.user_id and incoming_viewer.followed_user_id = v_actor
  left join lateral (
    select s.account_kind, s.platform, s.snapshot_balance, s.snapshot_equity, s.snapshot_currency, s.snapshot_at
    from public.social_copy_sources s
    where s.trader_user_id = sp.user_id and s.status = 'published'
    order by s.created_at asc
    limit 1
  ) src on true
  where sp.is_listed = true
    and coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')) is not null
  order by 7 desc, 2 asc, 1 asc;
end;
$$;

-- Public profile (anon readable) ---------------------------------------------------------
create or replace function public.get_provider_public_profile(p_slug text)
returns table (
  profile_user_id uuid, slug text, display_name text, username text, country text, bio text,
  access_mode text, follower_count bigint, average_rating numeric, review_count bigint,
  monthly_copy_price_cents integer, social_links jsonb,
  account_kind text, platform text, balance numeric, equity numeric, currency text,
  snapshot_at timestamptz, joined_at timestamptz
)
language sql stable security definer set search_path = pg_catalog, public as $$
  select sp.user_id, sp.slug,
    coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')),
    coalesce(nullif(btrim(up.username), ''), ''), coalesce(nullif(btrim(up.country), ''), ''),
    sp.bio, sp.access_mode,
    (select count(*) from public.social_follow_relationships f
      where f.followed_user_id = sp.user_id and f.status = 'accepted'),
    (select round(avg(r.rating)::numeric, 2) from public.social_trader_reviews r where r.trader_user_id = sp.user_id),
    (select count(*) from public.social_trader_reviews r where r.trader_user_id = sp.user_id),
    sp.monthly_copy_price_cents, coalesce(up.social_links, '{}'::jsonb),
    src.account_kind, src.platform, src.snapshot_balance, src.snapshot_equity,
    src.snapshot_currency, src.snapshot_at, sp.created_at
  from public.social_profiles sp
  join public.user_profiles up on up.user_id = sp.user_id
  left join lateral (
    select s.account_kind, s.platform, s.snapshot_balance, s.snapshot_equity, s.snapshot_currency, s.snapshot_at
    from public.social_copy_sources s
    where s.trader_user_id = sp.user_id and s.status = 'published'
    order by s.created_at asc
    limit 1
  ) src on true
  where sp.slug = lower(btrim(p_slug))
    and sp.is_listed = true
    and sp.provider_status = 'approved'
    and sp.is_synthetic_demo = false
    and coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')) is not null
$$;

-- Grants --------------------------------------------------------------------------------
revoke all on function public.save_provider_draft(uuid, text, text, integer, text, text, jsonb) from public, anon;
revoke all on function public.get_my_provider_application() from public, anon;
revoke all on function public.submit_provider_application(boolean) from public, anon;
revoke all on function public.admin_review_provider_application(uuid, text, text, text) from public, anon;
revoke all on function public.update_provider_profile(integer, text, text, jsonb) from public, anon;
revoke all on function public.publish_social_copy_source(uuid, text) from public, anon;
revoke all on function public.get_social_directory() from public, anon;
revoke all on function public.get_provider_public_profile(text) from public;
grant execute on function public.save_provider_draft(uuid, text, text, integer, text, text, jsonb) to authenticated;
grant execute on function public.get_my_provider_application() to authenticated;
grant execute on function public.submit_provider_application(boolean) to authenticated;
grant execute on function public.admin_review_provider_application(uuid, text, text, text) to authenticated;
grant execute on function public.update_provider_profile(integer, text, text, jsonb) to authenticated;
grant execute on function public.publish_social_copy_source(uuid, text) to authenticated;
grant execute on function public.get_social_directory() to authenticated;
grant execute on function public.get_provider_public_profile(text) to anon, authenticated;
