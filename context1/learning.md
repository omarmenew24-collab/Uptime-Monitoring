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
