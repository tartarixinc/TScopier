/*
  # marketing_promo_banner — promo banner above the marketing nav

  One row per campaign. Marketing visitors are anonymous, so `anon` may read a row, but only while it is
  enabled and inside its schedule window. Nothing is writable by clients: use the Supabase dashboard or
  the service role to create, edit or disable a campaign.

  Example (disabled until you flip `enabled`):

    insert into public.marketing_promo_banner
      (enabled, headline, coupon_code, cta_label, cta_href, media_url, ends_at)
    values
      (true, 'Halloween Special: 55% OFF', 'SPOOKY55', 'Get Code', '/pricing',
       'https://<project>.supabase.co/storage/v1/object/public/marketing-assets/halloween.mp4',
       now() + interval '3 days');

  Media: upload to the public `marketing-assets` bucket (service role / dashboard only). Use a wide
  image (about 1440 x 76), a GIF, or mp4/webm. `.mov` only plays reliably in Safari.
*/

create table if not exists public.marketing_promo_banner (
  id uuid primary key default gen_random_uuid(),
  enabled boolean not null default false,
  headline text,
  coupon_code text,
  cta_label text,
  -- A site path (/pricing) or an absolute https:// URL.
  cta_href text,
  media_url text,
  media_url_mobile text,
  starts_at timestamptz,
  -- Drives the countdown. After this moment the banner is no longer served.
  ends_at timestamptz,
  dismissible boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint marketing_promo_banner_window_check
    check (starts_at is null or ends_at is null or ends_at > starts_at),
  constraint marketing_promo_banner_headline_len check (headline is null or char_length(headline) <= 200),
  constraint marketing_promo_banner_coupon_len check (coupon_code is null or char_length(coupon_code) <= 40),
  constraint marketing_promo_banner_cta_label_len check (cta_label is null or char_length(cta_label) <= 40),
  constraint marketing_promo_banner_cta_href_shape
    check (cta_href is null or cta_href ~ '^(/[^/\\]|/$|https://)'),
  constraint marketing_promo_banner_media_shape
    check (media_url is null or media_url ~ '^(https://|/)'),
  constraint marketing_promo_banner_media_mobile_shape
    check (media_url_mobile is null or media_url_mobile ~ '^(https://|/)')
);

alter table public.marketing_promo_banner enable row level security;

drop policy if exists "Anyone can read the live promo banner" on public.marketing_promo_banner;
create policy "Anyone can read the live promo banner"
  on public.marketing_promo_banner for select
  to anon, authenticated
  using (
    enabled
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at > now())
  );

revoke all on public.marketing_promo_banner from anon, authenticated;
grant select on public.marketing_promo_banner to anon, authenticated;
grant all on public.marketing_promo_banner to service_role;

comment on table public.marketing_promo_banner is
  'Promo banner shown above the marketing nav. Readable by anyone while enabled and inside starts_at..ends_at; written only by the service role.';

-- Public brand/campaign media. Objects are world-readable; uploads are service-role only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'marketing-assets',
  'marketing-assets',
  true,
  8388608,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Marketing assets public read" on storage.objects;
create policy "Marketing assets public read"
  on storage.objects for select
  to public
  using (bucket_id = 'marketing-assets');
