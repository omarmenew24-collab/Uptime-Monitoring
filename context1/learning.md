# Learning — What Went Wrong and Why

Real bugs found during the uptime monitor build. Each one shows the broken code, explains the problem in plain terms, and shows the fix.

---

## 1. Unbounded Concurrency (Thundering Herd)

### The bad code

```js
export const checkAllDueMonitors = async () => {
  const dueMonitors = await findDueMonitors();

  const results = await Promise.allSettled(
    dueMonitors.map((monitor) => processCheck(monitor))
  );
};
```

### What's wrong

`dueMonitors.map(...)` fires ALL monitors at the same time. If 5,000 monitors are due, that's 5,000 DNS lookups + 5,000 HTTP requests + 5,000 database transactions — all at once.

What actually happens:
- Node.js runs out of sockets (each `fetch` opens a TCP connection)
- Memory spikes because all responses are in-flight simultaneously
- The database connection pool has only 10 slots — 5,000 transactions queue up behind them, causing timeouts
- The event loop stalls because it's managing thousands of concurrent I/O operations

This is called a **thundering herd** — everything wakes up at once and stampedes the system.

### The fix

```js
import pLimit from 'p-limit';

const MAX_CONCURRENT_CHECKS = 50;

export const checkAllDueMonitors = async () => {
  const dueMonitors = await findDueMonitors();

  const limit = pLimit(MAX_CONCURRENT_CHECKS);

  const results = await Promise.allSettled(
    dueMonitors.map((monitor) => limit(() => processCheck(monitor)))
  );
};
```

`p-limit` wraps each check in a gate. Only 50 run at a time. When one finishes, the next one starts. The total throughput is the same — they all get checked — but the system never has more than 50 in-flight at once.

Why 50? It's matched to the database pool size (10 connections), network capacity, and the 60-second window before the next scheduler tick. If each check takes ~1 second, 50 concurrency processes all 5,000 in under 2 minutes. Tune this number based on your actual load.

---

## 2. check_logs Growing Without Bound

### The bad code

There was no code — that's the problem. Every check writes a row to `check_logs`, and nothing ever deletes old rows.

### What's wrong

1,000 monitors at 1-minute intervals = 1,440,000 rows per day. In one year: ~525 million rows.

What actually happens:
- Database storage costs climb (Neon charges by storage)
- Backups take longer and longer
- Queries that scan the table (even with indexes) slow down as the table grows
- `VACUUM` and `ANALYZE` operations take more time, holding locks

The table doesn't just get "a little bigger" — it grows linearly forever with no ceiling.

### The fix

```js
// retention.queries.js
export const deleteExpiredCheckLogs = async () => {
  const result = await query(
    `DELETE FROM check_logs
     WHERE checked_at < NOW() - ($1 || ' days')::interval`,
    [String(RETENTION_DAYS)]
  );
  return result.rowCount;
};
```

```js
// scheduler/index.js — runs at 3:00 AM daily
cron.schedule('0 3 * * *', async () => {
  const deleted = await deleteExpiredCheckLogs();
});
```

A daily job at 3 AM deletes everything older than 30 days. Simple, predictable, and runs during low-traffic hours.

Why not `TRUNCATE`? Because `TRUNCATE` deletes everything. We want to keep the last 30 days.

Why not partitioning? Partitioning by month is the more scalable approach for millions of rows — the old partition is dropped instantly instead of row-by-row deletion. But for MVP volumes, a daily `DELETE` is simpler and works fine up to a few million rows.

---

## 3. Undrained Fetch Body (Socket Leak)

### The bad code

```js
const response = await fetch(url, {
  method: 'GET',
  signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  redirect: 'follow',
});

const responseTimeMs = Date.now() - startTime;

// We read response.status and response.ok...
// ...but never touch response.body

if (response.ok) {
  return { status: 'up', responseCode: response.status, responseTimeMs, message: null };
}
```

### What's wrong

HTTP responses have a body — the HTML, JSON, or whatever the server sends back. When you call `fetch()`, Node opens a TCP socket and starts receiving data. If you read `.status` and `.ok` but never consume or cancel the body, the socket stays open waiting for the body to finish streaming.

What actually happens:
- The TCP connection stays in a "half-open" state
- Node's HTTP agent holds the socket in its pool, but it can't reuse it
- Over hundreds of checks per minute, sockets accumulate
- Eventually you hit the OS file descriptor limit and new connections fail with `EMFILE` (too many open files)
- The failure is gradual — it works fine for hours or days, then suddenly every check fails

This is called a **resource leak** — you're borrowing something (a socket) and never returning it.

### The fix

```js
const response = await fetch(url, {
  method: 'GET',
  signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  redirect: 'follow',
});

const responseTimeMs = Date.now() - startTime;

// Tell Node we don't need the body — release the socket immediately
await response.body?.cancel();

if (response.ok) {
  return { status: 'up', responseCode: response.status, responseTimeMs, message: null };
}
```

One line: `await response.body?.cancel()`. This tells the fetch internals: "I'm done, close the stream and release the socket." The `?.` handles the edge case where `body` is null (shouldn't happen in practice, but defensive coding).

Why not `response.body.getReader().cancel()`? Because `.cancel()` directly on the body is the spec'd way to discard it. Simpler and clearer.

Why not just read the body with `await response.text()`? Because we don't need the body content — reading it wastes bandwidth and memory for data we'd immediately throw away. `cancel()` tells the server to stop sending.

---

## 4. IPv6 SSRF Bypass (CodeRabbit Finding)

### The bad code

```js
const isPrivateIPv6 = (ip) => {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe80')) return true;
  return false;
};
```

### What's wrong

IPv6 has many ways to represent the same address. An attacker could use:

- `::ffff:169.254.169.254` — this is an IPv4-mapped IPv6 address. It looks like IPv6 but actually points to the AWS metadata service. Our check only looks for `::1`, `fc/fd`, and `fe80` — this sails right through.
- `FE80:0000:0000:0000:0000:0000:0000:0001` — full-form IPv6. `startsWith('fe80')` only catches the compressed form, not this.
- `::ffff:127.0.0.1` — IPv4-mapped loopback. Bypasses both the IPv4 check (it's not a dotted quad) and the IPv6 check (doesn't match our patterns).

Writing your own IP classifier means knowing every RFC. You will miss cases.

### The fix

```js
import ipaddr from 'ipaddr.js';

const PRIVATE_RANGES = ['loopback', 'private', 'linkLocal', 'uniqueLocal', 'unspecified'];

export const isPrivateIP = (ip) => {
  try {
    const parsed = ipaddr.process(ip);
    const range = parsed.range();
    return PRIVATE_RANGES.includes(range);
  } catch {
    return true; // if we can't parse it, block it
  }
};
```

`ipaddr.js` handles all the RFC-compliant parsing: IPv4, IPv6, IPv4-mapped IPv6, full-form, compressed-form, zone IDs. `ipaddr.process()` normalizes IPv4-mapped IPv6 addresses into their actual IPv4 equivalents before classifying.

`.range()` returns a human-readable classification: `'loopback'`, `'private'`, `'linkLocal'`, `'unicast'`, etc. We block every non-public range.

`catch → return true` means if the IP is malformed or unparseable, we block it. In security, unknown = denied.

The lesson: **don't hand-roll security-critical parsing.** A well-tested library that tracks RFCs will always be more correct than your regex.

---

## 5. DNS Rebinding / TOCTOU (Time of Check, Time of Use)

### The bad code

```js
// url-safety.js
export const resolveAndValidate = async (urlString) => {
  const { address } = await lookup(hostname);  // resolve once
  if (isPrivateIP(address)) {
    return { safe: false, reason: '...' };
  }
  return { safe: true, ip: address };           // return the IP
};

// checks.service.js
const dnsCheck = await resolveAndValidate(url);
if (!dnsCheck.safe) return ...;

const response = await fetch(url, { ... });     // resolves hostname AGAIN
```

### What's wrong

Two separate DNS resolutions happen:
1. `resolveAndValidate` calls `dns.lookup()` → gets `93.184.216.34` (public, safe) ✓
2. `fetch(url)` calls `dns.lookup()` internally → gets `169.254.169.254` (private, metadata) ✗

Between step 1 and step 2, the DNS server changed its answer. This is called **DNS rebinding** — the attacker's DNS server is programmed to alternate: first response is a safe public IP, second response is a private/internal IP.

The gap between the two lookups is only milliseconds, but that's enough. An attacker sets a very short DNS TTL (like 0 seconds), so the OS doesn't cache the result, and each lookup hits the attacker's server fresh.

There's also a second bug: `dns.lookup()` returns only the **first** resolved IP by default. A hostname can have multiple A records — `93.184.216.34` (public) AND `10.0.0.5` (private). If the first one happens to be public, the check passes, but `fetch()` might connect to the private one.

### The fix

```js
export const resolveAndValidate = async (urlString) => {
  // Resolve ALL addresses — block if ANY is private
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    return { safe: false, reason: `DNS resolution failed for ${hostname}` };
  }

  for (const { address } of addresses) {
    if (isPrivateIP(address)) {
      return { safe: false, reason: `Hostname resolves to a private IP (${address})` };
    }
  }

  return { safe: true };
};
```

Two changes:
1. **`{ all: true }`** — resolves every A/AAAA record for the hostname, not just the first. If any record points to a private IP, the whole check is blocked. Closes the multi-record bypass.
2. **The TOCTOU gap is accepted as a known limitation** — true IP pinning (replacing the hostname with the resolved IP in the URL) breaks HTTPS because TLS certificates are issued for the hostname, not the IP. The server's SNI check fails. The only bulletproof fix requires a custom HTTP agent that pins the socket to the resolved IP at the connection level — that's deep `undici` internals and over-engineered for this project.

What we get: protection against multi-record attacks (complete) and a very narrow TOCTOU window that requires an attacker to control a DNS server with TTL=0 and respond differently within milliseconds. For a monitoring MVP, this is an acceptable tradeoff. For a security-critical enterprise product, you'd use a custom agent with IP pinning.

The lesson: **security often involves tradeoffs, not absolutes.** Know what you're protected against, know what gap remains, and document the decision so the next developer doesn't think it's an oversight.

---

## 6. Phase 1 — From an In-Process Cron to a Durable Queue

This one isn't a single bug — it's the architecture change in `system-design-roadmap.md` Phase 1, written up as a before→after so the *why* is on record. Spec: `feature-specs/09-queue-worker.md`.

### The "before" (Phase 0)

One `node-cron` tick **inside the API process** both decided what was due and ran the checks, guarded by an in-memory boolean:

```js
let isRunning = false;
cron.schedule('* * * * *', async () => {
  if (isRunning) return;        // skip if the last run is still going
  isRunning = true;
  try { await checkAllDueMonitors(); }   // find due + pLimit(50) fan-out, all here
  finally { isRunning = false; }
});
```

### What breaks

- **Run a second instance** (scale out, or a rolling deploy where old + new overlap): both ticks fire, and `isRunning` is *per-process* — it knows nothing about the other copy. **Every monitor gets checked twice.**
- **Crash mid-check**: a check that was in flight when the process died just vanishes. There's no record it was claimed, no retry with backoff, no dead-letter.
- **Capacity is capped at one process.** `pLimit(50)` is 50 in *that* process; you can't add a machine to go faster, because adding a process re-triggers the double-check problem above.

The root issue: an in-memory flag can only coordinate work *within one process*, and the schedule column alone can't make work durable.

### The fix

Split **decide** from **execute**, and put a durable queue between them.

1. **Work-claiming replaces the flag.** The dispatcher claims due monitors in the database, the source of truth every process shares:

   ```sql
   SELECT id FROM monitors
   WHERE next_check_at <= NOW() AND is_active AND NOT is_deleted
   FOR UPDATE SKIP LOCKED          -- each row locked & skipped by other claimers
   LIMIT $1
   ```

   `SKIP LOCKED` lets N dispatchers split the work; each monitor is claimed by exactly one. The same statement advances `next_check_at`, so a claimed monitor isn't re-selected next tick.

2. **A durable queue (BullMQ/Redis) owns execution and retry.** The unit of work is now a job. If a worker dies mid-check, BullMQ re-delivers the job; transient failures retry with exponential backoff; persistent ones land in the failed set (dead-letter). This is *why* it's safe to advance `next_check_at` up front — retry is the queue's job now, not a side effect of leaving the schedule in the past.

3. **Idempotency, because a durable queue is at-least-once.** A job can be delivered twice (stall re-delivery, retry). The write is deduped on a `job_id` unique key:

   ```js
   // ON CONFLICT (job_id) DO NOTHING → returns null on a repeat delivery
   const inserted = await insertCheckLog(client, monitorId, checkResult, jobId);
   if (!inserted) return;   // already processed — skip the state update
   ```

   One job ⇒ exactly one log row and one state transition.

4. **Concurrency is the worker's, scaled by adding workers.** `pLimit(50)` became `new Worker(..., { concurrency })`. To go faster: raise `WORKER_CONCURRENCY` or run another `npm run worker` — same code.

5. **Graceful shutdown.** `worker.close()` stops pulling new jobs but lets in-flight checks finish before exit, so a deploy drains instead of severing work.

### Two things building it actually taught us

- **BullMQ forbids `:` in a custom job id** (`Custom Id cannot contain :`). The first `jobId` was `monitorId:minuteBucket`; it threw at enqueue. Changed the separator to `_`. Only caught by *running* it — a reminder that static checks and "it imports fine" aren't verification.
- **Claim and enqueue aren't atomic.** `claimDueMonitors` commits (advancing `next_check_at`) before `addBulk` runs. When the enqueue failed, the monitor had already been claimed — so it simply waited one interval before becoming due again. Delayed, never lost. Documented as an accepted limitation rather than papered over; the durable fix (a transactional outbox) is unjustified at this scale.

### Lessons worth keeping

1. **An in-memory flag coordinates one process; a shared lock coordinates many.** The moment "prevent overlapping runs" has to hold across processes, the answer moves into the database (`SKIP LOCKED`) or a queue — not a boolean.
2. **Durable delivery is at-least-once, so consumers must be idempotent.** The instant you add a queue, design the dedupe key (`job_id`) in the same step — it is not optional polish.
3. **Decide *what* to run separately from *how* to run it.** That seam is what lets execution scale by adding workers with zero code change.
4. **You haven't verified a distributed change until you've run it.** The real bug here was invisible to syntax checks and import wiring — it only appeared on the first live enqueue.
