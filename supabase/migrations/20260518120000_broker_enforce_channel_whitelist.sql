-- Honor persisted signal_channel_ids: accounts that already saved a channel
-- subset should enforce the whitelist (matches Configure Trading modal).

update public.broker_accounts
set enforce_signal_channel_filter = true
where cardinality(signal_channel_ids) > 0
  and enforce_signal_channel_filter = false;

comment on column public.broker_accounts.enforce_signal_channel_filter is
  'When true, only telegram_channels ids in signal_channel_ids are copied. Configure Trading saves this with the checked channel list.';
