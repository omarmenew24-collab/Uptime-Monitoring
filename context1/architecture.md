# Architecture Context

## Stack

| Layer      | Technology              | Role                                              |
| ---------- | ----------------------- | ------------------------------------------------- |
| Backend    | Node.js + Express       | REST API, monitor scheduling, check execution     |
| Database   | PostgreSQL (Neon)       | All persistent data — monitors, checks, groups    |
| Auth       | Clerk                   | User identity, session management, route protection |
| Frontend   | React (plain, no Next)  | Dashboard UI, served separately                   |
| Validation | Zod                     | Request input validation at route boundaries      |
| Styling    | Plain CSS + tokens      | Custom properties design system, no framework     |
| Icons      | Lucide React            | Stroke-based icon set                             |

## System Boundaries

- `backend/routes/` — Express route definitions only. Parses and validates input, calls a service, returns a response. No logic lives here.
- `backend/services/` — All business logic. One file per domain: `monitors.service.js`, `checks.service.js`, `alerts.service.js`. This is where decisions get made.
- `backend/db/` — All database access. Raw `pg` queries, parameterized. No query construction outside this folder. Migrations live here too.
- `backend/schemas/` — Zod validation schemas. One file per domain. Imported by routes before any handler runs.
- `frontend/src/components/` — Reusable UI pieces. No data fetching inside components.
- `frontend/src/pages/` — Top-level route views. Compose components, own page-level state.
- `frontend/src/hooks/` — All data fetching and stateful logic. Components call hooks, not the API directly.
- `frontend/src/styles/` — Global CSS tokens and base styles. `tokens.css` defines all custom properties.

## Data Model (core tables)

- **users** — one row per Clerk user. Owns: `clerk_user_id` (the Clerk identity reference). No passwords stored here — Clerk handles credentials.
- **groups** — optional folders for organizing monitors. Belongs to a user.
- **monitors** — a URL to watch. Owns: url, name, interval, failure threshold, current failure streak, `last_status` (cached), `next_check_at` (scheduler uses this), `is_active`, `is_deleted`.
- **check_logs** — one row per HTTP check result. Owns: status, response_code, response_time_ms, message, checked_at.

## Auth and Access Model

- Clerk owns the user identity — no passwords or email stored in our database.
- On the frontend, Clerk issues a JWT. Every API request sends it as `Authorization: Bearer <token>`.
- The backend verifies the token using Clerk's SDK and extracts `clerk_user_id`.
- We look up (or create) a matching row in our `users` table by `clerk_user_id`.
- Every monitor belongs to exactly one user via `user_id`.
- Before any read or mutation on a monitor, the backend confirms `monitor.user_id === req.user.id`. Ownership is checked in the service layer, not the route.

## Monitoring Flow

```
Scheduler (runs every minute)
  → SELECT monitors WHERE next_check_at <= NOW() AND is_active = true AND is_deleted = false
  → for each monitor: HTTP GET to url with 5s timeout
  → write result to check_logs
  → update monitor: last_status, consecutive_failures, next_check_at, is_alerted
  → if failures hit threshold and not already alerted → send email → set is_alerted = true
  → if recovered → reset consecutive_failures, is_alerted → send recovery email
```

The scheduler runs inside the Express process for now. `next_check_at` is set to `NOW() + interval_minutes` after each check — the scheduler never does interval math, it just queries due monitors.

## Invariants

1. Route handlers contain no business logic — they validate input and delegate to a service.
2. All SQL is parameterized — user input is never interpolated into a query string.
3. Ownership is verified before every read or mutation — a user can never access another user's monitor.
4. The frontend never calls `pg` directly — all data goes through the REST API.
5. No `console.log` in any service or route — use the logger.
