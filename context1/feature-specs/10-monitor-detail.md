# 10 — Monitor Detail Page + Check History

## What this covers

When a user clicks a monitor card on the dashboard, they land on a detail page
showing that monitor's current status, configuration, summary stats, and its
full check history (newest first, paginated). This is the first place a user can
answer "what happened to my site last night?"

This spec covers:
- Backend: two new endpoints (`GET /api/monitors/:id` and `GET /api/monitors/:id/checks`)
- Frontend: detail page with header, stats row, and check history table
- Wiring: route, hooks, navigation from the dashboard card

This spec does NOT cover pause/delete actions, uptime graphs, or rollups. The
stats (avg response time, total checks) are computed from raw `check_logs` via
SQL aggregates. Phase 4 (rollups) replaces these with pre-computed values —
building the simple version first gives us the "before" for the Phase 4
learning entry.

---

## Existing state this spec builds on

**Backend has:**
- `monitors` table with: `id`, `user_id`, `name`, `url`, `interval_minutes`,
  `failure_threshold`, `consecutive_failures`, `is_alerted`, `last_status`,
  `last_checked_at`, `next_check_at`, `is_active`, `is_deleted`, `created_at`,
  `updated_at`
- `check_logs` table with: `id`, `monitor_id`, `status`, `response_code`,
  `response_time_ms`, `message`, `checked_at`, `job_id`
- Index: `check_logs_monitor_id_checked_at_idx` on `(monitor_id, checked_at)`
- `monitors.queries.js` with `SAFE_COLUMNS`, `insertMonitor`, `findMonitorsByUserId`
- `monitors.service.js` with `createMonitor`, `getMonitorsByUser`
- `monitors.routes.js` with `POST /` and `GET /`
- All routes behind `requireAuth` + `syncUser` (ownership = `req.user.id`)

**Frontend has:**
- `App.jsx` with routes: `/sign-in`, `/sign-up`, `/dashboard`
- `DashboardPage` → `MonitorList` → `MonitorCard` (no click handler yet)
- `useMonitors.js` with `useGetMonitors` and `useCreateMonitor`
- `endpoints.js` with `MONITORS: '/api/monitors'`
- Tailwind + Lucide icons available

**Code standards that apply:**
- Business logic in services, not routes
- Ownership checked in the service layer
- All SQL through `db/` module, parameterized
- `{ data: ... }` on success, `{ error: "..." }` on failure
- One hook per data-fetching concern
- Components render, they don't fetch

---

## Backend

### 1. `db/monitors.queries.js` — add `findMonitorByIdAndUser`

```js
export const findMonitorByIdAndUser = async (monitorId, userId) => {
  const result = await query(
    `SELECT ${SAFE_COLUMNS}, consecutive_failures, is_alerted
     FROM monitors
     WHERE id = $1 AND user_id = $2 AND is_deleted = false`,
    [monitorId, userId]
  );
  return result.rows[0] ?? null;
};
```

Returns the monitor only if the requesting user owns it. Returns `null` if not
found or not owned — the service returns 404 in both cases (never reveal whether
a monitor exists for another user).

### 2. `db/checks.queries.js` — add `findChecksByMonitor` and `getCheckStats`

**`findChecksByMonitor(monitorId, limit, offset)`**

```sql
SELECT id, status, response_code, response_time_ms, message, checked_at
FROM check_logs
WHERE monitor_id = $1
ORDER BY checked_at DESC
LIMIT $2 OFFSET $3
```

Returns paginated check history, newest first. Uses the existing
`check_logs_monitor_id_checked_at_idx` index, so the query is fast even with
many rows. `job_id` is excluded — it's an internal idempotency key, not
user-facing.

**`getCheckStats(monitorId)`**

```sql
SELECT
  COUNT(*)::int AS total_checks,
  ROUND(AVG(response_time_ms))::int AS avg_response_ms,
  COUNT(*) FILTER (WHERE status = 'up')::int AS up_count,
  COUNT(*) FILTER (WHERE status = 'down')::int AS down_count,
  COUNT(*) FILTER (WHERE status = 'timeout')::int AS timeout_count
FROM check_logs
WHERE monitor_id = $1
```

One query for all summary stats. `FILTER (WHERE ...)` is a Postgres feature that
counts conditionally without a `CASE`. `ROUND` and `::int` keep the response
clean (no decimals, no strings).

This aggregate scans raw `check_logs` — Phase 4 replaces it with pre-computed
rollups. Building the raw version first is the "before" for that learning entry.

### 3. `services/monitors.service.js` — add `getMonitorDetail` and `getMonitorChecks`

**`getMonitorDetail(monitorId, userId)`**

```js
export const getMonitorDetail = async (monitorId, userId) => {
  const monitor = await findMonitorByIdAndUser(monitorId, userId);
  if (!monitor) return null;

  const stats = await getCheckStats(monitorId);

  return { ...monitor, stats };
};
```

Returns the monitor + its summary stats in one call. Returns `null` if not found
or not owned.

**`getMonitorChecks(monitorId, userId, limit, offset)`**

```js
export const getMonitorChecks = async (monitorId, userId, limit, offset) => {
  const monitor = await findMonitorByIdAndUser(monitorId, userId);
  if (!monitor) return null;

  const checks = await findChecksByMonitor(monitorId, limit, offset);

  return checks;
};
```

Ownership is verified before returning any check data. Returns `null` if
the monitor doesn't exist or isn't owned by this user.

### 4. `routes/monitors.routes.js` — add two endpoints

**`GET /:id`** — monitor detail + stats

```js
router.get('/:id', async (req, res) => {
  try {
    const monitor = await monitorsService.getMonitorDetail(req.params.id, req.user.id);
    if (!monitor) {
      return res.status(404).json({ error: 'Monitor not found' });
    }
    return res.status(200).json({ data: monitor });
  } catch (err) {
    console.error('Get monitor detail error:', err);
    return res.status(500).json({ error: 'Failed to fetch monitor' });
  }
});
```

**`GET /:id/checks`** — paginated check history

```js
router.get('/:id/checks', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const checks = await monitorsService.getMonitorChecks(req.params.id, req.user.id, limit, offset);
    if (!checks) {
      return res.status(404).json({ error: 'Monitor not found' });
    }
    return res.status(200).json({ data: checks });
  } catch (err) {
    console.error('Get check logs error:', err);
    return res.status(500).json({ error: 'Failed to fetch check history' });
  }
});
```

`limit` is capped at 100 to prevent abuse. `offset` defaults to 0. Both are
parsed and clamped in the route — no validation schema needed for simple
query-string integers.

**Route ordering matters:** `GET /:id` must be registered **after** `GET /` in
the router, so `GET /` doesn't try to match `id = undefined`. The existing order
(`POST /`, `GET /`) already puts the collection routes first, so appending
`GET /:id` and `GET /:id/checks` at the end is correct.

---

## Frontend

### 1. `lib/endpoints.js` — add detail endpoints

```js
export const ENDPOINTS = {
  MONITORS: '/api/monitors',
  MONITOR_DETAIL: (id) => `/api/monitors/${id}`,
  MONITOR_CHECKS: (id) => `/api/monitors/${id}/checks`,
};
```

### 2. `hooks/useMonitorDetail.js` — fetch monitor + stats

```js
export const useMonitorDetail = (monitorId) => {
  // Fetch ENDPOINTS.MONITOR_DETAIL(monitorId)
  // queryKey: ['monitor', monitorId]
  // refetchInterval: 10_000 (same as dashboard)
  // Returns: { monitor, isLoading, isError }
};
```

### 3. `hooks/useCheckLogs.js` — fetch paginated checks

```js
export const useCheckLogs = (monitorId, page) => {
  // Fetch ENDPOINTS.MONITOR_CHECKS(monitorId) with ?limit=20&offset=page*20
  // queryKey: ['checks', monitorId, page]
  // refetchInterval: 10_000
  // Returns: { checks, isLoading, isError }
};
```

### 4. `pages/MonitorDetailPage.jsx` — the detail page

Uses `useParams()` to get the monitor ID from the URL. Composes three sections:

**Section 1 — Monitor header:**
- Status badge (reuse `StatusBadge`)
- Monitor name (large, `text-xl`, `font-semibold`)
- URL in monospace, clickable (opens in new tab)
- Meta row: interval, failure threshold, created date — separated by `·`
- Back link to dashboard (`ArrowLeft` icon)

**Section 2 — Stats row:**
Three stat cards in a horizontal row:

| Current Status | Avg Response | Total Checks |
|---|---|---|
| UP (green) | 245ms | 1,247 |

Each card: dark surface background, label in muted uppercase, value in large
monospace. Status value uses the status color.

**Section 3 — Check history table:**

| Status | Code | Response Time | Checked At |
|---|---|---|---|
| UP | 200 | 234ms | 2 minutes ago |
| TIMEOUT | — | — | 7 minutes ago |
| DOWN | 502 | 5012ms | 12 minutes ago |

- Newest first
- 20 rows per page
- "Load more" button at the bottom (appends next page, not a full page
  navigation — simpler UX)
- Status column reuses `StatusBadge`
- Response code and time in monospace; show `—` for null values
- `checked_at` displayed as relative time ("2 minutes ago")
- Rows have subtle hover effect

### 5. `App.jsx` — add the route

```jsx
<Route
  path="/monitors/:id"
  element={
    <ProtectedRoute>
      <AppShell>
        <MonitorDetailPage />
      </AppShell>
    </ProtectedRoute>
  }
/>
```

### 6. `MonitorCard.jsx` — make cards clickable

Wrap the card in a `Link` (from `react-router-dom`) or use `useNavigate` on
click. Navigate to `/monitors/${monitor.id}`.

---

## File structure

```
backend/src/
  db/monitors.queries.js          ← add findMonitorByIdAndUser
  db/checks.queries.js            ← add findChecksByMonitor, getCheckStats
  services/monitors.service.js    ← add getMonitorDetail, getMonitorChecks
  routes/monitors.routes.js       ← add GET /:id, GET /:id/checks

frontend/src/
  lib/endpoints.js                ← add MONITOR_DETAIL, MONITOR_CHECKS
  hooks/useMonitorDetail.js       ← new
  hooks/useCheckLogs.js           ← new
  pages/MonitorDetailPage.jsx     ← new
  components/monitors/
    MonitorHeader.jsx             ← new
    StatsRow.jsx                  ← new
    CheckHistory.jsx              ← new
  App.jsx                         ← add route
  components/monitors/MonitorCard.jsx  ← add click navigation
```

---

## What this spec does NOT cover

- Pause/resume and soft-delete actions (separate spec)
- Uptime percentage or response-time graphs (Phase 4 — rollups)
- Public status page (Phase 2 — cache)
- Real-time updates via WebSocket (polling is sufficient)

---

## Acceptance criteria

1. Clicking a monitor card on the dashboard navigates to `/monitors/:id`
2. The detail page shows the monitor's name, URL, status badge, interval,
   failure threshold, and created date
3. The stats row shows current status, average response time, and total checks
4. The check history table shows the 20 most recent checks, newest first
5. "Load more" loads the next 20 checks and appends them below
6. A user cannot view another user's monitor — returns 404
7. A deleted monitor returns 404
8. The back link returns to the dashboard
9. The page auto-refreshes every 10 seconds (new checks appear without reload)
10. All status colors match the design tokens
11. Null response codes and times display as `—`, not "null"
