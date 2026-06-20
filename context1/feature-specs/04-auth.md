Auth Spec — Clerk Integration
What this covers
Wiring Clerk into the frontend and backend so that users can sign in and sign up, every protected backend route verifies the caller is a real Clerk user, and our internal users table stays in sync with Clerk via webhooks.

Decisions and why
Clerk owns identity. We do not.

We never store passwords, manage sessions, or issue tokens. Clerk handles all of that. Our only job is to trust Clerk's verification and map its users to our own records.
We maintain our own users table.

Clerk gives us a clerk_user_id string. Everything else in our schema — monitors, groups, check logs — references an internal UUID. The users table bridges the two: clerk_user_id is how we find the row, our UUID is how everything else references it.
Sync is webhook-driven.

When a user signs up, Clerk immediately fires a user.created event to our webhook endpoint. The backend verifies the request came from Clerk, creates the users row, and the row exists before the user makes their first API request. This keeps user creation in one dedicated place, not hidden inside request middleware.
Middleware has a safety-net fallback.

There is a small timing window between signup and webhook delivery. If a user makes their first API request before the webhook has been processed, the middleware will find no row. Rather than failing the request, the middleware falls back to calling Clerk's API directly to fetch the user's email and create the row — identical to what lazy sync would do. This is expected to be rare. The webhook is the primary path; this is the exception handler.
The cron job is not a user.

The scheduler runs server-side and checks URLs on behalf of all users. It connects directly to the database and never goes through auth middleware. There is no concept of "the cron job's identity."

Behavior
Webhook endpoint
The backend exposes one public endpoint dedicated to receiving Clerk events. It is public in the sense that Clerk needs to reach it without a JWT, but it must verify the webhook signature on every request before doing anything else. An invalid signature is rejected immediately with no further processing.
The endpoint handles one event type: user.created. On receiving it, it extracts the user's email and Clerk ID from the payload and inserts a new row into the users table. If a row already exists with that clerk_user_id — because the fallback middleware ran first during the timing window — the insert is silently skipped. No error, no duplicate.
All other event types are acknowledged and ignored.
Protected vs public routes
The sign-in page, sign-up page, health endpoint, and webhook endpoint are the only public routes. Every other frontend route and backend route requires an authenticated session. An unauthenticated request to a protected backend route receives a 401. An unauthenticated visit to a protected frontend route redirects to sign-in.
Request flow on protected routes
Every protected backend request passes through two middleware stages in order. First, the JWT is verified locally using Clerk's public key — no network call needed. If the token is missing or invalid, the request is rejected with a 401 immediately. Second, the verified Clerk user ID is used to look up the corresponding row in the users table. If found, the full row is attached to the request and the handler proceeds. If not found — the rare timing window case — the fallback runs, creates the row, attaches it, and continues.
After both stages, every route handler can assume req.user is a fully populated internal user row. No route handler ever touches a Clerk ID directly.
Sign-in and sign-up pages
Standard two-panel layout on large screens: brand context on the left, Clerk's form on the right. Form only on small screens. Minimal — no decorative elements, no gradients, no oversized layouts. Clerk's form appearance must use the app's existing CSS variables so it matches the dark theme. No hardcoded colors.
User menu
Clerk's built-in user button lives in the top navigation bar. It provides profile settings and sign-out. We do not rebuild or extend it.

Constraints

No Clerk user ID appears in any API response. Internal UUIDs only.
The webhook endpoint must verify Clerk's signature header before processing any payload. A missing or invalid signature returns a 400 immediately.
The /health endpoint is explicitly public — no auth required.
Do not store anything from Clerk beyond clerk_user_id and email. Clerk is the source of truth for everything else.
The users table must have a unique constraint on clerk_user_id so that concurrent inserts from the webhook and the fallback middleware cannot produce duplicates.
No role-based access control in MVP. Every authenticated user has equal access to their own resources.


Edge cases to handle
Duplicate webhook delivery. Clerk guarantees at-least-once delivery, meaning the same user.created event may arrive more than once. The insert must be idempotent — if a row with that clerk_user_id already exists, skip the insert and return a 200 to Clerk. Never return an error for a duplicate.
Timing window: first request arrives before webhook. Handled by the middleware fallback described above. The fallback calls Clerk's API, creates the row, and continues the request normally.
Concurrent fallback requests. If two requests arrive simultaneously during the timing window, both branches hit "row not found" and both attempt to insert. The second insert will fail with a unique constraint violation on clerk_user_id. Catch that specific error, re-fetch the row the first insert created, and continue. Do not surface this as a 500.
Webhook delivery failure. If Clerk cannot reach our endpoint — local dev environment is down, server error, etc. — Clerk will retry with exponential backoff. The middleware fallback covers the gap. Users are not blocked.
Clerk account deleted externally. If a user's Clerk account is deleted, their row in users and all associated data remains in our database. We take no automatic action. This is a known gap — cascade deletion via a user.deleted webhook handler is post-MVP.

Deferred

Handling user.deleted webhook events and cascading deletion
Syncing profile changes via user.updated events
Any form of roles or permissions


Acceptance criteria

Visiting any protected frontend route while signed out redirects to /sign-in
Signing in redirects to /dashboard
An unauthenticated request to any protected backend route returns 401
/health returns 200 with no token
A webhook request with an invalid or missing signature returns 400 with no row created
After a user signs up, a row exists in the users table with the correct clerk_user_id and email — created by the webhook, not the first API request
All monitors and groups reference the internal UUID, never the Clerk ID
Delivering the same user.created webhook twice does not create duplicate rows
Sign-out works and redirects to /sign-in
Clerk's form matches the dark theme — no default light colors visible