# Mthryve OS

The AI operating system for Mthryve Marketing Inc. — see `docs/PROJECT.md` for full product vision and architecture, `docs/ROADMAP.md` for milestones, and `docs/TODO.md` for the current backlog.

This repo root **is** the Next.js app (App Router in `app/`), so Vercel deploys it with default settings — no Root Directory override needed. `docs/` and `mockup/` sit alongside it and are ignored by the build.

## Status

**Milestone 0 (Foundation) — COMPLETE and live.** The Supabase backend is real and connected:
- Project `otepdjhrawtqkzclaxbk` (region ap-northeast-1 / Tokyo)
- Migrations `0001`–`0004` applied and verified live (schema, RLS, security hardening, signup trigger)
- Seeded with the real Mthryve org: 7 departments, 10 brands
- `.env.local` is wired to it (gitignored)

**Milestone 1–2** (auth, role-based routing, dashboards reading live data) are implemented and deploying via Vercel.

## Deploying (Vercel)

The repo is connected to Vercel project **mthryve-os** (team **MTHRYVE OS**). Every push to `main` triggers a production build. Required env vars on the project (Production + Preview):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

(values are in `.env.local`). **Leave Root Directory blank** — the app is at the repo root.

## Running locally (optional)

1. Install Node.js 20 LTS from [nodejs.org](https://nodejs.org) (or `winget install OpenJS.NodeJS.LTS`), then reopen your terminal.
2. From the repo root:
   ```bash
   npm install
   npm run dev
   ```
3. Visit `http://localhost:3000` — you should land on `/login`. (`.env.local` is already filled in.)

## Create your first CEO user

In the Supabase dashboard → Authentication → Users → **Add user**, create yourself with email + password. In **User Metadata** add:
```json
{ "full_name": "Your Name", "role": "ceo" }
```
The `handle_new_user` trigger (migration 0004) auto-creates your `public.users` profile in the Mthryve org with the CEO role. Then sign in at `/login`.

> Migrations `0001`–`0004` are **already applied** to the live project — you do **not** need to re-run them. They live in `database/migrations/` as the source of truth and for reproducing the DB elsewhere.

## Project structure

See `docs/PROJECT.md` §6 for the full rationale. Short version:

- `app/` — Next.js App Router pages (`(auth)`, `(dashboard)` route groups)
- `components/` — shared UI (`ui/` primitives, `layout/` shell)
- `lib/` — Supabase clients (`lib/supabase/`) and the auth/session layer (`lib/auth/`)
- `types/database.ts` — hand-maintained types matching the SQL schema (regenerate via Supabase CLI once schema stabilizes)
- `database/migrations/` — SQL migrations, applied in order
- `middleware.ts` — session refresh + route protection
- `docs/` — living project documents (this repo's actual source of truth for direction)
- `mockup/` — static HTML design reference (not wired to anything)

## Living documents

Keep these current as work lands — they're not a one-time planning exercise:

- `docs/PROJECT.md` — vision & architecture
- `docs/ROADMAP.md` — milestones
- `docs/DECISIONS.md` — architectural decisions & rationale
- `docs/CHANGELOG.md` — what's actually shipped
- `docs/TODO.md` — prioritized backlog
- `docs/BUGS.md` — known issues & risk register
- `docs/AI_AGENTS.md` — AI agent specifications

## What's next

Milestone 3 (Task Management): projects → tasks → subtasks → comments → assignment, with brand tagging. Backend schema comes next. See `docs/TODO.md` for the full task list.
