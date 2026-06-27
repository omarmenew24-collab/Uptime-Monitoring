# Feature Explanations

Plain-language walkthroughs of how each part of the uptime monitor works — the *what*, the *why*, the actual code, and the transferable lessons you can carry to any project.

These are for **understanding the codebase**, not building it (build specs live in `../feature-specs/`).

## Reading order

Read them in this order — each builds on the one before.

1. **[01-auth.md](01-auth.md)** — How users sign in (Clerk), and how we link Clerk's identity to our own database. Start here: every other feature assumes a logged-in user.

2. **[02-create-and-list-monitors.md](02-create-and-list-monitors.md)** — The first real feature. Teaches the core backend pattern (route → service → query) and the frontend data layer (React Query + form state). This is the template every CRUD feature follows.

3. **[03-scheduler.md](03-scheduler.md)** — The monitoring engine: the background job that checks every site on schedule, records results, and decides when to alert. The richest file — concurrency, transactions, scheduling, state machines.

4. **[04-url-safety-ssrf.md](04-url-safety-ssrf.md)** — The security layer that stops our server being tricked into fetching internal/private addresses. Pure security thinking: defense in depth, allow-listing, failing closed.

5. **[05-pubsub-vs-durable-queue.md](05-pubsub-vs-durable-queue.md)** — Why we replaced fire-and-forget pub/sub with a durable BullMQ queue for notifications. The most important architecture decision: what happens when a consumer isn't listening?

6. **[06-cache.md](06-cache.md)** — Cache-aside pattern with Redis. How reads skip the database, how writes invalidate the cache, why TTL is a safety net not a strategy, and why cache failures must be non-fatal.

7. **[07-rollups-retention.md](07-rollups-retention.md)** — Pre-aggregating raw check logs into daily summaries so charts read 30 rows instead of 8,640. Tiered retention: keep raw data 30 days, keep rollups forever.

8. **[08-rate-limiting.md](08-rate-limiting.md)** — Three layers of protection: per-user API rate limits, per-domain concurrency limits (counting semaphore), and per-user monitor quotas. Why each layer exists and what it protects.

9. **[09-queue-worker.md](09-queue-worker.md)** — Extracting checks from the API process into a separate worker via BullMQ. Producer/consumer split, work claiming with FOR UPDATE SKIP LOCKED, idempotent processing.

10. **[10-observability.md](10-observability.md)** — Health checks vs metrics. Lag detection (the most important number). Reading queue depth, failed jobs, and connection status to diagnose problems before users notice.

## Each file has the same shape

- **What it does** — the feature in one breath
- **The core idea** — the key insight that makes it click
- **How it flows** — the step-by-step path
- **The files** — what lives where
- **The code, explained** — the real code, with the *why* behind the tricky parts
- **Lessons worth keeping** — principles that apply to any production app

## Related

- **`../../CORE-SYSTEM-DESIGN-LESSONS.md`** — The 7 most important patterns, condensed.
- **`../../SYSTEM-DESIGN-DEEP-DIVE.md`** — All 32 concepts in the codebase, with code.
- **`../learning.md`** — real bugs found during the build, with bad-code / good-code before-and-after.
