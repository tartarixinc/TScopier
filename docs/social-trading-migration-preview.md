# Social Trading Migration preview

Synthetic Social Trading is disabled by default in every database and worker.
It may only be enabled for the isolated Migration preview project
`supmsgcubipmmowrzoub`.

## Required preview configuration

1. Apply the Social Trading forward migrations to the verified Migration
   project only.
2. Run `scripts/seed-social-trading-demo.ts` with the Migration project URL,
   its service-role key, and `SOCIAL_COPY_PREVIEW_SYNTHETIC_ENABLED=true`.
   The seed refuses production, staging, and every unknown project reference.
3. Configure the preview worker with:

   - `SOCIAL_COPY_EXECUTION_ENABLED=true`
   - `SOCIAL_COPY_SYNTHETIC_SIMULATION_ENABLED=true`
   - `SOCIAL_COPY_ALLOW_LIVE=true` only when genuine Live-account execution is
     intentionally authorized for that worker.

The seed sets the server-only `social_copy_runtime_config` row to
`environment_name = 'migration-preview'` and
`allow_synthetic_participants = true`. Authenticated clients cannot read or
change this table.

Every subscription involving a synthetic provider or subscriber is persisted
with `execution_path = 'synthetic_simulation'`. The worker acknowledges its
lifecycle and writes an execution event with zero broker orders; it resolves no
broker provider and performs no broker reads or writes.

## Production boundary

Do not run the synthetic seed in production. Leave the database flag false and
omit `SOCIAL_COPY_SYNTHETIC_SIMULATION_ENABLED` from production workers. A
missing config row, missing environment variable, or unconfigured environment
is fail-closed. `SOCIAL_COPY_ALLOW_LIVE` does not override the synthetic
simulation boundary.

Genuine broker execution currently supports MT4/MT5 accounts connected through
the `fxsocket` or `mtapi` providers. Demo-to-Demo is available when execution is
enabled. Demo-to-Live, Live-to-Demo, and Live-to-Live additionally require
`SOCIAL_COPY_ALLOW_LIVE=true`.
