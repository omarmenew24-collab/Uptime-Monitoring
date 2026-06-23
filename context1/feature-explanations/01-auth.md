# Authentication

## What it does

Lets users sign in, and makes sure every protected request comes from a real, logged-in user. We don't store passwords or manage sessions ourselves — Clerk (an external service) does that. Our job is just to **trust Clerk and connect its users to our own database**.

---

## The core idea

There are two separate worlds:

- **Clerk's world** — knows emails, passwords, and gives each user an ID like `user_abc123`
- **Our world** — knows monitors and checks, and identifies users by a database UUID

The `users` table is the bridge. It has two columns that matter: `clerk_user_id` (Clerk's ID) and `id` (our UUID). Everything in our app — monitors, groups, logs — points to our UUID, never to Clerk's ID.

---

## How it flows

### Signing in (frontend)

1. User lands on a protected page while logged out → `ProtectedRoute` redirects them to `/sign-in`
2. Clerk's pre-built `<SignIn />` component handles the form, passwords, and OAuth
3. On success, Clerk stores a session and gives the browser a **JWT** (a signed token proving who they are)

### Every API request (backend)

Each request to `/api/monitors` passes through three checks in order:

1. **`clerkMiddleware()`** — reads the token, verifies it's genuine (using Clerk's public key, no network call), and notes the Clerk user ID
2. **`requireAuth`** — if there's no valid token, stop here and return `401 Unauthorized`
3. **`syncUser`** — take the Clerk user ID, find the matching row in our `users` table, and attach it to the request as `req.user`

After this, every route handler can simply use `req.user.id` and trust it's a real user.

### Creating the user record

When someone signs up, their row in our `users` table gets created in one of two ways:

- **Primary path — webhook:** Clerk sends a `user.created` event to our backend, which inserts the row. This happens automatically right after signup.
- **Backup path — fallback:** If a user's first request arrives *before* the webhook does, `syncUser` notices the row is missing, asks Clerk for the email directly, and creates the row itself.

Both paths end with the same result: a user row exists. They're designed so that if both run, you don't get a duplicate.

---

## The files

| File | What it owns |
|------|--------------|
| `main.jsx` | Wraps the app in `ClerkProvider` (initializes Clerk) |
| `ProtectedRoute.jsx` | Redirects logged-out users to sign-in |
| `SignInPage.jsx` / `SignUpPage.jsx` | The sign-in/up screens (mostly Clerk's components) |
| `middleware/auth.js` | `requireAuth` (the gate) + `syncUser` (the bridge) |
| `routes/webhooks.js` | Receives Clerk events, creates the user row |

---

## The code, explained

### The gate — `requireAuth`

```js
export const requireAuth = (req, res, next) => {
  const { userId } = getAuth(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};
```

`getAuth(req)` reads what `clerkMiddleware` already verified. If there's no `userId`, the token was missing or fake → stop with `401`. Otherwise `next()` passes control to the next middleware. That's the whole gate — it doesn't touch the database, it just checks "is there a valid token?"

### The bridge — `syncUser`

```js
const result = await query(
  'SELECT * FROM users WHERE clerk_user_id = $1',
  [clerkUserId]
);

if (result.rows.length > 0) {
  req.user = result.rows[0];
  return next();
}
```

First it looks for the user in our database by their Clerk ID. The common case: the row exists (the webhook made it), so we attach it to `req.user` and move on. `$1` is a **parameterized query** — the value is sent separately from the SQL text, so a malicious ID can't inject SQL.

```js
const clerkUser = await clerkClient.users.getUser(clerkUserId);
const email = clerkUser.emailAddresses[0]?.emailAddress;

const insert = await query(
  'INSERT INTO users (clerk_user_id, email) VALUES ($1, $2) RETURNING *',
  [clerkUserId, email]
);
req.user = insert.rows[0];
```

If the row wasn't found (webhook is late), we ask Clerk for the email and create the row ourselves. `RETURNING *` gives us the new row back in the same query, so we don't need a second `SELECT`.

```js
} catch (err) {
  if (err.code === '23505') {
    const retry = await query('SELECT * FROM users WHERE clerk_user_id = $1', [clerkUserId]);
    req.user = retry.rows[0];
  } else {
    throw err;
  }
}
```

This is the subtle part. If two requests arrive at the same instant, both might find "no row" and both try to insert. The database's unique constraint blocks the second one with error code `23505`. Instead of crashing, we catch *that specific error*, re-read the row the other request created, and continue. Any other error is re-thrown.

### The webhook — `handleClerkWebhook`

```js
const wh = new Webhook(secret);
try {
  evt = wh.verify(req.body, {
    'svix-id': req.headers['svix-id'],
    'svix-timestamp': req.headers['svix-timestamp'],
    'svix-signature': req.headers['svix-signature'],
  });
} catch {
  return res.status(400).json({ error: 'Invalid webhook signature' });
}
```

Before trusting anything, verify the signature. Clerk signs every webhook; `wh.verify` recomputes the signature from the secret and the headers. If it doesn't match, the request is fake → `400`, no processing.

```js
if (evt.type === 'user.created') {
  await query(
    'INSERT INTO users (clerk_user_id, email) VALUES ($1, $2) ON CONFLICT (clerk_user_id) DO NOTHING',
    [clerkUserId, email]
  );
}
res.status(200).json({ received: true });
```

`ON CONFLICT (clerk_user_id) DO NOTHING` — if the row already exists (the fallback beat us to it, or Clerk sent the event twice), the insert quietly does nothing instead of erroring. We always return `200` so Clerk knows we received it and won't keep retrying.

### Frontend setup — `ClerkProvider` (main.jsx)

```js
<ClerkProvider publishableKey={publishableKey} appearance={clerkAppearance}>
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </QueryClientProvider>
</ClerkProvider>
```

`ClerkProvider` wraps the entire app. This is what makes hooks like `useAuth()` and `getToken()` work anywhere inside — they read from this provider. The `publishableKey` is the public half of the Clerk keys (safe to ship to the browser; the secret key stays on the backend). The `appearance` prop themes Clerk's pre-built screens to match our dark UI, so the sign-in form doesn't look like a foreign white box.

### The frontend guard — `ProtectedRoute`

```js
const { isLoaded, isSignedIn } = useAuth();

if (!isLoaded) return null;
if (!isSignedIn) return <Navigate to="/sign-in" replace />;
return children;
```

`isLoaded` is false while Clerk is still checking for a session — we render nothing to avoid a flicker. Once loaded, if not signed in, redirect. Otherwise show the page. `replace` means the redirect doesn't add a history entry, so the back button won't bounce them back to the protected page.

---

## Lessons worth keeping

These apply to almost any production app, not just this one.

**1. Don't build what you can safely delegate.**
Authentication is easy to get wrong in dangerous ways (password storage, session hijacking, token leaks). Using a specialist service like Clerk removes a whole category of security risk. The trade-off is a dependency — accept it when the risk of doing it yourself is high.

**2. Keep your own ID, even when an external service owns identity.**
We never let Clerk's `user_abc123` spread through our database. We map it once to our own UUID at the edge. If we ever switch auth providers, only the `users` table changes — the rest of the app doesn't care. **Isolate external identifiers at the boundary.**

**3. Design for "the event might arrive late, twice, or never."**
The webhook is the normal path, but we don't assume it's instant or reliable. The fallback handles "it's late," and the duplicate-safe insert handles "it arrived twice." This is **idempotency** — running the same operation more than once produces the same result. Any time you react to an external event, ask: what if it's slow? what if it repeats?

**4. Verify webhooks are genuine.**
Our webhook endpoint is public (Clerk has to reach it without logging in). So before trusting *any* payload, we verify its cryptographic signature. **A public endpoint that takes action must prove the caller is who they claim to be** — otherwise anyone can POST fake data to it.

**5. Fail closed, not open.**
If the token is missing or invalid, we reject with `401` *before* any logic runs. The default answer to "is this allowed?" should be **no**, unless proven otherwise.
