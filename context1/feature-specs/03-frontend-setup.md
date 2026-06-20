Read `context1/ui-context.md` before starting.

We're scaffolding the React frontend — Vite project, CSS design tokens, and the app shell layout (sidebar + main area). No pages, no data, no API calls yet. Just the visual skeleton that every future feature will live inside.

## Scaffold the project

Create the frontend with Vite inside the repo root:

```
npm create vite@latest frontend -- --template react
```

Then inside `frontend/`:

```
npm install
npm install lucide-react
```

## Folder structure

```
frontend/
  src/
    components/
      layout/
        AppShell.jsx
        Sidebar.jsx
        TopBar.jsx
    styles/
      tokens.css
      global.css
    App.jsx
    main.jsx
```

## CSS tokens

Create `frontend/src/styles/tokens.css`.

Define every custom property from `context1/ui-context.md` exactly:
- All background variables (`--bg-base`, `--bg-surface`, `--bg-surface-raised`)
- All border variables
- All text variables
- All accent variables
- All status variables and their `-bg` variants
- All font variables
- All type scale variables (`--text-xs` through `--text-2xl`)
- All spacing variables (`--space-1` through `--space-16`)
- All border radius variables

## Global styles

Create `frontend/src/styles/global.css`:

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono&display=swap');
@import './tokens.css';

*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: var(--font-sans);
  font-size: var(--text-base);
  background-color: var(--bg-base);
  color: var(--text-primary);
  -webkit-font-smoothing: antialiased;
}
```

Import `global.css` in `main.jsx` — not in `App.jsx`.

## App shell

### `AppShell.jsx`

- CSS Grid layout: sidebar (240px fixed) + main content (1fr)
- Full viewport height (`100dvh`)
- No scrolling on the shell itself — only the main area scrolls

### `Sidebar.jsx`

- Fixed 240px width
- Background: `--bg-surface`
- Right border: `1px solid var(--border-default)`
- Full height
- Contains:
  - Logo area at the top — just the text "Uptime" for now, styled with `--font-sans`, weight 600, `--text-lg`
  - Nav section with placeholder links: Dashboard, Monitors (use `LayoutDashboard` and `Activity` icons from Lucide, size 16×16, stroke 1.5)
  - Nav links use `--text-muted` color, `--text-sm` size. Active link uses `--text-primary`

### `TopBar.jsx`

- Height: 56px
- Background: `--bg-base`
- Bottom border: `1px solid var(--border-subtle)`
- Sticky at top of main content area
- Left side: current page title (hardcoded "Dashboard" for now)
- Right side: empty for now

## Wire it up

`App.jsx` renders `<AppShell />` which renders `<Sidebar />` + a main section containing `<TopBar />` and a scrollable content area.

## Check when done

- `npm run dev` starts without errors
- The shell renders: sidebar on the left, top bar across the main area
- All colors come from CSS variables — open DevTools and confirm no hardcoded hex values in the layout
- Lucide icons appear in the sidebar nav
- Resizing the window keeps the sidebar fixed and the main area flexible
