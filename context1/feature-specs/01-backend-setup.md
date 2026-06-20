Read `context1/architecture.md` and `context1/code-standards.md` before starting.

We're building the Express backend skeleton — the folder structure, server entry point, database connection, and a health check route. Nothing more. No routes, no auth, no business logic yet.

## Folder structure to create

```
backend/
  db/
    pool.js
    migrations/
  routes/
  services/
  schemas/
  server.js
```

## Dependencies

Install in `backend/`:

```
express cors helmet dotenv pg node-pg-migrate zod
```

Ensure `package.json` has `"type": "module"`.

## Files to create

### `backend/.env`

```
PORT=3001
DATABASE_URL=postgres://localhost:5432/uptime_dev
JWT_SECRET=changeme
```

### `backend/.env.example`

Same keys, empty values.

### `backend/db/pool.js`

- Import `pg`
- Create and export a single `Pool` instance using `DATABASE_URL` from env
- Export one helper: `query(text, params)` that calls `pool.query`
- Log a clear error and exit if the pool fails to connect on startup

### `backend/server.js`

- Import `express`, `cors`, `helmet`, `dotenv`
- Load `.env` with `dotenv`
- Apply `helmet()` and `cors()` middleware
- Parse JSON bodies
- Mount a health check route: `GET /api/health` → `{ status: 'ok' }`
- Start listening on `PORT`
- Log the port when the server starts

## Check when done

- `node backend/server.js` starts without errors
- `GET /api/health` returns `{ "status": "ok" }`
- `.env` is in `.gitignore`
- No `require()` anywhere — ES modules only
