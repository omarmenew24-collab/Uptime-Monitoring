# Progress Tracker

Update this file after every meaningful implementation
change.

## Current Phase

- **Phase 5 COMPLETE** — All system-design and product features built

## Current Goal

- Verify all features work end-to-end in the browser

## Completed

**System Design Phases:**
- ✅ Phase 0 — In-process cron baseline
- ✅ Phase 1 — Worker pool + durable queue (BullMQ/Redis, idempotent jobs, retries)
- ✅ Phase 2 — Cache (Redis cache-aside, 60s/120s TTL, invalidation)
- ✅ Phase 3 — Event-driven alerting (durable notification queue, email + Slack)
- ✅ Phase 4 — Time-series rollups + tiered retention (raw 30d, rollups indefinite)
- ✅ Phase 5 — Observability + backpressure (metrics, rate limiting, quotas)

**Product Features (Specs 01–20):**
- ✅ Specs 01–08 — Core MVP (auth, CRUD, checks, dashboard)
- ✅ Spec 09 — Check history pagination
- ✅ Spec 10 — Pause/resume/delete monitors
- ✅ Spec 11 — Edit monitor
- ✅ Spec 12–13 — Event-driven notifications (email + Slack channels)
- ✅ Spec 14 — Time-series rollups + retention
- ✅ Spec 15 — Rate limiting + quotas
- ✅ Spec 16 — Uptime bar + response time chart
- ✅ Spec 17 — Monitor detail page with history
- ✅ Spec 18 — Public status page (no auth, cached)
- ✅ Spec 19 — Notification settings (Slack webhook URL)
- ✅ Spec 20 — Loading/error states (spinners, friendly messages)

## In Progress

- End-to-end testing in browser (all systems running: Postgres, Redis, backend, frontend)

## Open Questions

- [Any unresolved product or technical decisions]

## Architecture Decisions

- **2026-06-22 — Build to real-world scale, distributed by design.** The product
  is intentionally targeted at a scale where queues, caching, event-driven
  fan-out, and time-series rollups are *required*, not decorative — this project
  doubles as a system-design learning vehicle. Each piece is justified by a
  forcing requirement in `system-design-roadmap.md`; cargo-cult choices
  (sharding, Kafka, microservices, CQRS) are explicitly refused.
- **2026-06-22 — Stack additions: Redis + BullMQ.** Redis serves as queue,
  cache, and pub/sub transport; BullMQ provides retries/backoff/dead-letter.
  Postgres remains the only source of truth.
- **2026-06-22 — API and Worker are separate deployables** sharing Postgres and
  Redis, so check execution scales horizontally without code changes.
- **2026-06-22 — Build in order, every phase justified.** Each phase is in
  scope (justified by a forcing requirement); build sequentially (1→2→3→4→5),
  gated by "previous phase done." Document each "before/after" as a
  `learning.md` entry.
- **2026-06-25 — Dropped trigger gates.** The roadmap originally said "build
  each phase only when its trigger is felt in production." Since this is a
  learning project, production pain will never arrive — so the gate is now
  "previous phase done," not "wait for scale." The forcing requirements still
  justify each phase; only the timing changed.

## Session Notes

- **2026-06-27 — Redis installation + rate limiter fix.** Redis was not installed on Windows, causing the backend to fail on startup. Fixed rate limiter to skip IP-based limiting when Redis is down (only rate-limit authenticated users). Downloaded and installed Redis 3.2.100 for Windows. All three systems (Postgres, Redis, Clerk) now report healthy. See `REDIS-SETUP.md` for full explanation.
- **All features implemented.** Every spec (01–20) and every phase (0–5) is code-complete and pushed to `phase1` branch. Ready for browser testing and merge to `main`.
