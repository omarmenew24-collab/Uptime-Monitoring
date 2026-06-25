# 15 — Pause / Resume / Delete Monitor

## What this covers

Users can create monitors but cannot pause, resume, or delete them. This spec
adds three actions:

- **Pause** — sets `is_active = false`. The dispatcher skips paused monitors
  (already filtered in `claimDueMonitors` WHERE clause). No checks run, but
  history is preserved.
- **Resume** — sets `is_active = true` and `next_check_at = NOW()` so the
  monitor is picked up on the next dispatcher tick.
- **Delete** — sets `is_deleted = true` (soft delete). Monitor disappears from
  the dashboard and is never checked again, but history remains in the database.
  Already filtered by `findMonitorsByUserId` and `claimDueMonitors`.

No migration needed — `is_active` and `is_deleted` columns already exist.

---

## Existing state

- `monitors` table has `is_active` (default true) and `is_deleted` (default false)
- `claimDueMonitors` already filters `is_active = true AND is_deleted = false`
- `findMonitorsByUserId` already filters `is_deleted = false`
- Dashboard shows `is_active` status via `StatusBadge` (paused variant exists)
- Monitor detail page has `MonitorHeader` with space for action buttons (none wired)

---

## Backend

### `db/monitors.queries.js` — add three queries

**`pauseMonitor(monitorId, userId)`**
```sql
UPDATE monitors SET is_active = false, updated_at = NOW()
WHERE id = $1 AND user_id = $2 AND is_deleted = false
RETURNING id, is_active
```

**`resumeMonitor(monitorId, userId)`**
```sql
UPDATE monitors SET is_active = true, next_check_at = NOW(), updated_at = NOW()
WHERE id = $1 AND user_id = $2 AND is_deleted = false
RETURNING id, is_active
```

**`softDeleteMonitor(monitorId, userId)`**
```sql
UPDATE monitors SET is_deleted = true, is_active = false, updated_at = NOW()
WHERE id = $1 AND user_id = $2 AND is_deleted = false
RETURNING id
```

All three verify ownership via `user_id = $2`. Return null if monitor not found
or not owned.

### `services/monitors.service.js` — add service functions

Each calls the query and invalidates the cache (both user list and monitor
detail).

### `routes/monitors.routes.js` — add three endpoints

- `PATCH /:id/pause` — calls `pauseMonitor`, returns 200
- `PATCH /:id/resume` — calls `resumeMonitor`, returns 200
- `DELETE /:id` — calls `softDeleteMonitor`, returns 204

All return 404 if monitor not found/not owned.

---

## Frontend

### `hooks/useMonitors.js` — add mutation hooks

**`usePauseMonitor()`** — `PATCH /api/monitors/:id/pause`, invalidates
`['monitors']` and `['monitor', id]` on success.

**`useResumeMonitor()`** — `PATCH /api/monitors/:id/resume`, same invalidation.

**`useDeleteMonitor()`** — `DELETE /api/monitors/:id`, invalidates `['monitors']`,
navigates to `/dashboard` on success.

### `components/monitors/MonitorHeader.jsx` — add action buttons

Two buttons in the top-right of the header:

- **Pause/Resume toggle** — shows `Pause` icon when active, `Play` icon when
  paused. Ghost style button.
- **Delete** — `Trash2` icon, ghost style, red on hover. Shows a confirmation
  before executing (window.confirm is fine — no need for a modal).

### `lib/endpoints.js` — add action endpoints

```js
MONITOR_PAUSE: (id) => `/api/monitors/${id}/pause`,
MONITOR_RESUME: (id) => `/api/monitors/${id}/resume`,
MONITOR_DELETE: (id) => `/api/monitors/${id}`,
```

---

## Acceptance criteria

1. Pausing a monitor sets `is_active = false` — it stops being checked
2. Resuming sets `is_active = true` and `next_check_at = NOW()` — checked on next tick
3. Deleting sets `is_deleted = true` — disappears from dashboard, never checked
4. All three verify ownership — 404 for wrong user
5. Dashboard updates immediately after pause/resume/delete (cache invalidated)
6. Detail page shows Pause/Resume toggle and Delete button
7. Delete asks for confirmation before executing
8. Paused monitors show gray "PAUSED" badge on dashboard (already works)
