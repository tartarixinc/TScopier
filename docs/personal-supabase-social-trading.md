# Personal Supabase Social Trading development

This workflow creates deterministic Social Trading test data in one personal
Supabase project so the real hosted database can be tested without Docker.

It must never target staging, production, a migration project, or another shared
environment. The seed rejects the repository's known shared project references
and requires the personal reference to be typed before its first remote request.
It does not apply migrations, create broker credentials, use customer data,
create a Social Copy subscription, or start execution. All seeded broker rows are
synthetic demo accounts with trade execution disabled.

## Local configuration

Put these values in the Git-ignored .env.local file:

    SOCIAL_PERSONAL_SUPABASE_URL=https://YOUR_PERSONAL_PROJECT_REF.supabase.co
    SOCIAL_PERSONAL_PROJECT_REF=YOUR_PERSONAL_PROJECT_REF
    SOCIAL_PERSONAL_ANON_KEY=YOUR_PERSONAL_ANON_OR_PUBLISHABLE_KEY
    SOCIAL_PERSONAL_SERVICE_ROLE_KEY=YOUR_PERSONAL_SERVICE_ROLE_OR_SECRET_KEY
    SOCIAL_PERSONAL_TEST_PASSWORD=YOUR_LOCAL_TEST_PASSWORD

The URL must be exactly the HTTPS project-ref.supabase.co origin, optionally
with its root slash, and the configured reference must match it exactly. URL
credentials, all explicit ports, paths (including normalized dot or duplicate
slash paths), queries and fragments are rejected. The anon key is public
browser configuration.
The service-role key is for the local seed process only: keep it in .env.local,
never prefix it with VITE_, and rotate it if exposed. Use a unique test password
of at least 12 characters. The read-only verifier does not read or require the
service-role key.

## Run the workflow

From the repository root:

    npm run seed:social-personal

Read the prompt and type the exact personal project reference. A mismatch or a
non-interactive invocation exits before any remote request.

Then run:

    npm run verify:social-personal

The seed is fail-closed and only reruns against records it can prove it owns.
Before changing an existing Auth user, it requires the project, role and seed
markers to match in both authoritative immutable app_metadata and user_metadata.
A matching email alone never establishes ownership. All nine expected Auth accounts
are checked before either is created, reset or updated.

Each published source has a deterministic id. On its first run, the seed checks
all sources owned by each provider, id/broker collisions, every subscription
attached to those sources, and every copy subscription involving the synthetic
provider or viewer. It requires the subscription set to be empty, stages only
the exact source as paused, rechecks the complete affected set, and then invokes
the normal provider-authenticated publication RPC. A paused source cannot be
selected by the supported copy-subscription RPC. After publication, the seed
requires that exact source to be the sole source and again requires zero related
subscriptions.

On reruns, an already-published exact source is verified and the side-effecting
publication RPC is skipped. Any extra source, source ownership mismatch, or
related Social Copy subscription aborts before publication. The seed never
pauses or edits such records and never deletes records.

Re-run the seed when testing current eligibility after 15 minutes because the
schema intentionally treats an older last_synced_at value as stale.

## Synthetic identities

- Trader emails use provider, provider2, …, provider8 at
  YOUR_PERSONAL_PROJECT_REF.tscopier-seed.example.com.
- Viewer email:
  viewer@YOUR_PERSONAL_PROJECT_REF.tscopier-seed.example.com
- All nine users use SOCIAL_PERSONAL_TEST_PASSWORD.

The project-specific subdomain remains under the RFC-reserved example.com
domain while avoiding the application's deliberate block on the exact
example.com apex used by signup spam.

Each of the eight named seed providers tests a listed open profile, explicit history consent, a
published FxSocket/MT5 demo source, and 10 complete closed trades over more than
seven days. Parker is the reference identity used for the detailed performance,
follower, and review assertions.

Vivian Seed Viewer tests an accepted follow, a persisted five-star review, an
active connected FxSocket/MT5 demo destination, and denied history access
because the viewer's own history consent remains disabled.

The seed creates one marked synthetic Basic entitlement per user. Every provider is marked is_synthetic_demo in social_profiles; source discovery reports synthetic_demo and the database rejects copy-subscription inserts targeting one. The existing
broker plan-limit trigger requires it before inserting an active demo broker.
It has no Stripe subscription id and is not a Social Copy subscription.

## Browser verification

1. Run npm run dev and open /login.
2. Sign in as the viewer with the deterministic email and local test password.
3. Open /social-trading and find Parker in the live directory.
4. Open Parker's UUID-backed profile and inspect Performance, Trading,
   Portfolio, Reviews and Copy this trader.
5. Confirm the viewer demo destination is offered, but do not confirm a Social
   Copy subscription.
6. Sign in as the provider to inspect source and consent controls.

Readable slug profiles such as amira-hassan are development fixtures. Use the
UUID-backed Parker row when verifying the real database path.

## Expected results

The Parker reference provider should report:

- status available and eligibility eligible;
- account mode demo;
- 10 closed trades;
- 470 USD realized P/L;
- 70 percent win rate;
- profit factor 5.9474.

Return, maximum drawdown and equity curve remain unavailable because the schema
does not contain defensible cash-flow or periodic-equity history.

The viewer can read the open provider's explicitly shared history. The provider
cannot read the viewer's unshared history. Verification checks both paths
through the same RPC authorization boundaries as the frontend.

## Troubleshooting

### Missing provider

- Confirm the browser and scripts target the personal project.
- Run verification and distinguish an assertion from authentication/RPC errors.
- Confirm migrations are applied and PostgREST exposes get_social_directory.
- Re-run the seed if an earlier run stopped before social-profile registration.
- If publication preflight reports a source or subscription collision, inspect
  it manually. Do not relabel or delete it merely to make the seed pass.

### Unavailable performance or failed eligibility

- No selected published source means source publication did not complete.
- sync_pending means last_synced_at is null.
- history_stale means the seed is older than 15 minutes; re-run it.
- history_incomplete means a closed trade lacks a ticket or realized result.
- minimum_trades_not_met requires 10 complete closed trades.
- minimum_period_not_met requires at least seven days of closed history.
- source_disconnected, source_inactive, demo_only or source_unsupported mean the
  source no longer matches the required demo MT configuration.

### RLS denial

- Confirm the intended synthetic identity is signed in.
- Email/password users require user_profiles.email_verified_at, not only an
  Auth auto-confirm timestamp.
- Private providers require an accepted follow plus explicit history consent.
- Direct browser writes to Social Copy tables are intentionally unavailable.
  Never add policies or grants to work around the denial.

The scripts label configuration, authentication, RPC/query and assertion
failures separately. They do not print keys, passwords or session tokens. A
failed seed can be rerun after fixing the named stage. A run interrupted after
the deterministic source is staged leaves it paused; the next run verifies its
identity and safely resumes publication.

## Avoid shared environments

Before seeding, compare the direct URL and project reference in .env.local,
confirm that project in the Supabase dashboard, read the interactive prompt,
and never copy a team service-role key into the personal variables. The
verifier also refuses known shared references even though it is read-only.

## Manual reset of only synthetic data

There is deliberately no cleanup command. In the personal dashboard, locate the
nine deterministic Auth emails and confirm their user metadata contains:

    { "tscopier_seed_id": "tscopier-personal-social-v1" }

If either marker is absent, stop. Before removal, confirm neither user has a row
in social_copy_subscriptions. The seed never creates one; if one exists, inspect
and stop it through the supported application workflow first.

Using the confirmed synthetic Auth UUIDs, remove only marked rows in this
foreign-key-safe order:

1. social_trader_reviews where either UUID is reviewer or trader.
2. social_follow_relationships where either UUID is follower or followed.
3. social_copy_sources owned by the synthetic providers.
4. synthetic provider trades whose ticket begins with
   tscopier-personal-social-v1:YOUR_PERSONAL_PROJECT_REF:.
5. broker_accounts owned by a synthetic UUID whose label begins with
   [tscopier-personal-social-v1].
6. subscriptions owned by a synthetic UUID whose customer marker begins with
   cus_tscopier_personal_social_v1_.
7. social_profiles for the nine UUIDs.
8. Delete the nine users from Authentication > Users; the normal cascade removes
   remaining user_profiles rows.

Run select queries with the exact UUID and marker predicates before every
delete. Do not reset the database, truncate tables, delete by a broad email
domain, or remove migration history.
