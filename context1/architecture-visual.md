# Architecture — Visual Guide

This document explains the uptime monitor's architecture at four levels, from the highest overview down to individual file responsibilities.

---

## Level 1 — System Overview

What the user sees vs what runs behind the scenes.

```
┌─────────────────────────────────────────────────────────────────┐
│                         THE INTERNET                            │
│                                                                 │
│    Monitored Sites                                              │
│    (google.com, aljazeera.net, your-api.com, ...)              │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP GET every N minutes
                             │
┌────────────────────────────┼────────────────────────────────────┐
│                    YOUR SERVER (Node.js)                        │
│                            │                                    │
│   ┌────────────────┐   ┌───┴────────────┐   ┌──────────────┐  │
│   │   Express API  │   │   Scheduler    │   │   Webhook    │  │
│   │   (REST)       │   │   (cron, 1min) │   │   (Clerk)    │  │
│   └───────┬────────┘   └───────┬────────┘   └──────┬───────┘  │
│           │                    │                    │           │
│           └────────────┬───────┘────────────────────┘           │
│                        │                                        │
│                   ┌────┴─────┐                                  │
│                   │  pg Pool │                                  │
│                   └────┬─────┘                                  │
└────────────────────────┼────────────────────────────────────────┘
                         │
                    ┌────┴─────┐
                    │  Neon    │
                    │ Postgres │
                    └──────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    USER'S BROWSER                               │
│                                                                 │
│   ┌──────────────┐    ┌───────────────┐    ┌────────────────┐  │
│   │  React App   │───▶│  Axios calls  │───▶│  Express API   │  │
│   │  (Vite)      │    │  + Clerk JWT  │    │  (port 3000)   │  │
│   └──────────────┘    └───────────────┘    └────────────────┘  │
│                                                                 │
│   ┌──────────────┐                                              │
│   │  Clerk UI    │  (sign-in, sign-up, user menu)              │
│   └──────────────┘                                              │
└─────────────────────────────────────────────────────────────────┘
```

**Three independent processes live in one Node.js server:**
1. **Express API** — handles user requests (create monitor, list monitors)
2. **Scheduler** — background cron job, checks monitors, writes results
3. **Webhook** — receives events from Clerk (user created)

They share the same database connection pool but have zero knowledge of each other.

---

## Level 2 — Request Flow

How a user's action travels through the system.

### Creating a monitor

```
Browser                    Backend                         Database
  │                          │                                │
  │  POST /api/monitors      │                                │
  │  + Bearer token          │                                │
  │ ─────────────────────▶   │                                │
  │                          │                                │
  │                    clerkMiddleware()                       │
  │                    populates req.auth                     │
  │                          │                                │
  │                    requireAuth()                          │
  │                    checks req.auth.userId                 │
  │                    rejects if missing → 401               │
  │                          │                                │
  │                    syncUser()                             │
  │                    SELECT users WHERE clerk_user_id = ?   │
  │                          │ ──────────────────────────▶    │
  │                          │ ◀──────────────────────────    │
  │                    attaches req.user (internal UUID)      │
  │                          │                                │
  │                    Zod validates req.body                 │
  │                    rejects if invalid → 400               │
  │                          │                                │
  │                    monitorsService.createMonitor()        │
  │                    INSERT INTO monitors ... RETURNING     │
  │                          │ ──────────────────────────▶    │
  │                          │ ◀──────────────────────────    │
  │                          │                                │
  │  201 { data: monitor }   │                                │
  │ ◀─────────────────────   │                                │
```

### Scheduler checking a monitor

```
Scheduler (every 60s)         Checks Service              Database
  │                              │                           │
  │  checkAllDueMonitors()       │                           │
  │ ──────────────────────▶      │                           │
  │                              │                           │
  │                        findDueMonitors()                 │
  │                        SELECT ... WHERE                  │
  │                        next_check_at <= NOW()            │
  │                              │ ────────────────────▶     │
  │                              │ ◀────────────────────     │
  │                              │                           │
  │                        For each monitor (50 at a time):  │
  │                              │                           │
  │                        resolveAndValidate(url)           │
  │                        DNS lookup + SSRF check           │
  │                              │                           │
  │                        fetch(url, 5s timeout)            │
  │                              │ ──▶ Internet ──▶ Site     │
  │                              │ ◀── response ◀──          │
  │                              │                           │
  │                        BEGIN TRANSACTION                 │
  │                        INSERT INTO check_logs            │
  │                              │ ────────────────────▶     │
  │                        UPDATE monitors SET               │
  │                          last_status,                    │
  │                          consecutive_failures,           │
  │                          next_check_at,                  │
  │                          is_alerted                      │
  │                              │ ────────────────────▶     │
  │                        COMMIT                            │
  │                              │ ────────────────────▶     │
```

### Auth: first sign-in (user creation)

```
Browser              Clerk               Backend              Database
  │                    │                    │                     │
  │  User signs up     │                    │                     │
  │ ──────────────▶    │                    │                     │
  │                    │                    │                     │
  │  JWT issued        │  webhook:          │                     │
  │ ◀──────────────    │  user.created      │                     │
  │                    │ ──────────────▶    │                     │
  │                    │                    │  verify signature   │
  │                    │                    │  INSERT users       │
  │                    │                    │ ──────────────▶     │
  │                    │                    │ ◀──────────────     │
  │                    │  200 OK            │                     │
  │                    │ ◀──────────────    │                     │
  │                    │                    │                     │
  │  First API call    │                    │                     │
  │  POST /api/monitors│                    │                     │
  │ ───────────────────────────────────▶    │                     │
  │                    │                    │                     │
  │                    │              syncUser():                 │
  │                    │              SELECT users                │
  │                    │              WHERE clerk_user_id = ?     │
  │                    │                    │ ──────────────▶     │
  │                    │              FOUND (webhook created it)  │
  │                    │              attach to req.user          │
  │                    │                    │                     │
  │                    │              ...continues normally...    │
```

---

## Level 3 — Database Schema

How the tables relate to each other.

```
┌──────────────────┐
│      users       │
├──────────────────┤
│ id            PK │──────────────────────────────┐
│ clerk_user_id UQ │                              │
│ email         UQ │                              │
│ created_at       │                              │
└──────────────────┘                              │
                                                  │
       ┌──────────────────────────────────────────┤
       │                                          │
       ▼                                          ▼
┌──────────────────┐                 ┌────────────────────────┐
│     groups       │                 │       monitors         │
├──────────────────┤                 ├────────────────────────┤
│ id            PK │◀─ ─ ─ ─ ─ ─ ─ ─│ id                  PK │
│ user_id       FK │                 │ user_id             FK │
│ name             │                 │ group_id    FK (nullable)│
│ created_at       │                 │ name                    │
├──────────────────┤                 │ url                     │
│ UQ(user_id,name) │                 │ interval_minutes        │
└──────────────────┘                 │ failure_threshold       │
                                     │ consecutive_failures    │
                                     │ is_alerted              │
                                     │ last_status             │
                                     │ last_checked_at         │
                                     │ next_check_at    ◀── scheduler reads this
                                     │ is_active               │
                                     │ is_deleted              │
                                     │ created_at              │
                                     │ updated_at              │
                                     └───────────┬────────────┘
                                                 │
                                                 │ 1:many
                                                 ▼
                                     ┌────────────────────────┐
                                     │     check_logs         │
                                     ├────────────────────────┤
                                     │ id                  PK │
                                     │ monitor_id          FK │
                                     │ status                 │
                                     │ response_code          │
                                     │ response_time_ms       │
                                     │ message                │
                                     │ checked_at             │
                                     ├────────────────────────┤
                                     │ IDX(monitor_id,        │
                                     │     checked_at DESC)   │
                                     └────────────────────────┘
```

**Key relationships:**
- A **user** owns many **monitors** and many **groups**
- A **monitor** belongs to one **user** and optionally one **group**
- A **monitor** has many **check_logs** (one per HTTP check)
- Deleting a **user** cascades to their monitors, which cascades to check_logs
- Deleting a **group** sets `group_id = NULL` on its monitors (doesn't delete them)

**Key fields explained:**
- `next_check_at` — the scheduler queries `WHERE next_check_at <= NOW()`. After each check, it's set to `NOW() + interval_minutes`. This is how scheduling works without a timer per monitor.
- `consecutive_failures` — increments on each failed check, resets to 0 on success. When it reaches `failure_threshold`, `is_alerted` flips to true.
- `is_alerted` — prevents duplicate alerts. Once true, no new alert is sent until the monitor recovers (status returns to 'up'), which resets both fields.
- `is_deleted` — soft delete. The monitor stops being checked but its `check_logs` remain for history.
- `last_status` — cached so the dashboard doesn't need to query `check_logs` for current status.

---

## Level 4 — File Map

Every source file and what it owns.

```
backend/src/
│
├── server.js                  Entry point. Loads env, starts Express, imports scheduler.
├── app.js                     Express app. Middleware chain + route mounting.
│
├── config/
│   └── db.js                  pg Pool, query() helper, withTransaction() for atomic ops.
│
├── middleware/
│   └── auth.js                requireAuth (JWT check) + syncUser (Clerk → internal user).
│
├── routes/
│   ├── monitors.routes.js     POST / GET /api/monitors. Validates with Zod, delegates to service.
│   └── webhooks.js            POST /api/webhooks/clerk. Verifies svix signature, creates user row.
│
├── services/
│   ├── monitors.service.js    createMonitor, getMonitorsByUser. Thin pass-through for now.
│   └── checks.service.js      runCheck (HTTP GET), processCheck (log + update), checkAllDueMonitors.
│
├── db/
│   ├── monitors.queries.js    insertMonitor, findMonitorsByUserId. SAFE_COLUMNS whitelist.
│   ├── checks.queries.js      findDueMonitors, insertCheckLog, updateMonitorAfterCheck.
│   ├── retention.queries.js   deleteExpiredCheckLogs (>30 days).
│   ├── schema.js              Documentation-only reference of all table structures.
│   └── migrations/            node-pg-migrate files. Never edit a run migration.
│
├── schemas/
│   └── monitors.schema.js     Zod schema for create monitor input. URL validated against SSRF.
│
├── scheduler/
│   └── index.js               Two cron jobs: checks every minute, retention daily at 3 AM.
│
└── utils/
    └── url-safety.js          SSRF protection. validateUrlHostname (input), resolveAndValidate (fetch).


frontend/src/
│
├── main.jsx                   Entry. ClerkProvider + QueryClientProvider + BrowserRouter + Toaster.
├── App.jsx                    Routes: /sign-in, /sign-up, /dashboard, catch-all.
│
├── lib/
│   ├── axios.js               Configured axios instance with baseURL.
│   ├── endpoints.js           Centralized API route strings. Single source of truth.
│   └── utils.ts               cn() helper for merging Tailwind classes (shadcn).
│
├── hooks/
│   ├── useMonitors.js         useGetMonitors (useQuery), useCreateMonitor (useMutation + toast).
│   └── useCreateMonitor.js    Form state: open/close, field values, validation, getSubmitData.
│
├── pages/
│   ├── DashboardPage.jsx      Monitor list or empty state + create dialog wiring.
│   ├── SignInPage.jsx          Two-panel layout: brand left, Clerk form right.
│   └── SignUpPage.jsx          Same layout, different copy.
│
├── components/
│   ├── ProtectedRoute.jsx     Redirects to /sign-in if not authenticated.
│   ├── layout/
│   │   ├── AppShell.jsx       Grid: sidebar (240px) + main area.
│   │   ├── Sidebar.jsx        NavLink-based nav with active state.
│   │   └── TopBar.jsx         Title + Clerk UserButton.
│   ├── monitors/
│   │   ├── MonitorCard.jsx    Status-colored card with name, URL, last checked.
│   │   ├── MonitorList.jsx    Maps monitors to cards.
│   │   ├── StatusBadge.jsx    UP/DOWN/TIMEOUT/PAUSED badge with color variants.
│   │   ├── EmptyState.jsx     Centered CTA when no monitors exist.
│   │   └── CreateMonitorDialog.jsx  shadcn Dialog with form inputs.
│   └── ui/                    shadcn components (Button, Card, Dialog, Input, Select, Badge, Table).
│
└── styles/
    ├── global.css             Tailwind import, @theme tokens, base dark styles.
    └── tokens.css             Original CSS custom properties (kept for reference).
```

---

## How the middleware chain works

Every API request passes through this pipeline in order. Each layer can reject the request — if it does, nothing below it runs.

```
Request arrives
    │
    ▼
┌─────────┐
│ helmet() │  Sets security headers (X-Frame-Options, CSP, etc.)
└────┬────┘
     ▼
┌─────────┐
│  cors()  │  Allows cross-origin requests from the frontend
└────┬────┘
     ▼
┌─────────────────┐
│ clerkMiddleware()│  Reads JWT, populates req.auth (but doesn't reject)
└────┬────────────┘
     ▼
┌──────────────┐
│ express.json()│  Parses JSON body (skipped for webhook — needs raw body)
└────┬─────────┘
     ▼
     ├── /api/health ──────────▶ { status: 'ok' }     (public, no auth)
     │
     ├── /api/webhooks/clerk ──▶ svix verify → insert  (public, signature-verified)
     │
     └── /api/monitors ──▶ requireAuth() ──▶ syncUser() ──▶ router
                               │                 │
                          401 if no JWT    500 if DB fails
                                                 │
                                           req.user is set
                                           (internal UUID)
                                                 │
                                           Zod validates body
                                                 │
                                           service function
                                                 │
                                           DB query
                                                 │
                                           response
```

---

## What's built vs what's left

```
DONE                              NOT YET
────                              ───────
[x] Database schema               [ ] Monitor detail page (click → history)
[x] Clerk auth (sign-in/up)       [ ] Delete/pause monitor
[x] User sync (webhook+fallback)  [ ] Email alerts (nodemailer)
[x] Create monitor API + UI       [ ] Recovery email
[x] List monitors API + UI        [ ] Groups (organize monitors)
[x] Dashboard with status cards   [ ] Monitor editing
[x] Scheduler (cron, 1min)        [ ] Response time charts
[x] Check execution + logging     [ ] Pagination for monitors/logs
[x] Failure tracking + alerting   [ ] Error-handling middleware
    flag (is_alerted)             [ ] Logger (replace console.error)
[x] SSRF protection
[x] Retention (30-day cleanup)
[x] Concurrency limit (p-limit)
```
