# 21 — Manual Check ("Check Now")

## What this covers

Users can manually trigger an immediate check of a monitor without waiting for the next scheduled check. This is a common feature in uptime monitors (Uptime Robot, Pingdom, etc.).

---

## User Flow

1. User views a monitor detail page
2. Clicks "Check Now" button (near the current status)
3. Button shows "Checking..." state
4. Worker immediately picks up the job
5. Check executes and result appears
6. Button returns to normal, latest check in history updates

---

## Backend Implementation

### New Route

**POST `/api/monitors/:id/check-now`**

Request:
```json
{}
```

Response (200):
```json
{
  "data": {
    "id": "check-uuid",
    "status": "up|down|timeout",
    "response_code": 200,
    "response_time_ms": 123,
    "checked_at": "2026-06-27T18:30:45Z"
  }
}
```

### How it Works

1. Route validates user owns the monitor
2. Creates a check job with `jobId: "${monitorId}:manual:${now}"` (unique per monitor per second)
3. Enqueues to BullMQ with `priority: 100` (high priority, runs immediately)
4. **Waits for the result** — holds the response until worker completes (max 10s timeout)
5. Returns the check result to frontend
6. Frontend auto-refreshes monitor detail to show in history

### Key Details

- **Ownership check** — only monitor owner can trigger
- **Idempotency** — same user clicking twice in same second = same job (no double-check)
- **Timeout** — if check takes >10s, return pending status, frontend refreshes
- **Rate limit** — max 5 checks per monitor per minute per user (prevent spam)
- **Priority** — high priority in queue so it runs before scheduled checks

---

## Frontend Implementation

### New Component

**`CheckNowButton.jsx`**

- Button in monitor header next to status badge
- Shows icon + text: "⟳ Check Now"
- On click: disable, show "Checking..." state
- On success: hide, auto-refresh monitor detail (triggers refetch of checks)
- On error: show toast, restore button

### Integration

Add to `MonitorHeader.jsx`:
```jsx
<CheckNowButton monitorId={id} onSuccess={() => refetchMonitor()} />
```

---

## Database

No schema changes. Uses existing `check_logs` table.

---

## Acceptance Criteria

1. User can click "Check Now" on any monitor they own
2. Button shows loading state while checking
3. Result appears in check history within 10 seconds
4. Clicking twice fast doesn't create duplicate checks
5. Monitor detail auto-refreshes to show new check
6. Users can't spam more than 5 checks/minute per monitor
7. Non-owners get 403 Forbidden

---

## Edge Cases

- **Network slow:** frontend timeout at 10s, shows "Checking..." spinner, user can refresh manually
- **Site is down:** check completes, shows down status, doesn't affect schedule
- **Worker busy:** job waits in queue, returns result when done (within 10s timeout)
- **Multiple monitors:** each has independent rate limit (5 checks/min each)

---

## Files to Create/Modify

**Backend:**
- `backend/src/routes/monitors.routes.js` — add POST /:id/check-now route
- `backend/src/services/monitors.service.js` — add checkNow() service
- `backend/src/services/checks.service.js` — add executeCheckNow() to wait for result
- `backend/src/middleware/rateLimiter.js` — add per-route limiter for check-now

**Frontend:**
- `frontend/src/components/monitors/CheckNowButton.jsx` — new component
- `frontend/src/components/monitors/MonitorHeader.jsx` — integrate button
- `frontend/src/hooks/useCheckNow.js` — new hook

No database migrations needed.
