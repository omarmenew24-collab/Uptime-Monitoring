## What this covers

The full create-monitor flow from button click to database row. One API endpoint, one frontend dialog, one hook. Nothing else.

After this spec is implemented, a signed-in user can click "Add Monitor", fill in a form, and a new row appears in the `monitors` table with `next_check_at` set so the scheduler will pick it up.

---

## Existing state this spec builds on

**Backend already has:**
- Express v5 app at `backend/src/app.js`
- `clerkMiddleware()` applied globally — populates `req.auth` on every request
- `requireAuth` middleware — rejects with 401 if no valid JWT
- `syncUser` middleware — finds or creates a `users` row, attaches it to `req.user`
- `pg` pool at `backend/src/config/db.js` with a `query(text, params)` helper
- Zod installed (`zod` v4)
- Server running on `PORT=3000`

**Frontend already has:**
- React + Vite + Tailwind v4 + shadcn/ui
- Clerk auth with `ClerkProvider` wrapping the app
- `DashboardPage` with "Add Monitor" button and `EmptyState` component
- shadcn components: `Dialog`, `Input`, `Select`, `Button`, `Badge`

**Database schema (monitors table):**
- `id` — uuid, PK, auto-generated
- `user_id` — uuid, NOT NULL, FK → users.id — set from `req.user.id`, never from request body
- `group_id` — uuid, nullable, FK → groups.id — not used in this spec (groups feature is later)
- `name` — varchar, NOT NULL
- `url` — varchar, NOT NULL
- `interval_minutes` — integer, NOT NULL, default 5
- `failure_threshold` — integer, NOT NULL, default 2
- `consecutive_failures` — integer, NOT NULL, default 0
- `is_alerted` — boolean, NOT NULL, default false
- `last_status` — varchar, nullable, CHECK IN ('up', 'down', 'timeout') — null until first check
- `last_checked_at` — timestamptz, nullable — null until first check
- `next_check_at` — timestamptz, nullable — set to NOW() on creation so the scheduler picks it up
- `is_active` — boolean, NOT NULL, default true
- `is_deleted` — boolean, NOT NULL, default false
- `created_at` — timestamptz, NOT NULL, default now()
- `updated_at` — timestamptz, NOT NULL, default now()

---

## Dependencies to install

**Frontend:**
```
cd frontend && npm install axios
```

Remove the old `src/lib/api.js` fetch helper after the axios client replaces it.

---

## Backend

### 1. Zod schema — `backend/src/schemas/monitors.schema.js`

```js
import { z } from 'zod';
```

Use `zod` (v3-compatible API), not `zod/v4`. The v3 API is stable and what most Express projects use.

`createMonitorSchema`:
- `name` — string, trimmed, min 1 char, max 100 chars
- `url` — string, trimmed, must match a regex: starts with `http://` or `https://`, has at least one dot after the protocol. This catches `https://` alone (invalid) and `https://example` (no TLD). Do not use `z.url()` — it's too permissive for monitoring (allows `ftp://`, `data:`, etc.)
- `interval_minutes` — number, must be one of `[1, 5, 10, 30, 60]`. Default `5`
- `failure_threshold` — number, must be one of `[1, 2, 3, 5]`. Default `2`

Do not accept `group_id`, `user_id`, or any other field. The user controls only the four fields above.

### 2. DB query — `backend/src/db/monitors.queries.js`

`insertMonitor(userId, data)`:
```sql
INSERT INTO monitors (user_id, name, url, interval_minutes, failure_threshold, next_check_at)
VALUES ($1, $2, $3, $4, $5, NOW())
RETURNING id, name, url, interval_minutes, failure_threshold, is_active,
          last_status, last_checked_at, next_check_at, created_at
```

Only return the columns the frontend needs. Never return `user_id`, `is_deleted`, `is_alerted`, `consecutive_failures` to the client.

`findMonitorsByUserId(userId)`:
```sql
SELECT id, name, url, interval_minutes, failure_threshold, is_active,
       last_status, last_checked_at, next_check_at, created_at
FROM monitors
WHERE user_id = $1 AND is_deleted = false
ORDER BY created_at DESC
```

Same column selection — no internal fields exposed.

### 3. Service — `backend/src/services/monitors.service.js`

Thin pass-through for now. Two functions:
- `createMonitor(userId, data)` → calls `insertMonitor`
- `getMonitorsByUser(userId)` → calls `findMonitorsByUserId`

No extra logic yet. The service layer exists so future business logic (duplicate URL checks, plan limits) has a home without touching routes or queries.

### 4. Route — `backend/src/routes/monitors.routes.js`

```
POST /
```

Steps:
1. Parse `req.body` with `createMonitorSchema.safeParse()`
2. If validation fails → `400 { error: 'Invalid input', details: parsed.error.issues }`
3. Call `monitorsService.createMonitor(req.user.id, parsed.data)`
4. Return `201 { data: monitor }`
5. If the DB call throws → `500 { error: 'Failed to create monitor' }`

```
GET /
```

Steps:
1. Call `monitorsService.getMonitorsByUser(req.user.id)`
2. Return `200 { data: monitors }`
3. If the DB call throws → `500 { error: 'Failed to fetch monitors' }`

### 5. Mount — `backend/src/app.js`

The route is already mounted. Verify this line exists:
```js
app.use('/api/monitors', requireAuth, syncUser, monitorsRouter);
```

No changes needed to app.js if this line is present.

---

## Frontend

### 1. Axios client — `frontend/src/lib/axios.js`

Create a configured axios instance. Do not create interceptors for auth — Clerk's `getToken()` is async and comes from a React hook, so it must be passed per-request.

```js
import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3000',
  headers: { 'Content-Type': 'application/json' },
});

export default api;
```

### 2. Hook — `frontend/src/hooks/useApi.js`

A thin hook that returns a request function pre-configured with the Clerk token. Every hook that makes API calls uses this instead of importing axios directly.

```js
import { useAuth } from '@clerk/clerk-react';
import { useCallback } from 'react';
import api from '@/lib/axios';

export default function useApi() {
  const { getToken } = useAuth();

  const request = useCallback(async (method, url, data = null) => {
    const token = await getToken();
    const response = await api.request({
      method,
      url,
      data,
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  }, [getToken]);

  return { request };
}
```

Returns `response.data` directly — the caller never touches axios internals.
Axios throws on non-2xx responses automatically. The `error.response.data` contains the server's error body.

### 3. Hook — `frontend/src/hooks/useMonitors.js`

Rewrite to use `useApi`:

- Calls `request('GET', '/api/monitors')` on mount
- Returns `{ monitors, isLoading, error, refetch }`
- `monitors` is `response.data` (the array from the backend's `{ data: [...] }`)
- `isLoading` starts true, goes false after first fetch
- `error` is null on success, a string on failure (from `err.response?.data?.error || err.message`)
- `refetch` re-runs the fetch (called after creating a monitor)

### 4. Hook — `frontend/src/hooks/useCreateMonitor.js`

Manages the dialog and form for creating a monitor.

**State:**
- `open` — boolean, dialog visibility
- `formData` — `{ name: '', url: '', intervalMinutes: 5, failureThreshold: 2 }`
- `errors` — `{}` by default, per-field validation errors
- `apiError` — null or string, server-side error message
- `isSubmitting` — boolean

**Functions:**
- `setOpen(bool)` — opens/closes dialog. Closing resets form, errors, and apiError
- `updateField(field, value)` — updates one field, clears that field's error and apiError
- `submit()`:
  1. Validate client-side: name is required (trimmed non-empty), URL is required and starts with `http://` or `https://`
  2. If invalid → set `errors` and return. Do not call API
  3. Set `isSubmitting = true`
  4. Call `request('POST', '/api/monitors', { name, url, interval_minutes, failure_threshold })`
  5. On success → close dialog, reset form, call `onSuccess()` callback
  6. On error → set `apiError` from `err.response?.data?.error || 'Something went wrong'`
  7. Finally → set `isSubmitting = false`

**Edge cases:**
- Double-submit prevention: `submit()` returns immediately if `isSubmitting` is true
- Form reset on close: all state resets when dialog closes, so reopening is always clean
- Network error: axios throws with no `response` property — the fallback message handles it

### 5. Component — `frontend/src/components/monitors/CreateMonitorDialog.jsx`

Uses shadcn `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `Input`, `Select`, `SelectTrigger`, `SelectContent`, `SelectItem`, `SelectValue`, `Button`.

**Layout:**
- Title: "Add Monitor"
- Description: "Configure a new URL to monitor."
- Name input: placeholder "Marketing Site"
- URL input: `font-mono` class, placeholder "https://example.com"
- Interval + Threshold: side by side in a 2-column grid
- Interval: Select with options — 1 minute, 5 minutes, 10 minutes, 30 minutes, 60 minutes. Default: 5 minutes
- Threshold: Select with options — 1 failure, 2 failures, 3 failures, 5 failures. Default: 2 failures
- API error: red text above footer, only shown when `apiError` is non-null
- Footer: Cancel (outline variant) + Create Monitor (default variant)

**Props from parent:**
- `open`, `onOpenChange` — dialog control
- `formData`, `updateField` — form state
- `errors` — per-field validation errors
- `apiError` — server error string
- `isSubmitting` — disables buttons, changes Create text to "Creating..."
- `onSubmit` — called when Create is clicked

**Per-field errors:** shown as `text-sm text-destructive` below the input. Only the fields with errors show messages.

### 6. Wiring — `frontend/src/pages/DashboardPage.jsx`

Already wired. Verify:
- `useMonitors()` provides `monitors`, `isLoading`, `refetch`
- `useCreateMonitor({ onSuccess: refetch })` provides all dialog state
- Both the "Add Monitor" button and the empty state CTA call `setOpen(true)`
- `CreateMonitorDialog` receives all props from the hook
- On successful creation, `refetch` runs and the new monitor appears in the list

### 7. Delete old file

Remove `frontend/src/lib/api.js` — replaced by `frontend/src/lib/axios.js` and `frontend/src/hooks/useApi.js`.

---

## What this spec does NOT cover

- Editing a monitor
- Deleting or pausing a monitor
- Groups (group_id is always null for now)
- Monitor detail page
- The scheduler running checks
- Duplicate URL detection (deferred — not MVP)

---

## Acceptance criteria

1. Clicking "Add Monitor" opens the dialog with empty fields and correct defaults (5 min, 2 failures)
2. Submitting with empty name shows "Name is required" below the name input
3. Submitting with URL "not-a-url" shows validation error below the URL input
4. Submitting with valid data creates a row in the `monitors` table with correct `user_id` and `next_check_at = NOW()`
5. The dialog closes and the new monitor appears in the list without page reload
6. While submitting, the Create button shows "Creating..." and cannot be clicked again
7. If the backend returns an error, it appears as red text in the dialog — the dialog stays open
8. Clicking Cancel or pressing Escape closes the dialog and resets the form
9. Reopening the dialog after a failed submit shows a clean form, not the old error
10. The `user_id` on the created monitor matches `req.user.id`, not anything from the request body
11. The response does not expose `user_id`, `is_deleted`, `is_alerted`, or `consecutive_failures`
