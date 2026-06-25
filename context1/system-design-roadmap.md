# System Design Roadmap

This project has a second purpose alongside shipping an uptime monitor: it is
the vehicle for learning real backend system design — queues, background jobs,
caching, event-driven fan-out, time-series rollups, and observability.

This file makes that work **legitimately in scope**. The "don't over-engineer"
rule in `CLAUDE.md` and `code-standards.md` still applies — but the
infrastructure listed here is not hypothetical future work. It is required
product behavior, justified below by a concrete requirement.

---

## The governing principle

**A concept is "needed" only when a specific requirement makes the naive
version break.** We derive each concept from a requirement, never the reverse.
If we cannot name what breaks without a piece of infrastructure, we do not add
it yet — adding it anyway is cargo-culting, the exact thing this roadmap exists
to prevent.

This cuts both ways. Knowing what to **refuse** (see below) is as much a part of
the skill as knowing what to build.

---

## The requirements bar (what makes this "real world")

The original MVP targeted a toy scale where none of these concepts were needed.
We are raising the bar to what a real uptime SaaS must handle. These are the
requirements that force the architecture:

1. **Scale out the checkers.** Checks are slow I/O (5s timeout). The system must
   run check execution across more than one process/machine, and adding capacity
   must not require code changes.
2. **Survive deploys and crashes without losing work.** A check that was claimed
   but not finished when a worker dies must be retried, not silently dropped.
3. **Serve hot read paths cheaply.** The dashboard and a public status page read
   current status and uptime rollups constantly. These reads must not run heavy
   aggregates over the full `check_logs` table every time.
4. **Fan out one event to many consumers.** A single down→up transition must
   reach email, Slack, the status page, and the incident log — without the
   checker knowing about any of them.
5. **Keep history queryable as it grows.** 90-day graphs over millions of rows
   must stay fast, and storage must not grow without bound.
6. **Be operable.** A distributed checker that can't report its own queue depth,
   worker lag, and check latency is unrunnable in practice.

---

## Concept → forcing requirement → what breaks without it

| Concept | Forcing requirement | What breaks without it |
|---|---|---|
| **Worker process** (separate from API) | Req 1 — checks are slow I/O | API request handling tied up by checks; checks can't keep schedule |
| **Durable job queue** (BullMQ/Redis) | Req 1, 2 — scale out + survive crashes | 2 instances double-check every site; a crash loses in-flight checks; no retry/backoff/dead-letter |
| **Work-claiming / exactly-once-ish** | Req 1 — many workers, distinct work | double execution or starved workers |
| **Idempotency** | Req 2 — at-least-once delivery is the norm | duplicate alerts, duplicate log rows on retry |
| **Cache (Redis)** | Req 3 — hot read paths | every dashboard/status-page load aggregates over `check_logs` |
| **Pub/Sub / event bus** | Req 4 — fan-out | checker becomes coupled to every channel; adding one means editing the checker |
| **Time-series rollups + tiered retention** | Req 5 — history at scale | unbounded table; graph queries crawl |
| **Rate limiting / backpressure** | Req 3, 4 — politeness + quotas | hammer target domains and get blocked; blow the email-provider quota |
| **Observability** (queue depth, worker lag, p99) | Req 6 — operability | flying blind; checks run late and nobody knows until a customer notices |

---

## Explicitly refused (anti-cargo-cult list)

These are **out of scope** unless a future, written requirement forces them.
Refusing them is a deliberate design decision, not an oversight:

- **DB sharding / multi-region.** One Postgres with table partitioning handles
  enormous check volume. Sharding here would be pure cargo-cult.
- **Kafka.** Built for high-throughput streaming and replay we will not have.
  Redis Streams / BullMQ is the honest fit for this event volume. Learn Kafka
  later, on a problem that needs it.
- **Microservices beyond `api` + `worker`.** Two deployables is the truthful
  split. More is premature.
- **CQRS / event sourcing.** Over-engineering for this domain.

---

## Target architecture (end state)

Two deployables sharing Postgres + Redis:

- **API** (Express) — CRUD, auth, serves dashboard/status-page reads from cache.
- **Dispatcher** — runs every minute, finds due monitors, enqueues check jobs.
  Single-leader (only one dispatcher enqueues, even if the API runs N copies).
- **Worker pool** — consumes check jobs from the queue, runs the HTTP check,
  writes the result, emits a state-change event. Scales to N processes.
- **Event consumers** — email sender, Slack sender, status-page updater,
  incident recorder. They subscribe to events; the checker does not call them.
- **Rollup + retention job** — aggregates `check_logs` into hourly/daily buckets
  and enforces tiered retention.

Infrastructure additions to the stack: **Redis** (queue, cache, pub/sub) and
**BullMQ** (job library on top of Redis — retries, backoff, dead-letter,
concurrency, repeatable jobs out of the box).

---

## Build order — in sequence, each justified

Every phase is **in scope and will be built.** The forcing-requirement table
above justifies each one — they are not hypothetical. Build them in order
(1→2→3→4→5) because each builds on the last. The gate is "the previous phase
is done," not "wait for production pain." Every phase documents a `learning.md`
entry showing the naive approach and why the real approach replaces it.

### Phase 0 — Baseline monolith *(done: specs 01–08)*
In-process `node-cron` tick that selects due monitors and checks them with
bounded concurrency. This is the "before" the rest of the roadmap reacts to.

### Phase 1 — Extract the worker + durable queue *(done: spec 09)*
- **Requirement:** checks must scale across processes and survive crashes
  (req 1, 2). Without this, two instances double-check; a crash loses work.
- **Build:** Dispatcher enqueues one check job per due monitor; a separate
  worker process consumes via BullMQ; check processing made idempotent; rely on
  BullMQ for retries/backoff/dead-letter; graceful shutdown drains in-flight jobs.
- **Learn:** queues, producer/consumer split, at-least-once delivery,
  idempotency, work-claiming, graceful shutdown.

### Phase 2 — Cache the read path
- **Requirement:** the dashboard and status page poll constantly; every request
  hits Postgres for data that changes only every few minutes (req 3). Without
  caching, read load scales linearly with users.
- **Build:** Redis cache for current status + uptime %; cache-aside reads;
  invalidate/update on each check write; TTL as a safety net; guard against
  cache stampede.
- **Learn:** caching patterns, invalidation, TTL strategy, stampede protection.

### Phase 3 — Event-driven alerting fan-out
- **Requirement:** a status transition must reach email AND Slack without the
  checker knowing about either channel (req 4). Without events, the checker is
  coupled to every notification channel.
- **Build:** Worker emits a state-change event; independent, idempotent
  consumers for email and Slack subscribe to it.
- **Learn:** pub/sub, decoupling via events, fan-out, idempotent consumers.

### Phase 4 — Time-series rollups + tiered retention
- **Requirement:** uptime/response-time graphs and the status page need
  aggregated data; raw `check_logs` grows unbounded (req 5). Without rollups,
  history queries scan millions of rows and storage grows without bound.
- **Build:** Rollup job aggregating raw checks into hourly/daily buckets;
  tiered retention (keep raw for N days, rollups for longer).
- **Learn:** time-series aggregation, rollup jobs, partitioning vs row-by-row
  delete tradeoffs.

### Phase 5 — Observability + backpressure
- **Requirement:** a distributed checker must report its own health, and
  targets/users must be rate-limited (req 6). Without observability, failures go
  unnoticed; without rate limiting, targets get hammered and quotas get blown.
- **Build:** Metrics for queue depth, worker lag, check latency p50/p99;
  per-domain rate limiting; per-user monitor quotas.
- **Learn:** observability, rate limiting, backpressure.

---

## How this interacts with the project rules

- Every phase is in scope and justified — the forcing-requirement table is the
  justification, not production traffic.
- Build in order (1→2→3→4→5); the gate is "previous phase done," not
  "production pain felt."
- The anti-cargo-cult list (refused items) still applies: don't add what no
  requirement forces. The difference is between items *in* the table (build them)
  and items *not* in the table (refuse them).
- When a phase changes a boundary or invariant, update `architecture.md` in the
  same step (per `ai-workflow-rules.md`).
- Each phase's "before/after" gets a `learning.md` entry — the existing bug log
  is the model for these.
