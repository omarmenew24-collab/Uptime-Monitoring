# Creating & Listing Monitors

## What it does

Lets a signed-in user add a URL to watch (with a check interval and failure threshold) and see all the monitors they've created. This is the first feature that uses the logged-in user from auth, and it's the template every other data feature follows.

---

## The core idea

A request flows through **three layers**, each with one job:

```
Route  →  Service  →  Database query
```

- **Route** — handles the HTTP part: read the body, validate it, send a response. No business logic.
- **Service** — the business logic. Right now it's thin, but it's the place decisions live.
- **DB query** — the only place that talks to the database. Raw SQL, nothing else.

Why bother splitting when the service is thin? Because the moment two different callers need the same logic (a route AND the scheduler), having it in a service means neither has to duplicate it. You saw this with the scheduler — it reuses logic without pretending to be an HTTP request.

---

## How it flows

### Creating a monitor

1. User fills the dialog, clicks "Create Monitor"
2. Frontend sends `POST /api/monitors` with the form data and the auth token
3. Auth middleware sets `req.user` (from the auth feature)
4. The route validates the body with Zod — bad input stops here with `400`
5. The service inserts the row, stamping it with `req.user.id` and `next_check_at = NOW()`
6. The new monitor comes back; the dashboard list refreshes automatically

### Listing monitors

1. Dashboard loads, calls `GET /api/monitors` with the token
2. The query returns only *this user's* monitors that aren't deleted, newest first
3. React Query caches the result so revisiting the page is instant

---

## The files

| File | What it owns |
|------|--------------|
| `schemas/monitors.schema.js` | The validation rules for incoming data |
| `routes/monitors.routes.js` | The HTTP endpoints — validate, delegate, respond |
| `services/monitors.service.js` | Business logic (thin pass-through for now) |
| `db/monitors.queries.js` | The actual SQL |
| `hooks/useMonitors.js` | Frontend data fetching (get + create) |
| `components/monitors/CreateMonitorDialog.jsx` | The form UI |

---

## The code, explained

### Validation — the Zod schema

```js
export const createMonitorSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100, ...),
  url: z.string().trim()
    .regex(urlPattern, 'Must be a valid HTTP or HTTPS URL with a domain')
    .refine((val) => validateUrlHostname(val).safe, 'Private... URLs are not allowed'),
  interval_minutes: z.number().refine((val) => [1,5,10,30,60].includes(val), ...).default(5),
  failure_threshold: z.number().refine((val) => [1,2,3,5].includes(val), ...).default(2),
});
```

This is the contract for what valid input looks like. The interval and threshold are restricted to a fixed set of allowed values — a user can't send `interval_minutes: 0` and hammer a site every second. `.refine()` runs a custom check; here it rejects private/internal URLs (the SSRF guard, covered in its own file). Defining the rules as data, in one place, means the route stays clean.

### The route — validate, delegate, respond

```js
router.post('/', async (req, res) => {
  const parsed = createMonitorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
  }

  const monitor = await monitorsService.createMonitor(req.user.id, parsed.data);
  return res.status(201).json({ data: monitor });
});
```

`safeParse` checks the body against the schema without throwing — it returns success/failure. Invalid → `400` with the details, and we never reach the database. Valid → hand the clean data to the service. Notice the user ID comes from `req.user.id` (set by auth), **never from the request body** — the client can't claim to be someone else. `201` means "created."

### The query — parameterized SQL with a column whitelist

```js
const SAFE_COLUMNS = `id, name, url, interval_minutes, failure_threshold, is_active,
  last_status, last_checked_at, next_check_at, created_at`;

export const insertMonitor = async (userId, data) => {
  const result = await query(
    `INSERT INTO monitors (user_id, name, url, interval_minutes, failure_threshold, next_check_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING ${SAFE_COLUMNS}`,
    [userId, data.name, data.url, data.interval_minutes, data.failure_threshold]
  );
  return result.rows[0];
};
```

Two deliberate choices:
- `RETURNING ${SAFE_COLUMNS}` — we explicitly list which columns to send back. Internal fields like `is_deleted` and `consecutive_failures` never leak to the client. We control exactly what the outside world sees.
- `next_check_at = NOW()` — the new monitor is immediately "due," so the scheduler picks it up on its next run. No separate "activate" step.

### Listing — scoped to the owner

```js
export const findMonitorsByUserId = async (userId) => {
  const result = await query(
    `SELECT ${SAFE_COLUMNS} FROM monitors
     WHERE user_id = $1 AND is_deleted = false
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
};
```

Every read is filtered by `user_id` — a user can only ever see their own monitors. `is_deleted = false` hides soft-deleted rows. This filter is the difference between a private app and a data breach.

### Frontend — React Query for fetching

```js
export const useGetMonitors = () => {
  const { getToken } = useAuth();
  const fetchMonitors = async () => {
    const token = await getToken();
    const res = await api.get(ENDPOINTS.MONITORS, { headers: { Authorization: `Bearer ${token}` } });
    return res.data;
  };
  const { data, isLoading, isError } = useQuery({ queryKey: ['monitors'], queryFn: fetchMonitors });
  return { monitors: data?.data ?? [], isLoading, isError };
};
```

`useQuery` handles loading state, errors, and caching for free. The `queryKey: ['monitors']` is the cache label — it's how the create mutation knows what to refresh.

```js
export const useCreateMonitor = () => {
  const queryClient = useQueryClient();
  // ...
  return useMutation({
    mutationFn: createMonitor,
    onSuccess: () => {
      toast.success('Monitor created successfully!');
      queryClient.invalidateQueries({ queryKey: ['monitors'] });
    },
    onError: (error) => toast.error(error.response?.data?.error || 'Failed to create monitor'),
  });
};
```

`useMutation` is for actions that change data. On success it **invalidates** the `['monitors']` cache — React Query then automatically re-fetches the list, so the new monitor appears without a manual reload. Success and error both surface a toast. The component doesn't manage any of this state itself.

### Frontend — form state, kept separate from server state

```js
export default function useCreateMonitorForm() {
  const [formData, setFormData] = useState(INITIAL_FORM);
  const [errors, setErrors] = useState({});

  const validate = useCallback(() => {
    const newErrors = {};
    if (!formData.name.trim()) newErrors.name = 'Name is required';
    if (!formData.url.trim()) newErrors.url = 'URL is required';
    else if (!formData.url.startsWith('http://') && !formData.url.startsWith('https://'))
      newErrors.url = 'URL must start with http:// or https://';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [formData]);

  const getSubmitData = useCallback(() => ({
    name: formData.name.trim(),
    url: formData.url.trim(),
    interval_minutes: formData.intervalMinutes,
    failure_threshold: formData.failureThreshold,
  }), [formData]);
  // ...returns open, formData, updateField, errors, validate, getSubmitData
}
```

Notice the split: this hook owns **form state** (what the user is typing, dialog open/closed, validation errors). The `useMutation` hook owns **server state** (the API call). Keeping them apart means the form doesn't care how saving works, and the mutation doesn't care about input fields. `getSubmitData` also converts the UI's camelCase (`intervalMinutes`) to the API's snake_case (`interval_minutes`) — the boundary translation happens in one place.

The frontend validation here is a *convenience* — it gives instant feedback without a round trip. The backend Zod schema is the *real* guard. Never rely on client validation alone; it can be bypassed.

### Frontend — the page that wires it together

```jsx
export default function DashboardPage() {
  const { monitors, isLoading, isError } = useGetMonitors();   // server: read
  const { createMyMonitor, isPending } = useCreateMonitor();   // server: write
  const form = useCreateMonitorForm();                         // local: form

  const handleSubmit = async () => {
    if (!form.validate()) return;            // stop if invalid
    try {
      await createMyMonitor(form.getSubmitData());  // call the API
      form.handleOpenChange(false);                 // close dialog on success
    } catch {
      // error toast already handled by the mutation
    }
  };

  if (isLoading) return null;
  if (isError) return <div>Failed to load monitors. Please refresh.</div>;

  return (
    <>
      {monitors.length === 0
        ? <EmptyState onAddMonitor={() => form.setOpen(true)} />
        : <MonitorList monitors={monitors} />}
      <CreateMonitorDialog {...form} isSubmitting={isPending} onSubmit={handleSubmit} />
    </>
  );
}
```

This is where the three hooks meet. The page reads the data, holds the form, and on submit: validate → save → close. Each hook does one thing; the page just orchestrates them. The dialog is "dumb" — it receives state and callbacks as props and renders, with no logic of its own. That's the React equivalent of the backend's route/service split: presentation stays separate from logic.

---

## Lessons worth keeping

**1. Layer by responsibility, even before you "need" it.**
Route → service → query feels like overkill when the service is one line. But the cost of the split is tiny, and the payoff is huge the day a second caller (the scheduler) needs the same logic. Cheap insurance against future duplication.

**2. Never trust the client for identity or authority.**
The owner of a new monitor comes from the verified token (`req.user.id`), not the request body. If you let the client send `user_id`, anyone could create data as anyone else. **Identity comes from the server's trusted context, never from user input.**

**3. Validate at the boundary, reject early.**
All input is checked the instant it arrives, before any logic or database call. Invalid data never gets deep into the system. One schema, one place, clear error messages.

**4. Whitelist what leaves, not just what comes in.**
`SAFE_COLUMNS` controls exactly which fields the API returns. Internal bookkeeping columns stay internal. Decide deliberately what the outside world can see — don't `SELECT *` and hope.

**5. Always scope queries to the owner.**
Every read carries `WHERE user_id = $1`. In a multi-user app, forgetting this filter on a single query is how one user sees another's data. Make owner-scoping a reflex.

**6. Parameterized queries, always.**
The `$1, $2` placeholders keep user values separate from SQL text, so input can never be executed as a command. This is the single most important habit for preventing SQL injection.

**7. Let a data-fetching library own server state.**
React Query handles caching, loading, errors, and refetch-after-change. The "invalidate the cache, list refreshes itself" pattern removes a whole class of manual state bugs. Don't hand-roll what a mature tool does correctly.
