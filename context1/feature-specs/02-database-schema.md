Read `context1/architecture.md` before starting.

We're creating the full database schema via migrations against the Neon PostgreSQL database. Four tables: `users`, `groups`, `monitors`, `check_logs`.

## Setup

Install `node-pg-migrate` in `backend/`:

```
npm install node-pg-migrate
```

Add to `backend/package.json` scripts:

```json
"migrate": "node-pg-migrate -m src/db/migrations up",
"migrate:down": "node-pg-migrate -m src/db/migrations down"
```

Create `backend/database.json`:

```json
{
  "defaultEnv": "default",
  "default": {
    "url": { "ENV": "DATABASE_URL" }
  }
}
```

Create the folder `backend/src/db/migrations/`.

## Migration file

Create `backend/src/db/migrations/<timestamp>_initial-schema.js`.

---

### `users`

| Column        | Type        | Constraints             |
| ------------- | ----------- | ----------------------- |
| id            | UUID        | PK, gen_random_uuid()   |
| clerk_user_id | VARCHAR     | NOT NULL, UNIQUE        |
| email         | VARCHAR     | NOT NULL                |
| created_at    | TIMESTAMPTZ | NOT NULL, default NOW() |

---

### `groups`

| Column     | Type        | Constraints                               |
| ---------- | ----------- | ----------------------------------------- |
| id         | UUID        | PK, gen_random_uuid()                     |
| user_id    | UUID        | NOT NULL, FK → users.id ON DELETE CASCADE |
| name       | VARCHAR     | NOT NULL                                  |
| created_at | TIMESTAMPTZ | NOT NULL, default NOW()                   |

Constraint: `UNIQUE(user_id, name)` — no two groups with the same name per user.

---

### `monitors`

| Column               | Type        | Constraints                                        |
| -------------------- | ----------- | -------------------------------------------------- |
| id                   | UUID        | PK, gen_random_uuid()                              |
| user_id              | UUID        | NOT NULL, FK → users.id ON DELETE CASCADE          |
| group_id             | UUID        | nullable, FK → groups.id ON DELETE SET NULL        |
| name                 | VARCHAR     | NOT NULL                                           |
| url                  | VARCHAR     | NOT NULL                                           |
| interval_minutes     | INTEGER     | NOT NULL, default 5                                |
| failure_threshold    | INTEGER     | NOT NULL, default 2                                |
| consecutive_failures | INTEGER     | NOT NULL, default 0                                |
| is_alerted           | BOOLEAN     | NOT NULL, default false                            |
| last_status          | VARCHAR     | nullable, CHECK IN ('up', 'down', 'timeout')       |
| last_checked_at      | TIMESTAMPTZ | nullable — null until first check runs             |
| next_check_at        | TIMESTAMPTZ | nullable — null until monitor is first activated   |
| is_active            | BOOLEAN     | NOT NULL, default true                             |
| is_deleted           | BOOLEAN     | NOT NULL, default false                            |
| created_at           | TIMESTAMPTZ | NOT NULL, default NOW()                            |
| updated_at           | TIMESTAMPTZ | NOT NULL, default NOW()                            |

---

### `check_logs`

| Column           | Type        | Constraints                                       |
| ---------------- | ----------- | ------------------------------------------------- |
| id               | UUID        | PK, gen_random_uuid()                             |
| monitor_id       | UUID        | NOT NULL, FK → monitors.id ON DELETE CASCADE      |
| status           | VARCHAR     | NOT NULL, CHECK IN ('up', 'down', 'timeout')      |
| response_code    | INTEGER     | nullable                                          |
| response_time_ms | INTEGER     | nullable                                          |
| message          | TEXT        | nullable                                          |
| checked_at       | TIMESTAMPTZ | NOT NULL, default NOW()                           |

---

## Indexes

```sql
-- dashboard: all monitors for a user
CREATE INDEX ON monitors(user_id) WHERE is_deleted = false;

-- scheduler: monitors due for a check
CREATE INDEX ON monitors(next_check_at) WHERE is_active = true AND is_deleted = false;

-- history: recent checks for a monitor
CREATE INDEX ON check_logs(monitor_id, checked_at DESC);
```

## Check when done

- `npm run migrate` runs without errors against Neon
- All four tables exist with correct columns, types, constraints, and indexes
- Running `npm run migrate` again is a no-op
- Running `npm run migrate:down` removes everything cleanly
