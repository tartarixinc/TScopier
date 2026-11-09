-- So realtime UPDATE payloads include old.status (needed for AI → queued alerts).
alter table public.support_conversations replica identity full;
alter table public.support_tickets replica identity full;
