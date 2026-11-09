-- Allow support agents to upload attachments under their own folder (auth.uid()),
-- and under a conversation path when acting as agents. Existing user policy already
-- covers auth.uid() folder uploads; this adds an explicit agent-friendly path:
--   {agent_user_id}/agent/{conversation_id}/{file}

drop policy if exists "Support agents upload support attachments" on storage.objects;
create policy "Support agents upload support attachments"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'support-attachments'
    and public.is_support_agent()
    and (storage.foldername(name))[1] = auth.uid()::text
  );
