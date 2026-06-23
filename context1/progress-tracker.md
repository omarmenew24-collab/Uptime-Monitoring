# Progress Tracker

Update this file after every meaningful implementation
change.

## Current Phase

- Not started

## Current Goal

- Basic project skeleton — backend, database schema, frontend shell

## Completed

- None yet.

## In Progress

- None yet.

## Next Up

The MVP feature specs (01–08) are the Phase 0 baseline. The system-design
phases in `system-design-roadmap.md` build on top of them, one at a time, each
when its trigger hits:

- Phase 1 — extract worker + durable queue (BullMQ/Redis); idempotent jobs; retries/backoff/DLQ
- Phase 2 — cache the read path (dashboard + status page)
- Phase 3 — event-driven alerting fan-out (email + Slack)
- Phase 4 — time-series rollups + tiered retention
- Phase 5 — observability + backpressure

Do not start a later phase while an earlier phase's trigger has not been reached.

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
- **2026-06-22 — Seams now, mechanisms on pain.** Design the job/worker/event
  seams from the start, but switch on each mechanism only when its phase trigger
  is reached. Document each naive "before" as a `learning.md` entry.

## Session Notes

- [Context needed to resume work in the next session]
