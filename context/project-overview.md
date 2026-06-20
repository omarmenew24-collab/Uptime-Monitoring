# Uptime Monitor

## Overview

Uptime Monitor is a web application that checks whether registered websites are online. Users add a URL, set a check interval, and the system periodically sends a request to that URL. If the site stops responding, the user gets notified. A dashboard shows current status, response times, and downtime history for all monitored sites.

## Goals

1. Let authenticated users register and manage URLs to monitor.
2. Run automated checks on a configurable schedule per monitor.
3. Detect failures and notify the user when a site goes down.
4. Log every check result for history and reporting.
5. Display uptime percentage, response times, and downtime events on a dashboard.

## Core User Flow

1. User signs in.
2. User adds a URL to monitor and sets a check interval.
3. The system starts running scheduled checks against that URL.
4. Each check result is logged (status, response time, timestamp).
5. If consecutive failures exceed the threshold, the user is notified.
6. User views the dashboard to see current status and check history.
7. User can pause, edit, or delete a monitor at any time.

## Features

### Authentication and Monitors

- User sign-in and route protection.
- Users can create, edit, pause, and delete monitors.
- Each monitor belongs to a user.
- Monitor fields: URL, check interval (minutes), failure threshold, active/paused state.

### Scheduled Checking

- A cron job runs on a schedule and sends an HTTP GET request to each active monitor's URL.
- Each check records: status (up/down/timeout), HTTP response code, response time in ms, and timestamp.
- Timeouts (no response within 5 seconds) count as a failure.
- After each failure, the monitor's `consecutive_failures` counter increments.
- On recovery, the counter resets to zero.

### Failure Detection and Notification

- When `consecutive_failures` reaches `failure_threshold`, a notification is triggered.
- Notification channel: email (V1).
- One notification per incident — no repeated alerts for the same ongoing outage.
- A recovery notification is sent when the site comes back up.

### Dashboard

- List of all monitors with current status (up / down / paused).
- Per-monitor detail: uptime percentage, average response time, recent check history.
- Downtime log: when it went down, how long it was down, when it recovered.

## Database Schema

### `users`
| Field | Type | Notes |
|---|---|---|
| id | UUID | Primary key |
| email | VARCHAR | Unique |
| password_hash | VARCHAR | |
| created_at | TIMESTAMP | |

### `monitors`
| Field | Type | Notes |
|---|---|---|
| id | UUID | Primary key |
| user_id | UUID | Foreign key → users |
| url | VARCHAR | The URL to check |
| interval_minutes | INTEGER | How often to check |
| failure_threshold | INTEGER | Failures before notification |
| consecutive_failures | INTEGER | Current failure streak |
| is_active | BOOLEAN | Paused or running |
| is_deleted | BOOLEAN | Soft delete |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

### `check_logs`
| Field | Type | Notes |
|---|---|---|
| id | UUID | Primary key |
| monitor_id | UUID | Foreign key → monitors |
| status | VARCHAR | 'up', 'down', 'timeout' |
| http_status_code | INTEGER | e.g. 200, 500, null on timeout |
| response_time_ms | INTEGER | null on timeout |
| message | TEXT | Error message if any |
| checked_at | TIMESTAMP | When the check ran |

## Tech Stack

- **Frontend:** React
- **Backend:** Node.js + Express
- **Database:** PostgreSQL
- **DB Access:** Raw SQL via `pg`, migrations via `node-pg-migrate`
- **Scheduling:** Node cron library (to be confirmed)
- **Key packages:** express, cors, helmet, dotenv, pg, node-pg-migrate, nodemailer

## Scope

### In Scope

- User authentication and route protection
- Monitor creation, editing, pausing, and deletion
- Scheduled HTTP checks via cron job
- Check result logging (status, response time, timestamp)
- Consecutive failure tracking and threshold logic
- Email notification on failure and recovery
- Dashboard: monitor list, status, uptime %, response time, downtime log

### Out of Scope

- SMS or Slack notifications (V1 is email only)
- Multiple users per monitor / team accounts
- Public status pages
- Billing and subscription
- Mobile app
- Checks beyond HTTP GET (e.g. ping, port checks, keyword match)

## Success Criteria

1. A signed-in user can add a URL and have it checked automatically on schedule.
2. A failed check is logged correctly with status, code, response time, and timestamp.
3. When failures hit the threshold, the user receives an email notification.
4. When the site recovers, a recovery email is sent and the counter resets.
5. The dashboard shows accurate uptime percentage and check history per monitor.
6. All data is stored correctly across the `monitors` and `check_logs` tables.