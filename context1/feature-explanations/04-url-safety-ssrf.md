# URL Safety (SSRF Protection)

## What it does

Stops our server from being tricked into making requests to places it shouldn't — like internal networks or cloud metadata services. Because users give us URLs and our server fetches them, a malicious user could enter a URL pointing *inward* instead of at a real website. This feature blocks that.

---

## The attack we're preventing: SSRF

**SSRF** = Server-Side Request Forgery. The idea: a user can't reach your internal systems, but *your server* can. So the attacker gives your server a URL and makes it fetch something on their behalf.

The classic target is the cloud metadata endpoint `http://169.254.169.254/`. On AWS/GCP, that address returns the server's own credentials and secrets. From the outside it's unreachable — but if our scheduler blindly fetches whatever URL a user typed, the attacker reads our cloud keys through us.

Other targets: `http://localhost:3000` (our own API), `http://192.168.x.x` (internal services), databases on private IPs. All normally firewalled off — all reachable *from* our server.

---

## The core idea: defense in depth

We check twice, at two different moments:

1. **At input** (`validateUrlHostname`) — when a user creates a monitor, reject obviously-bad URLs immediately. Fast feedback, blocks the easy cases.
2. **At fetch time** (`resolveAndValidate`) — right before the scheduler actually makes the request, resolve the hostname to its real IP and check *that*. This catches the sneaky case where a normal-looking domain secretly points to a private IP.

Two layers, because the first one can be bypassed and the second one catches what the first can't. **Never rely on a single check for security.**

---

## How it flows

```
User creates monitor
   → validateUrlHostname()  ── reject if protocol wrong, hostname blocked,
                                or it's a literal private IP
   → saved to database

Scheduler checks the monitor (later)
   → resolveAndValidate()   ── resolve hostname via DNS, check EVERY
                                resolved IP, block if any is private
   → only then: fetch()
```

---

## The code, explained

### The building block — `isPrivateIP`

```js
const PRIVATE_RANGES = ['loopback', 'private', 'linkLocal', 'uniqueLocal', 'unspecified'];

export const isPrivateIP = (ip) => {
  try {
    const parsed = ipaddr.process(ip);
    return PRIVATE_RANGES.includes(parsed.range());
  } catch {
    return true;   // can't parse it? treat as unsafe.
  }
};
```

We use the `ipaddr.js` library, not hand-written checks. It parses any IP format — IPv4, IPv6, and tricky mixed forms — and `.range()` classifies it: `'loopback'` (127.x), `'private'` (10.x, 192.168.x), `'linkLocal'` (169.254.x — the metadata range), etc. If it matches any non-public range, it's blocked.

The `catch { return true }` is a security stance: **if we can't understand the input, we assume the worst and block it.** An unparseable IP is more likely an attack than a mistake.

### Layer 1 — input check, `validateUrlHostname`

```js
const parsed = new URL(urlString);   // throws on garbage → caught → "Invalid URL"

if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
  return { safe: false, reason: 'Only HTTP and HTTPS protocols are allowed' };
}
```

First, only allow `http`/`https`. This blocks `file://` (read server files), `ftp://`, `gopher://` and other schemes that have their own SSRF tricks. **Allow-list the protocols you want; don't try to block the bad ones.**

```js
if (BLOCKED_HOSTNAMES.has(hostname)) { ... }   // 'localhost', 'metadata.google.internal'

try {
  const addr = ipaddr.process(hostname);
  if (PRIVATE_RANGES.includes(addr.range())) return { safe: false, ... };
} catch {
  // not an IP literal — a real hostname, checked later at fetch time
}
```

Then block known-bad names, and if the hostname is *itself* a raw private IP (`http://10.0.0.1`), reject it now. If it's a normal domain name, we can't fully judge it yet — that needs DNS — so we let it pass this layer and rely on layer 2.

### Layer 2 — fetch-time check, `resolveAndValidate`

```js
addresses = await dns.lookup(hostname, { all: true });   // EVERY IP, not just one

for (const { address } of addresses) {
  if (isPrivateIP(address)) {
    return { safe: false, reason: `Hostname resolves to a private IP (${address})` };
  }
}
```

This is the real protection. A domain like `evil.com` looks harmless, but its DNS record can point to `169.254.169.254`. So before fetching, we resolve it and inspect the actual IP.

The `{ all: true }` matters: a hostname can have **multiple** IP addresses. An attacker could list one public IP (to pass a naive check) and one private IP. We check *all* of them and block if *any* is private. Checking only the first would be a bypass.

This result is used by the scheduler — `runCheck` calls `resolveAndValidate` and refuses to fetch if it's not safe.

---

## The honest limitation: DNS rebinding

There's a known gap, documented in `learning.md`. Between our DNS check and `fetch`'s own internal DNS lookup, an attacker controlling the DNS server *could* return a safe IP to us and a private IP to fetch, milliseconds apart. Closing this completely requires pinning the connection to the exact IP we validated — which breaks HTTPS certificates and needs deep low-level networking. For this app, the multi-record check covers the realistic attacks, and the remaining window is documented as accepted. **Knowing and writing down what you're *not* protected against is part of doing security properly.**

---

## Lessons worth keeping

**1. If your server fetches user-supplied URLs, you have an SSRF risk.**
Any time user input becomes an outbound request — webhooks, image fetchers, link previews, monitors — assume someone will point it inward. This is one of the most common and most missed vulnerabilities.

**2. Defense in depth: check at more than one layer.**
Validate at input *and* at the moment of use. The input check is fast and catches the obvious; the use-time check catches what input can't know (like DNS results). One layer is one bypass away from failure.

**3. Allow-list, don't block-list.**
We permit only `http`/`https` rather than trying to enumerate every dangerous protocol. Allow-listing fails safe — anything you didn't explicitly permit is denied. Block-lists always miss something.

**4. Don't hand-roll security-critical parsing.**
IP classification has countless edge cases (IPv4-mapped IPv6, compressed forms, etc.). A maintained library like `ipaddr.js` encodes the RFCs correctly. Our original handwritten version had real bypasses — the library fixed them. Reach for the proven tool for security primitives.

**5. Fail closed.**
Unparseable input → blocked. DNS fails → blocked. The default answer is always "no." In security code, the safe direction when unsure is to deny.

**6. Check every result, not just the first.**
A hostname with multiple IPs, a list with mixed values — validate all of them. Attackers exploit the gap between "checked one" and "used another."

**7. Document the gaps you knowingly leave.**
We can't fully close DNS rebinding without disproportionate cost, so we wrote down exactly what remains exposed and why. An honest, recorded limitation is far better than a false sense of safety — the next developer knows the real state.
