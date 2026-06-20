Read `context1/ui-context.md` before starting.

We're building the monitor detail page — what users see when they click a monitor card from the dashboard. It shows the monitor's current status, configuration, and full check history.

---

## Route

`/monitors/:id` — protected route, rendered inside `AppShell`.

Add this route to `App.jsx`.

---

## Page layout

Three sections stacked vertically with `--space-8` gap.

### Section 1: Monitor header

A card (`--bg-surface`, `--border-default`, `--radius-md`, `--space-6` padding) with:

```
┌────────────────────────────────────────────────────────────┐
│  ● UP     Marketing Site                    [ Pause ] [ Delete ] │
│           https://example.com                                     │
│                                                                    │
│  Check every 5 min  ·  Alert after 2 failures  ·  Created Jun 12  │
└────────────────────────────────────────────────────────────┘
```

- Status badge (reuse `StatusBadge` component)
- Monitor name: `--text-xl`, weight 600, `--text-primary`
- URL: `--font-mono`, `--text-sm`, `--text-muted`, clickable (opens in new tab)
- Meta row: `--text-xs`, `--text-muted`, items separated by `·`
- Action buttons (top right):
  - Pause/Resume: ghost style — `--bg-surface-raised`, `--text-muted`, `Pause` or `Play` icon
  - Delete: ghost style — `--status-down` text on hover, `Trash2` icon
  - Both: `--radius-md`, `--space-2` padding, icon only (no text label)

### Section 2: Stats row

Three stat boxes in a horizontal row, equal width, `--space-4` gap.

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Current     │  │  Avg Response │  │  Checks      │
│  UP          │  │  245ms        │  │  1,247       │
└──────────────┘  └──────────────┘  └──────────────┘
```

Each stat box:
- `--bg-surface`, `--border-default`, `--radius-md`, `--space-6` padding
- Label: `--text-xs`, `--text-muted`, uppercase, letter-spacing `0.05em`
- Value: `--text-2xl`, weight 600, `--font-mono`
- Current status value uses its status color (`--status-up`, `--status-down`)

### Section 3: Check history

A table showing the most recent checks, newest first.

**Table header:**
- `--text-xs`, `--text-muted`, uppercase, letter-spacing `0.05em`
- Bottom border: `1px solid var(--border-default)`
- Columns: Status | Response Code | Response Time | Checked At

**Table rows:**
- `--text-sm`, `--text-primary`
- Bottom border: `1px solid var(--border-subtle)`
- Hover: `--bg-surface-raised` background
- Status column: uses `StatusBadge` component
- Response code: `--font-mono` (e.g. `200`, `500`, `—` for timeout)
- Response time: `--font-mono`, `--text-muted` (e.g. `234ms`, `—` for timeout)
- Checked at: `--text-muted`, relative time ("2 minutes ago")

---

## Data fetching

Create `frontend/src/hooks/useMonitor.js`:

- Fetches `GET /api/monitors/:id` for monitor details
- Returns `{ monitor, isLoading, error }`

Create `frontend/src/hooks/useCheckLogs.js`:

- Fetches `GET /api/monitors/:id/checks` for check history
- Returns `{ checks, isLoading, error }`

Both use `apiFetch`. Both use mock data for now until the API exists.

---

## TopBar

When on this page, TopBar title shows the monitor name instead of "Dashboard". Add a back arrow (`ArrowLeft` icon from Lucide) that navigates to `/dashboard`.

---

## File structure

```
frontend/src/
  components/
    monitors/
      MonitorHeader.jsx
      MonitorHeader.css
      StatsRow.jsx
      StatsRow.css
      CheckHistory.jsx
      CheckHistory.css
  hooks/
    useMonitor.js
    useCheckLogs.js
  pages/
    MonitorDetailPage.jsx
    MonitorDetailPage.css
```

---

## Check when done

- Clicking a monitor card on the dashboard navigates to `/monitors/:id`
- Monitor header shows status, name, URL, and meta info
- Stats row shows three boxes with current status, avg response time, check count
- Check history table renders with correct columns and styling
- Back arrow returns to dashboard
- All status colors use CSS tokens
- Table rows have hover effect
- URL is clickable and opens in a new tab
