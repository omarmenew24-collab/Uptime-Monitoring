# 19 — Notification Settings Page

## What this covers

Users can't configure their Slack webhook URL from the UI — it can only be set
directly in the database. This spec adds a settings page where the user can
view and update their notification preferences: Slack webhook URL and email
(read-only, from Clerk).

---

## Existing state

- `users` table has `email` and `slack_webhook_url` (nullable)
- `db/users.queries.js` — `findUserById(userId)` returns both fields
- Slack consumer in `events/consumers/slackConsumer.js` already checks
  `slack_webhook_url` and skips if null
- No settings page or user-profile route exists
- Sidebar in `AppShell` exists but has no settings link

---

## Backend

### `db/users.queries.js` — add `updateUserSettings`

```sql
UPDATE users SET slack_webhook_url = $2 WHERE id = $1
RETURNING id, email, slack_webhook_url
```

### `services/users.service.js` — new file

**`getUserSettings(userId)`** — calls `findUserById`, returns email +
slack_webhook_url.

**`updateUserSettings(userId, data)`** — validates the webhook URL (must be a
valid HTTPS URL or null to clear), calls `updateUserSettings` query.

### `routes/users.routes.js` — new file

- `GET /api/settings` — returns current user's settings (email + webhook URL)
- `PATCH /api/settings` — updates slack_webhook_url

Both behind `requireAuth + syncUser`.

### `app.js` — mount settings route

```js
app.use('/api/settings', requireAuth, syncUser, usersRouter);
```

---

## Frontend

### `pages/SettingsPage.jsx`

A simple form:
- **Email** — displayed read-only (from Clerk, not editable here)
- **Slack Webhook URL** — input field, save button
- Success/error toasts on save

### `hooks/useSettings.js`

- `useGetSettings()` — fetches `GET /api/settings`
- `useUpdateSettings()` — mutation for `PATCH /api/settings`

### `App.jsx` — add route

```jsx
<Route path="/settings" element={<ProtectedRoute><AppShell><SettingsPage /></AppShell></ProtectedRoute>} />
```

### Sidebar — add settings link

Add a "Settings" link (gear icon) at the bottom of the sidebar, navigating
to `/settings`.

---

## Acceptance criteria

1. Settings page shows the user's email (read-only) and Slack webhook URL
2. User can save a Slack webhook URL — it persists and is used by the Slack
   notification consumer
3. User can clear the webhook URL (set to empty/null) — Slack notifications
   stop
4. Invalid URLs are rejected with a validation error
5. Settings link appears in the sidebar
