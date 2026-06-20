# Code Standards

## General

- Every function does one thing — if you need to describe it with "and", split it
- Fix the root cause, never paper over it with a try/catch or a fallback that hides the real problem
- Never mix concerns — a route handler should not contain business logic, and a DB query should not live inside a component
- Build what is needed now — no abstractions for hypothetical future requirements
- If you wouldn't ship it, don't commit it — no TODOs, no commented-out code, no console.logs

## JavaScript (ES Modules)

- Always use `import`/`export` — never `require()` or `module.exports`
- Every `package.json` must have `"type": "module"`
- `const` by default — only use `let` when you know you will reassign
- Never use `var` — not ever, not for any reason
- Always `async/await` — never `.then()` chains, they scatter the flow across callbacks
- Name things after what they are, not what they do generically — `monitorId` not `id`, `checkIntervalMs` not `interval`
- No abbreviations — `req`, `res` are fine Express conventions, but `tmp`, `val`, `data`, `info` tell the reader nothing

## Express (Backend)

- One responsibility per route handler — parse input, call a service, return a response
- Business logic lives in service files, not in route files
- Use Zod to validate all `req.body`, `req.params`, and `req.query` at the route level — define a schema, parse it, and reject with `400` before the handler runs. Never hand-roll validation checks inline
- Validation schemas live in `backend/schemas/` — one file per domain (e.g. `monitors.schema.js`) so they can be reused across routes
- If Zod parsing throws, catch it and return `{ error: "Invalid input", details: err.errors }` — never let it bubble to the 500 handler
- Authenticate and confirm ownership before any mutation — check the user owns the resource, not just that they are logged in
- All responses follow the same shape: `{ data: ... }` on success, `{ error: "..." }` on failure — never ad-hoc structures
- Never expose internal error messages or stack traces to the client
- Use an error-handling middleware — do not repeat `res.status(500)` in every route

## PostgreSQL

- All queries go through a `db/` module — no raw `pool.query()` scattered across routes
- Use parameterized queries everywhere — never interpolate user input into SQL strings
- Schema changes go in versioned migration files — never alter tables by hand in production
- Keep queries focused — fetch only the columns you need, not `SELECT *`
- Transactions are required for any operation that touches more than one table

## React (Frontend)

- One component per file, named to match its file — `MonitorCard.jsx` exports `MonitorCard`
- Fetch data in a dedicated hook or service layer — not directly inside JSX
- No business logic inside components — components render, they do not calculate
- Keep state as local as possible — only lift state when two components genuinely need it
- Never mutate state directly — always derive new values

## API Design

- REST conventions: `GET` reads, `POST` creates, `PATCH` updates, `DELETE` removes
- Route paths are plural nouns: `/monitors`, `/checks`, `/alerts`
- Return `201` for creates, `200` for reads and updates, `204` for deletes with no body
- IDs in URLs are for resource identity — filter params go in query strings

## File Organization

- `backend/routes/` — Express route definitions only, no logic
- `backend/services/` — business logic, one file per domain (monitors, checks, alerts)
- `backend/db/` — all database queries and migrations
- `frontend/src/components/` — reusable UI pieces
- `frontend/src/pages/` — top-level route views
- `frontend/src/hooks/` — data-fetching and stateful logic
