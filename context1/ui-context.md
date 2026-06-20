# UI Context

## Design Language

Dark-only. No light mode. The visual language is a professional monitoring dashboard — think Datadog or Linear. Near-black backgrounds with layered surfaces, muted neutral text, and vivid status colors as the only accent. Everything else is quiet so the status colors scream when something is wrong.

No component library. Plain CSS with custom properties as design tokens. BEM naming for component classes. This keeps the bundle minimal and puts full control in our hands.

## Colors

All components must use these tokens — no hardcoded hex values anywhere.

```css
:root {
  /* Backgrounds — layered from deepest to most elevated */
  --bg-base:           #09090b; /* page background */
  --bg-surface:        #18181b; /* cards, panels */
  --bg-surface-raised: #27272a; /* modals, dropdowns, tooltips */

  /* Borders */
  --border-default:    #3f3f46;
  --border-subtle:     #27272a;

  /* Text */
  --text-primary:      #fafafa;
  --text-muted:        #a1a1aa;
  --text-disabled:     #52525b;

  /* Accent — used for interactive elements, focus rings, links */
  --accent:            #6366f1; /* indigo — professional, not flashy */
  --accent-hover:      #818cf8;

  /* Status — the most important colors in this app */
  --status-up:         #22c55e; /* green */
  --status-down:       #ef4444; /* red */
  --status-degraded:   #f59e0b; /* amber */
  --status-paused:     #71717a; /* zinc — neutral, not alarming */

  /* Status backgrounds — for badges and subtle fills */
  --status-up-bg:      #052e16;
  --status-down-bg:    #2d0a0a;
  --status-degraded-bg:#2d1b00;
  --status-paused-bg:  #1c1c1e;
}
```

## Typography

| Role         | Font             | Variable        | Import                        |
| ------------ | ---------------- | --------------- | ----------------------------- |
| UI / body    | Inter            | `--font-sans`   | Google Fonts — weights 400 500 600 |
| Monospace    | JetBrains Mono   | `--font-mono`   | Google Fonts — weight 400     |

```css
:root {
  --font-sans: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
}
```

Use Inter for all UI text. Use JetBrains Mono for response times, URLs, IDs, and any technical data — it makes numbers easier to scan.

## Type Scale

```css
:root {
  --text-xs:   0.75rem;  /* 12px — labels, badges */
  --text-sm:   0.875rem; /* 14px — secondary text, table rows */
  --text-base: 1rem;     /* 16px — body, primary UI text */
  --text-lg:   1.125rem; /* 18px — section headings */
  --text-xl:   1.25rem;  /* 20px — page titles */
  --text-2xl:  1.5rem;   /* 24px — dashboard numbers */
}
```

## Spacing Scale

Use these everywhere — margins, paddings, gaps. Never magic numbers.

```css
:root {
  --space-1:  0.25rem;  /* 4px */
  --space-2:  0.5rem;   /* 8px */
  --space-3:  0.75rem;  /* 12px */
  --space-4:  1rem;     /* 16px */
  --space-6:  1.5rem;   /* 24px */
  --space-8:  2rem;     /* 32px */
  --space-12: 3rem;     /* 48px */
  --space-16: 4rem;     /* 64px */
}
```

## Border Radius

```css
:root {
  --radius-sm: 4px;   /* badges, tags, small inputs */
  --radius-md: 8px;   /* cards, panels, buttons */
  --radius-lg: 12px;  /* modals, large containers */
}
```

## Layout

The app has two zones: a fixed sidebar and a scrollable main content area.

```
┌──────────────────────────────────────────────┐
│  Sidebar (240px fixed)  │  Main content area  │
│                         │                     │
│  Logo                   │  Top bar            │
│  Nav links              │  ─────────────────  │
│                         │  Page content       │
│                         │  (scrollable)       │
└──────────────────────────────────────────────┘
```

- **Sidebar**: `240px` fixed width, `--bg-surface` background, right border `--border-default`
- **Main content**: fills remaining width, `--bg-base` background, scrollable
- **Top bar**: sticky, `--bg-base` background, bottom border `--border-subtle`, `56px` height
- **Page content padding**: `--space-8` on all sides
- **Cards**: `--bg-surface` background, `--border-default` border, `--radius-md`, `--space-6` padding

## Component Patterns

**Status badge**
```
background: var(--status-up-bg)
color: var(--status-up)
font-size: var(--text-xs)
font-weight: 600
padding: 2px 8px
border-radius: var(--radius-sm)
text-transform: uppercase
letter-spacing: 0.05em
```

**Monitor card**
```
background: var(--bg-surface)
border: 1px solid var(--border-default)
border-radius: var(--radius-md)
padding: var(--space-6)
```
Left border accent: `3px solid var(--status-up/down/degraded)` — instant visual triage.

**Uptime bar (the 90-day strip)**
Each tick is a thin rectangle, color-coded by status. Gap of `2px` between ticks. Overall height `32px`.

## Icons

Use [Lucide React](https://lucide.dev). Stroke-based only — no filled icons.

| Context              | Size  |
| -------------------- | ----- |
| Inline / nav         | 16×16 |
| Buttons              | 18×18 |
| Empty states / large | 32×32 |

Stroke width: `1.5` everywhere. Thinner looks more refined at small sizes.
