# 18 — Public Status Page

## What this covers

A public, unauthenticated page at `/status/:userId` that shows all of a user's
active monitors and their current status. No login required — this is what users
share with their customers ("here's our status page").

This is the read path that Phase 2 (cache) was designed for: high read volume,
no auth, data that changes only when a check completes. The status page reads
from Redis cache with Postgres fallback.

---

## Existing state

- `monitors.queries.js` — `findMonitorsByUserId(userId)` returns active monitors
  but is behind `requireAuth + syncUser`. The status page needs a similar query
  without auth.
- `cache/monitorCache.js` — caches per-user monitor lists with 60s TTL. The
  status page can use a separate cache key with a longer TTL (public data
  doesn't need to be as fresh as the authenticated dashboard).
- `rollups.queries.js` — `getUptimePercentage(monitorId, days)` exists.
- `users` table has `id` (UUID). The status page URL will use this UUID directly
  (`/status/:userId`). A vanity slug (e.g., `/status/acme`) would require a new
  column — deferred, not needed for the feature to work.
- Frontend `App.jsx` has routes inside `ClerkProvider`. The status page must
  render **outside** `ProtectedRoute` (no auth required).

---

## Backend

### `db/monitors.queries.js` — add `findPublicMonitorsByUserId`

```sql
SELECT id, name, url, last_status, last_checked_at, is_active, interval_minutes
FROM monitors
WHERE user_id = $1
  AND is_active = true
  AND is_deleted = false
ORDER BY name ASC
```

Similar to `findMonitorsByUserId` but:
- Only returns active monitors (paused/deleted are not shown publicly)
- Returns fewer columns (no `failure_threshold`, `next_check_at`, etc.)
- Ordered by name (alphabetical, not creation date — more natural for a public
  page)

### `services/status.service.js` — status page service

**`getPublicStatus(userId)`**

1. Check cache: `status:user:{userId}` (separate key from the authenticated
   list, longer TTL of 120 seconds)
2. On miss: query `findPublicMonitorsByUserId(userId)`, compute uptime % per
   monitor from rollups, build the response, cache it
3. Return `null` if the user doesn't exist (no monitors found)

Response shape:
```json
{
  "monitors": [
    {
      "name": "API",
      "url": "https://api.example.com",
      "status": "up",
      "lastCheckedAt": "2026-06-25T12:00:00Z",
      "uptimePercent": "99.87"
    }
  ],
  "overallStatus": "operational"
}
```

`overallStatus`:
- `"operational"` — all monitors up
- `"degraded"` — some monitors down/timeout
- `"major_outage"` — all monitors down

### `routes/status.routes.js` — public endpoint

**`GET /api/status/:userId`** — no auth middleware. Returns the public status.
404 if user has no monitors.

### `cache/monitorCache.js` — add status page cache helpers

```js
statusPage: (userId) => `status:user:${userId}`
```

TTL 120 seconds (longer than dashboard — public page doesn't need 60s freshness).
Invalidated when any of the user's monitors gets a new check (already handled
by `invalidateMonitorCache` — add the status key to the invalidation).

### `app.js` — mount status route without auth

```js
app.use('/api/status', statusRouter);  // before requireAuth routes
```

---

## Frontend

### `pages/StatusPage.jsx` — public status page

Uses `useParams()` to get the user ID. Fetches `GET /api/status/:userId`
(no auth token needed). Renders:

```
┌─────────────────────────────────────────────────┐
│  System Status                    ● Operational  │
├─────────────────────────────────────────────────┤
│                                                   │
│  ● API                    UP      99.87%         │
│    https://api.example.com    Last: 2m ago       │
│                                                   │
│  ● Marketing Site         UP      99.95%         │
│    https://example.com        Last: 3m ago       │
│                                                   │
└─────────────────────────────────────────────────┘
```

- No sidebar, no topbar — standalone page with minimal layout
- Dark background matching the app's design tokens
- Each monitor shows: name, status dot, status badge, uptime %, URL, last checked
- Overall status banner at the top (Operational / Degraded / Major Outage)
- Auto-refreshes every 30 seconds (`refetchInterval: 30_000`)

### `hooks/usePublicStatus.js` — fetch status without auth

```js
const fetchStatus = async () => {
  const res = await api.get(ENDPOINTS.PUBLIC_STATUS(userId));
  return res.data;
};
// No getToken() — this endpoint has no auth
```

### `lib/endpoints.js` — add status endpoint

```js
PUBLIC_STATUS: (userId) => `/api/status/${userId}`,
```

### `App.jsx` — add public route (no ProtectedRoute wrapper)

```jsx
<Route path="/status/:userId" element={<StatusPage />} />
```

No `ProtectedRoute`, no `AppShell` — the status page has its own minimal layout.

---

## Acceptance criteria

1. `GET /api/status/:userId` returns monitors with status + uptime % — no auth
   required
2. Page renders at `/status/:userId` without login
3. No sidebar or topbar — standalone minimal page
4. Shows overall status (Operational / Degraded / Major Outage)
5. Each monitor shows name, URL, status, uptime %, last checked
6. Paused and deleted monitors are not shown
7. Response is cached in Redis (120s TTL), served from cache on repeat requests
8. Cache is invalidated when a check completes for any of the user's monitors
9. 404 if user has no monitors
10. Auto-refreshes every 30 seconds
