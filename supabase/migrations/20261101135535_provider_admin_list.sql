/*
  Provider onboarding — admin review queue listing.
  Admin-only; used by the backoffice "Provider applications" page.
*/
create or replace function public.admin_list_provider_applications(p_status text default null)
returns table (
  user_id uuid, display_name text, username text, email text,
  status text, submitted_at timestamptz, reviewed_at timestamptz, rejection_reason text, submit_count integer,
  declared_account_kind text, detected_account_mode text, prop_firm_name text,
  monthly_price_cents integer, access_mode text, bio text, social_links jsonb,
  account_label text, platform text, account_login text, connection_status text,
  balance numeric, equity numeric, currency text, synced_at timestamptz,
  eligibility text
)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.is_admin() then raise exception 'Admin access required' using errcode = '42501'; end if;
  if p_status is not null and p_status not in ('draft', 'pending', 'approved', 'rejected', 'suspended') then
    raise exception 'Invalid status filter' using errcode = '22023';
  end if;
  return query
  select pa.user_id,
    coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')),
    coalesce(nullif(btrim(up.username), ''), ''), au.email::text,
    pa.status, pa.submitted_at, pa.reviewed_at, pa.rejection_reason, pa.submit_count,
    pa.declared_account_kind, public.social_broker_account_mode(pa.broker_account_id), pa.prop_firm_name,
    pa.monthly_price_cents, pa.access_mode, pa.bio, pa.social_links,
    coalesce(nullif(btrim(b.label), ''), nullif(btrim(b.broker_name), '')), upper(b.platform),
    b.account_login::text, b.connection_status,
    b.last_balance, b.last_equity, upper(nullif(btrim(b.last_currency), '')), b.last_synced_at,
    public.provider_account_ineligibility(pa.user_id, pa.broker_account_id)
  from public.provider_applications pa
  left join public.user_profiles up on up.user_id = pa.user_id
  left join auth.users au on au.id = pa.user_id
  left join public.broker_accounts b on b.id = pa.broker_account_id
  where pa.status <> 'draft'
    and (p_status is null or pa.status = p_status)
  order by case pa.status when 'pending' then 0 else 1 end,
    coalesce(pa.submitted_at, pa.updated_at) asc;
end;
$$;

revoke all on function public.admin_list_provider_applications(text) from public, anon;
grant execute on function public.admin_list_provider_applications(text) to authenticated;
