Read `context1/ui-context.md` before starting.

We're building the dashboard — the first thing a signed-in user sees. It shows all their monitors with live status, and an empty state if they have none yet.

---

## Empty state

When the user has no monitors, the dashboard shows a centered message — not inside a card, just floating on the page background.

```
                No monitors yet
    Add your first monitor to start tracking uptime.

              [ + Add Monitor ]
```

- Heading: `--text-lg`, weight 500, `--text-primary`
- Description: `--text-sm`, `--text-muted`
- Button: `--accent` background, white text, `--radius-md`, `--space-3` vertical padding, `--space-6` horizontal, `Plus` icon from Lucide (size 16, stroke 1.5)
- Everything centered vertically and horizontally in the content area

---

## Monitor list

When monitors exist, show them as a vertical list of monitor cards. No grid — one card per row, full width.

Gap between cards: `--space-4`.

### Monitor card

```
┌─ 3px left border (status color) ──────────────────────────────────┐
│                                                                    │
│  ● UP        Monitor Name                    Last checked: 2m ago  │
│              https://example.com              Avg: 245ms           │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

- Card: `--bg-surface`, `1px solid var(--border-default)`, `--radius-md`, `--space-6` padding
- Left border: `3px solid` with status color (`--status-up`, `--status-down`, `--status-paused`)
- Layout: CSS Grid — left column (status badge + name/url), right column (meta info), vertically centered

**Status badge:**
- Uppercase text: `UP`, `DOWN`, `TIMEOUT`, `PAUSED`
- Font: `--text-xs`, weight 600, letter-spacing `0.05em`
- Color and background use status token pairs (e.g. `--status-up` text on `--status-up-bg` background)
- Padding: `2px 8px`, `--radius-sm`

**Monitor name:** `--text-base`, weight 500, `--text-primary`

**URL:** `--font-mono`, `--text-xs`, `--text-muted`

**Right side meta:**
- "Last checked: 2m ago" — `--text-xs`, `--text-muted`
- "Avg: 245ms" — `--font-mono`, `--text-xs`, `--text-muted`

Card is clickable — navigates to monitor detail page (future spec). Add `cursor: pointer` and a subtle hover: `border-color: var(--border-subtle)` transition.

---

## Top bar integration

The TopBar for the dashboard page shows:
- Left: "Dashboard" title (already done)
- Right: `+ Add Monitor` button (small, `--accent` background, white text, `--radius-md`, `Plus` icon)

The `+ Add Monitor` button opens the Create Monitor dialog (next spec).

---

## Data fetching

Create `frontend/src/hooks/useMonitors.js`:

- Uses `apiFetch` from `lib/api.js`
- Fetches `GET /api/monitors` on mount
- Returns `{ monitors, isLoading, error, refetch }`
- While loading, show nothing (not a spinner — keep it clean)

This hook requires the monitors API route on the backend, which doesn't exist yet. For now, wire the hook with a mock response so the UI can be built and tested independently:

```js
// Temporary mock data — remove when API is ready
const MOCK_MONITORS = [
  {
    id: '1',
    name: 'Marketing Site',
    url: 'https://example.com',
    last_status: 'up',
    last_checked_at: new Date(Date.now() - 120000).toISOString(),
    interval_minutes: 5,
    is_active: true,
  },
  {
    id: '2',
    name: 'API Server',
    url: 'https://api.example.com/health',
    last_status: 'down',
    last_checked_at: new Date(Date.now() - 300000).toISOString(),
    interval_minutes: 1,
    is_active: true,
  },
  {
    id: '3',
    name: 'Staging',
    url: 'https://staging.example.com',
    last_status: null,
    last_checked_at: null,
    interval_minutes: 10,
    is_active: false,
  },
];
```

---

## File structure

```
frontend/src/
  components/
    monitors/
      MonitorCard.jsx
      MonitorCard.css
      MonitorList.jsx
      StatusBadge.jsx
      StatusBadge.css
      EmptyState.jsx
      EmptyState.css
  hooks/
    useMonitors.js
  pages/
    DashboardPage.jsx
    DashboardPage.css
```

---

## Check when done

- Empty state renders centered when monitor list is empty
- Monitor cards render with correct status colors and left border
- Status badges show correct color pairs for up/down/timeout/paused
- URL displays in monospace
- Cards have hover effect
- `+ Add Monitor` button appears in the top bar
- No hardcoded colors — all from CSS tokens
- Layout is responsive — cards stretch full width on any screen size
