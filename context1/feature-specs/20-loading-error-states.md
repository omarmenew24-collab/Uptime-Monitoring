# 20 — Loading and Error States

## What this covers

Several pages return `null` while loading (blank screen) and show minimal
error messages. This spec adds proper loading spinners and error states
across all pages so the app never shows a blank screen.

---

## Pages to update

### `DashboardPage.jsx`
- Loading: currently `return null` — replace with a centered spinner
- Error: currently shows text — keep but style it better

### `MonitorDetailPage.jsx`
- Loading: currently `return null` — replace with spinner
- Error: currently "Monitor not found." text — add a back link

### `StatusPage.jsx`
- Loading: currently "Loading status..." — replace with spinner
- Error: already styled, keep as is

### `SettingsPage.jsx`
- Loading: currently `return null` — replace with spinner

---

## Component to create

### `components/ui/Spinner.jsx`

A simple animated loading spinner — a rotating circle using Tailwind's
`animate-spin` on a Lucide `Loader2` icon. Centered in a container.

```jsx
<div className="flex items-center justify-center min-h-96">
  <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
</div>
```

Reused across all pages.

---

## Acceptance criteria

1. No page shows a blank screen while loading
2. All loading states show a centered spinner
3. Error states have clear messages and a way to navigate back
4. Spinner component is reusable across pages
