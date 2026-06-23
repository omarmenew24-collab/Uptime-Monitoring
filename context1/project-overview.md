# Uptime Monitor

## Overview

A web application that monitors website uptime by periodically sending HTTP
requests to registered URLs and alerting users when their sites go down.
Built for developers and small teams who need reliable uptime visibility.

This project is built to **real-world scale**, not toy scale. Check execution
runs as a distributed background system — a dispatcher, a durable job queue, and
a horizontally scalable worker pool — so the system design concepts it relies on
(queues, caching, event-driven fan-out, time-series rollups) are genuinely
required rather than decorative. See `system-design-roadmap.md` for the
requirements that force each piece and the order they are introduced.

## Goals

1. A user can register URLs and receive alerts within one check cycle of a site going down
2. The system reliably executes checks on schedule with no missed runs — even across deploys, crashes, and multiple worker processes
3. Check execution scales horizontally: adding capacity is adding workers, not changing code
4. Read paths (dashboard, public status page) stay fast regardless of history size
5. Users can review the full check history and uptime trends for any monitor

## Core User Flow

1. User signs in via Clerk
2. User adds a monitor — providing a URL, check interval, and failure threshold
3. The cron job picks up the monitor and begins running checks on schedule
4. Each check result is logged to check_logs
5. On consecutive failures exceeding the threshold, the user receives an email alert
6. User views the dashboard to see current status of all monitors
7. User drills into a monitor to see its check history

## Features

### Monitor Management

- Add a monitor with a URL, preset check interval, and failure threshold
- View all monitors and their current status on the dashboard
- Soft-delete a monitor (preserves history)

### Automated Checking

- A dispatcher runs every minute and enqueues a check job for every due monitor
- A pool of worker processes consumes the queue and executes the HTTP checks; capacity scales by adding workers
- Jobs are durable — a worker crash or deploy retries unfinished checks rather than dropping them
- Logs every check result (status, response code, response time, error message)
- Tracks consecutive failures; resets count on recovery

### Alerting

- A state change (down or recovery) emits an event; notification channels consume it independently of the checker
- Email and Slack channels on downtime and recovery
- No duplicate alerts — one alert per incident (tracked via is_alerted flag)

### History & Status

- Per-monitor check log showing status, response code, response time, and timestamp
- Uptime trends and response-time graphs, served from time-series rollups
- Public per-account status page, served from cache (no auth, high read volume)

## Scope

### In Scope

- URL monitoring via HTTP GET requests (public URLs only)
- Preset check intervals (no free-form input)
- Distributed check execution: dispatcher + durable queue + worker pool
- Email **and Slack** notifications on downtime/recovery (each is the forcing requirement for event-driven fan-out)
- Check history per monitor, plus uptime/response-time graphs from rollups (forcing requirement for time-series aggregation)
- Public status page per account (forcing requirement for read-path caching)
- User auth via Clerk

Each scope item above beyond the basic MVP exists because it forces a system
design concept we want to learn. See `system-design-roadmap.md` for the mapping.

### Out of Scope

- SSL certificate or DNS monitoring
- Keyword / response body checks
- SMS / generic webhook notification channels
- Custom HTTP methods or headers
- Monitor grouping (post-MVP)

### Deliberately refused (anti-cargo-cult)

These are infrastructure choices we explicitly do **not** make, because no
requirement forces them. Refusing them is part of the design:

- DB sharding / multi-region (one partitioned Postgres is enough)
- Kafka (Redis Streams / BullMQ fits this event volume)
- Microservices beyond `api` + `worker`
- CQRS / event sourcing

## Success Criteria

1. A signed-in user can create a monitor and see it appear on the dashboard
2. The dispatcher enqueues a check for every due monitor every minute, and workers execute them without manual intervention
3. Running multiple workers does not double-check any monitor; a worker crash or deploy retries unfinished checks instead of dropping them
4. A user receives an alert (email and Slack) after N consecutive failures and no duplicate alert until recovery
5. A user can view the full check history and uptime/response-time graphs for any monitor
6. The dashboard and public status page render without running aggregates over the full check history
7. A deleted monitor no longer receives checks but its history remains intact