-- Support chat image attachments (public storage + images[] on messages).

alter table public.support_messages
  add column if not exists images text[] not null default '{}';

do $$
declare
  r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'support_messages'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%body%'
  loop
    execute format('alter table public.support_messages drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.support_messages
  drop constraint if exists support_messages_body_or_images_check;

alter table public.support_messages
  add constraint support_messages_body_or_images_check
  check (
    char_length(body) <= 8000
    and (
      char_length(btrim(body)) > 0
      or cardinality(images) > 0
    )
    and cardinality(images) <= 3
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'support-attachments',
  'support-attachments',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Support attachments public read" on storage.objects;
create policy "Support attachments public read"
  on storage.objects for select
  to public
  using (bucket_id = 'support-attachments');

drop policy if exists "Users upload own support attachments" on storage.objects;
create policy "Users upload own support attachments"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'support-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users update own support attachments" on storage.objects;
create policy "Users update own support attachments"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'support-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'support-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users delete own support attachments" on storage.objects;
create policy "Users delete own support attachments"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'support-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
