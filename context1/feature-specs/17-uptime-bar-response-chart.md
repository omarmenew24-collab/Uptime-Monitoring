# 17 — Uptime Bar + Response Time Chart

## What this covers

The monitor detail page has stats numbers but no visual history. This spec adds
two components between StatsRow and CheckHistory:

1. **Uptime bar** — a horizontal strip of colored ticks, one per day over the
   last 30 days. Green = all checks up, red = any down, amber = any timeout
   (but no down), gray = no data. This is the signature visual of every uptime
   monitoring tool.

2. **Response time chart** — a line chart showing average response time per day
   over the last 30 days. Shows trends: "response time spiked on Tuesday."

Both read from `stats.rollups` (already returned by `GET /api/monitors/:id`).
No backend changes needed.

### Dependency

Install `recharts` for the response time line chart. The uptime bar is pure
CSS (no charting library needed — it's a row of colored rectangles).

```
cd frontend && npm install recharts
```

---

## Existing state

- `GET /api/monitors/:id` returns `stats.rollups` — array of daily summaries:
  ```json
  { "date": "2026-06-20", "total_checks": 187, "up_count": 150,
    "down_count": 0, "timeout_count": 37, "avg_response_ms": 1848 }
  ```
- `MonitorDetailPage` composes: MonitorHeader → StatsRow → CheckHistory
- Tailwind + Lucide available, dark theme

---

## Components to create

### 1. `components/monitors/UptimeBar.jsx`

A horizontal row of 30 thin rectangles (one per day), left = oldest, right =
today. Each tick is color-coded:

| Condition | Color | Class |
|---|---|---|
| `down_count > 0` | Red | `bg-red-500` |
| `timeout_count > 0` (no down) | Amber | `bg-amber-500` |
| All checks up | Green | `bg-emerald-500` |
| No data for that day | Gray | `bg-zinc-800` |

Layout:
- Container: full width, `h-8`, `flex`, `gap-[2px]`, `rounded-md overflow-hidden`
- Each tick: `flex-1`, full height
- Hover tooltip showing: date, uptime % for that day, check count
- Label row below: "30 days ago" on the left, "Today" on the right,
  `text-xs text-zinc-500`

The component receives `rollups` (array) and fills in missing days with gray
ticks. Create a 30-day date array, match each date to its rollup (if any).

### 2. `components/monitors/ResponseTimeChart.jsx`

A line chart (Recharts `LineChart`) showing `avg_response_ms` per day.

- X axis: dates (formatted as "Jun 20", "Jun 21", etc.)
- Y axis: response time in ms
- Line: indigo (`#6366f1`) with a subtle area fill below
- Tooltip: date + response time on hover
- Dark theme: transparent background, zinc axis text, zinc grid lines
- Container: full width, `h-48`
- Wrapped in a Card with a "Response Time (30d)" header

The component receives `rollups` and plots `avg_response_ms` for each day.
Days with no data (null avg) are skipped (gap in the line).

---

## Files to change

### `MonitorDetailPage.jsx`

Insert `UptimeBar` and `ResponseTimeChart` between `StatsRow` and
`CheckHistory`:

```jsx
<MonitorHeader monitor={monitor} />
<StatsRow monitor={monitor} stats={monitor.stats} />
<UptimeBar rollups={monitor.stats.rollups} />
<ResponseTimeChart rollups={monitor.stats.rollups} />
<CheckHistory ... />
```

---

## Acceptance criteria

1. Uptime bar shows 30 colored ticks, one per day
2. Green for all-up days, red for any-down days, amber for timeout-only, gray
   for missing data
3. Hovering a tick shows the date and uptime % for that day
4. Response time chart shows a line of avg_response_ms over 30 days
5. Chart uses dark theme colors (indigo line, zinc text, transparent background)
6. Both components handle empty rollups (show all gray / empty chart)
7. No backend changes — both read from existing `stats.rollups`
