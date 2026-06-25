# 16 — Edit Monitor

## What this covers

Users can create monitors but cannot change them after creation. This spec adds
an edit dialog on the monitor detail page to update name, URL, interval, and
failure threshold.

No migration needed — all columns already exist.

---

## Existing state

- `monitors` table has `name`, `url`, `interval_minutes`, `failure_threshold`
- `createMonitorSchema` in `schemas/monitors.schema.js` validates all four
  fields with Zod (including URL format and SSRF checks)
- `CreateMonitorDialog` is a reusable form — same fields needed for edit
- `MonitorHeader` already has action buttons (pause/resume/delete)
- Cache invalidation pattern is established (invalidate user list + detail)

---

## Backend

### `schemas/monitors.schema.js` — add update schema

`updateMonitorSchema` — same fields as create, but all optional (partial
update). At least one field must be present.

```js
export const updateMonitorSchema = createMonitorSchema.partial().refine(
  (data) => Object.keys(data).length > 0,
  'At least one field must be provided'
);
```

### `db/monitors.queries.js` — add `updateMonitor`

```sql
UPDATE monitors
SET name = COALESCE($3, name),
    url = COALESCE($4, url),
    interval_minutes = COALESCE($5, interval_minutes),
    failure_threshold = COALESCE($6, failure_threshold),
    updated_at = NOW()
WHERE id = $1 AND user_id = $2 AND is_deleted = false
RETURNING <SAFE_COLUMNS>
```

`COALESCE` makes partial updates safe — only provided fields change.
Ownership verified via `user_id`. Returns null if not found/not owned.

### `services/monitors.service.js` — add `editMonitor`

Calls `updateMonitor`, invalidates cache (both user list and detail).

### `routes/monitors.routes.js` — add `PATCH /:id`

Validates body with `updateMonitorSchema`. Returns 200 with updated monitor.
Returns 404 if not found/not owned. Returns 400 on validation failure.

---

## Frontend

### `hooks/useMonitors.js` — add `useEditMonitor`

Mutation: `PATCH /api/monitors/:id` with the updated fields. Invalidates
`['monitors']` and `['monitor', id]` on success.

### `lib/endpoints.js` — add `MONITOR_EDIT`

```js
MONITOR_EDIT: (id) => `/api/monitors/${id}`,
```

### `components/monitors/EditMonitorDialog.jsx` — the edit form

Reuse the same form layout as `CreateMonitorDialog` (name, URL, interval,
threshold selects). Pre-populated with the monitor's current values. Dialog
opens from a button in `MonitorHeader`.

### `components/monitors/MonitorHeader.jsx` — add edit button

Add a `Pencil` icon button next to Pause/Delete. Opens `EditMonitorDialog`.

---

## Acceptance criteria

1. User can edit name, URL, interval, and failure threshold from the detail page
2. Form is pre-populated with current values
3. Partial updates work — changing only the name leaves other fields unchanged
4. URL validation and SSRF checks apply on edit (same as create)
5. Dashboard and detail page update immediately after edit (cache invalidated)
6. Returns 404 for wrong user
7. Returns 400 for invalid input
