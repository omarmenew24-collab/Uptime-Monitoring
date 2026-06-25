# Architecture Context

> This describes the **target architecture**. Every piece (queue, cache, event
> bus, rollups) is justified by a forcing requirement in
> `system-design-roadmap.md` and will be built. Build in phase order
> (1→2→3→4→5); each phase's gate is "the previous one is done."

## Stack

| Layer      | Technology              | Role                                              |
| ---------- | ----------------------- | ------------------------------------------------- |
| API        | Node.js + Express       | REST API, auth, serves dashboard/status reads     |
| Worker     | Node.js (no Express)    | Consumes the queue, executes HTTP checks          |
| Database   | PostgreSQL (Neon)       | Source of truth — monitors, checks, rollups       |
| Queue/Cache| Redis + BullMQ          | Durable job queue, cache, pub/sub event bus       |
| Auth       | Clerk                   | User identity, session management, route protection |
| Frontend   | React (plain, no Next)  | Dashboard UI, served separately                   |
| Validation | Zod                     | Request input validation at route boundaries      |
| Styling    | Plain CSS + tokens      | Custom properties design system, no framework     |
| Icons      | Lucide React            | Stroke-based icon set                             |

The **API** and **Worker** are separate deployables that share Postgres and
Redis. Redis is the source of truth for nothing — it is queue, cache, and event
transport only; Postgres remains the durable record.

## System Boundaries

- `backend/routes/` — Express route definitions only. Parses and validates input, calls a service, returns a response. No logic lives here.
- `backend/services/` — All business logic. One file per domain: `monitors.service.js`, `checks.service.js`, `alerts.service.js`. This is where decisions get made. Shared by both the API and the worker.
- `backend/db/` — All database access. Raw `pg` queries, parameterized. No query construction outside this folder. Migrations live here too.
- `backend/schemas/` — Zod validation schemas. One file per domain. Imported by routes before any handler runs.
- `backend/queue/` — BullMQ queue definitions, the dispatcher (enqueues check jobs for due monitors), and worker processors. The dispatcher decides *what* to run; workers *execute*. Neither contains business logic — they call services.
- `backend/cache/` — Redis cache accessors for hot read paths (current status, uptime rollups). Cache-aside reads and invalidation live here, not in routes.
- `backend/events/` — Event bus (Redis pub/sub) publish/subscribe helpers and the consumers that react to state-change events (email, Slack, status page, incident log).
- `frontend/src/components/` — Reusable UI pieces. No data fetching inside components.
- `frontend/src/pages/` — Top-level route views. Compose components, own page-level state.
- `frontend/src/hooks/` — All data fetching and stateful logic. Components call hooks, not the API directly.
- `frontend/src/styles/` — Global CSS tokens and base styles. `tokens.css` defines all custom properties.

## Data Model (core tables)

- **users** — one row per Clerk user. Owns: `clerk_user_id` (the Clerk identity reference). No passwords stored here — Clerk handles credentials.
- **groups** — optional folders for organizing monitors. Belongs to a user.
- **monitors** — a URL to watch. Owns: url, name, interval, failure threshold, current failure streak, `last_status` (cached), `next_check_at` (the dispatcher uses this to find due monitors), `is_active`, `is_deleted`.
- **check_logs** — one row per HTTP check result (raw time-series). Owns: status, response_code, response_time_ms, message, checked_at. Subject to tiered retention.
- **check_rollups** — pre-aggregated uptime/latency buckets (hourly, daily) derived from `check_logs`. Powers history graphs and the status page so reads never scan raw `check_logs`. Derived data, not source of truth.

## Auth and Access Model

- Clerk owns the user identity — no passwords or email stored in our database.
- On the frontend, Clerk issues a JWT. Every API request sends it as `Authorization: Bearer <token>`.
- The backend verifies the token using Clerk's SDK and extracts `clerk_user_id`.
- We look up (or create) a matching row in our `users` table by `clerk_user_id`.
- Every monitor belongs to exactly one user via `user_id`.
- Before any read or mutation on a monitor, the backend confirms `monitor.user_id === req.user.id`. Ownership is checked in the service layer, not the route.

## Monitoring Flow

```
Dispatcher (single-leader, runs every minute)
  → SELECT monitors WHERE next_check_at <= NOW() AND is_active = true AND is_deleted = false
  → enqueue one check job per due monitor onto the BullMQ queue
  → advance next_check_at so the same monitor isn't enqueued again next tick

Worker pool (N processes, consume the queue concurrently)
  → for each check job: HTTP GET to url with 5s timeout
  → write result to check_logs   ┐
  → update monitor state          ┘ in one transaction (idempotent on retry)
  → on a status transition (up↔down/recovery): publish a state-change event

Event consumers (subscribe independently)
  → alerts: if failures hit threshold and not already alerted → email + Slack → set is_alerted
  → alerts: if recovered → reset is_alerted → recovery email + Slack
  → status page / rollups react to the same events
```

The dispatcher and worker are separate from the Express API process. The
dispatcher decides *what* to run and never does interval math beyond advancing
`next_check_at`; workers *execute* and own the result write. Job processing is
idempotent so BullMQ's at-least-once retries cannot double-write or double-alert.

**Phasing:** this is the end state. Phase 0 collapses dispatcher + worker into a
single in-process cron; the queue, cache, events, and rollups switch on at their
triggers per `system-design-roadmap.md`.

## Invariants

1. Route handlers contain no business logic — they validate input and delegate to a service.
2. All SQL is parameterized — user input is never interpolated into a query string.
3. Ownership is verified before every read or mutation — a user can never access another user's monitor.
4. The frontend never calls `pg` directly — all data goes through the REST API.
5. No `console.log` in any service or route — use the logger.
6. Job processing is idempotent — re-running a check job (BullMQ retries at-least-once) must not double-write a log or double-fire an alert.
7. Only the dispatcher enqueues check jobs — running multiple API/worker copies must never double-check a monitor.
8. Redis holds no source of truth — it is queue, cache, and event transport only. Postgres is authoritative; caches and rollups are derived and rebuildable.
9. Workers never call notification channels directly — they publish events; consumers react. Adding a channel must not touch the checker.
