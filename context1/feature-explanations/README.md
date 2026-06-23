# Feature Explanations

Plain-language walkthroughs of how each part of the uptime monitor works — the *what*, the *why*, the actual code, and the transferable lessons you can carry to any project.

These are for **understanding the codebase**, not building it (build specs live in `../feature-specs/`).

## Reading order

Read them in this order — each builds on the one before.

1. **[01-auth.md](01-auth.md)** — How users sign in (Clerk), and how we link Clerk's identity to our own database. Start here: every other feature assumes a logged-in user.

2. **[02-create-and-list-monitors.md](02-create-and-list-monitors.md)** — The first real feature. Teaches the core backend pattern (route → service → query) and the frontend data layer (React Query + form state). This is the template every CRUD feature follows.

3. **[03-scheduler.md](03-scheduler.md)** — The monitoring engine: the background job that checks every site on schedule, records results, and decides when to alert. The richest file — concurrency, transactions, scheduling, state machines.

4. **[04-url-safety-ssrf.md](04-url-safety-ssrf.md)** — The security layer that stops our server being tricked into fetching internal/private addresses. Pure security thinking: defense in depth, allow-listing, failing closed.

## Each file has the same shape

- **What it does** — the feature in one breath
- **The core idea** — the key insight that makes it click
- **How it flows** — the step-by-step path
- **The files** — what lives where
- **The code, explained** — the real code, with the *why* behind the tricky parts
- **Lessons worth keeping** — principles that apply to any production app

## Related

- **`../../codefilesexplanination/`** — line-by-line annotated copies of individual tricky files (e.g. `useCreateMonitor`).
- **`../learning.md`** — real bugs found during the build, with bad-code / good-code before-and-after.
- **`../architecture-visual.md`** — system diagrams at four zoom levels.
