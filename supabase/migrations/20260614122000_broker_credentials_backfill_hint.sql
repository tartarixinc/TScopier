/*
  # Backfill broker accounts missing stored credentials

  Existing linked accounts cannot auto-heal until the user reconnects once
  (password is captured server-side on the next successful reconnect).
*/

update public.broker_accounts
set
  connection_error_kind = coalesce(connection_error_kind, 'session_expired'),
  connection_error_message = coalesce(
    nullif(trim(connection_error_message), ''),
    'Reconnect once to enable always-on session recovery.'
  )
where metaapi_account_id is not null
  and metaapi_account_id !~ '\|'
  and (auto_reconnect_enabled is not true or mt_password_encrypted is null)
  and connection_status = 'error';
