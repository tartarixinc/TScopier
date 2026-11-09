-- Allow support agents (and admins via is_support_agent) to read profiles for inbox context.
drop policy if exists "Support agents can view profiles" on public.user_profiles;
create policy "Support agents can view profiles"
  on public.user_profiles for select to authenticated
  using (public.is_support_agent());
