# uni Support — the support desk app (`apps/support-admin`)

**Status:** in this repository (pulled from the `upstream/support` branch on 2026-11-09); login CAPTCHA fix same day. The backend (tables, edge functions, migrations) lives on the `upstream/support` branch of `tartarixinc/TScopier`.

## What it is

`apps/support-admin` is the internal **support desk** web app used by support agents and
admins to answer customers. It is branded **uni Support** (logo: `public/uni-support-logo.png`)
and is a small standalone Vite + React app — its own `package.json`, dependencies and build,
the same pattern as `apps/backoffice`. It is *not* part of the main product build.

It has two working areas:

- **Inbox** (`/`) — the live chat stream. Customers talk to the app through the in-product
  support widget; each conversation appears here. Agents filter by **queued** (waiting to be
  picked up), **mine** (claimed by them) or **all**, open a conversation, read the thread
  (including images), **claim** it, **reply** (text plus up to 3 images) and **resolve** it
  when done. A conversation's states are `ai` (handled by the assistant), `queued`, `active`
  and `resolved`.
- **Tickets** (`/tickets`) — the numbered ticket system for issues that need tracking
  beyond a chat. Filters: **open**, **mine**, **all**. Agents can claim a ticket, reply,
  and move it through `open → pending → resolved → closed`. Tickets also work for guests
  (name + email, no account) and can carry email traffic: replies go out by email and
  replies sent by customers to the ticket email address come back in through the
  `support-ticket-inbound` edge function.

The shell (`AppShell`) provides the navigation rail (Inbox / Tickets / All chats), unread
counts, a quick search ("ticket", "queue", "mine"…) and notification sounds. Users sign out
from the user menu.

## Who can use it

The login page says it plainly: **"Support agents and admins only."** After sign-in,
`SupportGuard` reads `user_profiles` and allows the session only when:

- `is_support_agent = true`, **or**
- `is_admin = true` and `admin_until` is empty or in the future (`adminAccess.ts`).

Everyone else sees "Support agent access required" and cannot reach the Inbox or Tickets.

## Sign-in and CAPTCHA

Sign-in is a plain Supabase email + password login (`signInWithPassword`). Supabase Auth has
**CAPTCHA (Cloudflare Turnstile) enforced project-wide** on the backend this app points at,
so every password login must carry a captcha token. The login page renders the Turnstile
widget whenever `VITE_TURNSTILE_SITE_KEY` is set, keeps the Sign in button disabled until the
challenge is solved, and sends the token with the credentials. The site key is public by
design; it is a build-time (Netlify) variable. A production build without the key fails
closed with "Login protection is misconfigured" rather than silently sending tokenless
requests (the failure mode that caused the 2026-11-02 admin-panel lockout — see
`docs/incidents/incident-2026-11-02-admin-panel-captcha-lockout.md`).

Two operational notes:

- The Cloudflare Turnstile widget's **hostname list must include this app's host**, or the
  widget never renders and the Sign in button stays disabled.
- After changing `VITE_TURNSTILE_SITE_KEY` (or any `VITE_*` var) the Netlify site must
  **rebuild** — Vite bakes these in at build time.

## Backend (Supabase)

The app talks directly to Supabase project **`supmsgcubipmmowrzoub`** (the Unicopier /
migration backend; see `apps/support-admin/.env.example`). It needs, on that project:

| Kind | Name | Used for |
|---|---|---|
| Tables | `support_conversations`, `support_messages` | live chat inbox |
| Tables | `support_tickets`, `support_ticket_messages` (names per migration) | tickets |
| RPC | `support_claim_conversation`, `resolve`-family RPCs | claim / resolve safely |
| Edge function | `support-chat` | customer-side chat (widget → conversation) |
| Edge function | `support-tickets` | agent ticket actions (`agent_list`, `agent_get`, reply, status) |
| Edge function | `support-ticket-inbound` | inbound customer email → ticket reply |
| Storage bucket | `support-attachments` | agent/customer image uploads (max 3 images, resized client-side to 1280 px / JPEG ~0.72) |

The migrations that create all of this (`20261109100000_support_live_chat_system.sql` and
the six follow-ups) and the edge functions are on the **`upstream/support` branch** — they are
not yet part of this branch's `supabase/` tree. The customer-facing widget lives in the main
product (`src/components/support/`).

Access is enforced in the database: agent reads/claims are gated on
`is_support_agent` / `is_admin()`; the app never uses the service-role key.

## Stack and layout

- Vite + React 19 + TypeScript + Tailwind CSS 4 + React Router 7 + `@supabase/supabase-js`.
- `src/pages/` — `LoginPage`, `InboxPage`, `TicketsPage`.
- `src/components/` — `AppShell`, `SupportGuard`, `TurnstileWidget`, `UserMenu`.
- `src/lib/` — `supabase` (client), `supportApi` (chat, direct table/RPC access),
  `ticketsApi` (ticket actions via the `support-tickets` edge function),
  `supportImages` (resize/validate/upload), `supportAccess`/`adminAccess` (access rules),
  `turnstile` (site-key helpers).
- `src/context/AuthContext.tsx` — session state.
- `public/_redirects` — SPA fallback for Netlify.

## Local development

```bash
cd apps/support-admin
npm install
cp .env.example .env   # fill VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_TURNSTILE_SITE_KEY
npm run dev            # Vite dev server
npm run build          # tsc -b && vite build → dist/
```

The site key is public; the anon key is public by design. Never commit `.env`.

## Deployment (Netlify)

Deployed as its **own Netlify site**, separate from the main product build:

| Setting | Value |
|---|---|
| Base directory | `apps/support-admin` |
| Build command | `npm run build` (`tsc -b && vite build`) |
| Publish directory | `dist` |
| SPA redirect | `public/_redirects` (`/* /index.html 200`) — already in the app |

Environment variables (Production scope, set **before** the build):

- `VITE_SUPABASE_URL` — `https://supmsgcubipmmowrzoub.supabase.co`
- `VITE_SUPABASE_ANON_KEY` — the project's anon key
- `VITE_TURNSTILE_SITE_KEY` — the same public Turnstile site key the main app uses, with this
  app's host added to the widget's hostname list in Cloudflare

## History

- Built on the `support` feature branch of `tartarixinc/TScopier` (author: Planmoni App /
  Martins) and pulled into this repository from `upstream/support` on 2026-11-09
  (`git checkout upstream/support -- apps/support-admin`).
- The branch tip (`0c607aeb`) briefly removed the app again the same day; it was restored on
  `upstream/support` with the Turnstile login fix and this documentation.
- 2026-11-09: login was failing with `captcha protection: request disallowed
  (no captcha_token found)` because the app had no Turnstile widget while CAPTCHA is
  enforced project-wide — fixed by the integration described above (same root cause as the
  2026-11-02 admin-panel lockout).

## Related docs

- `docs/tscopier-admin.md` — the separate internal operations dashboard (panel.tscopier.cloud).
- `docs/unicopier.md` — what Unicopier is and how the repository is organised.
- `docs/incidents/incident-2026-11-02-admin-panel-captcha-lockout.md` — the CAPTCHA lockout
  incident on the admin panel (same failure family).
