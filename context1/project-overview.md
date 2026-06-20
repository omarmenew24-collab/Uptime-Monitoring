# Uptime Monitor

## Overview

A web application that monitors website uptime by periodically sending HTTP
requests to registered URLs and alerting users when their sites go down.
Built for developers and small teams who need reliable, lightweight uptime
visibility without the complexity of enterprise monitoring tools.

## Goals

1. A user can register URLs and receive email alerts within one check cycle of a site going down
2. The system reliably executes checks on schedule with no missed runs
3. Users can review the full check history for any monitor from the dashboard

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

- Single cron job runs every minute and checks all monitors due for a check
- Logs every check result (status, response code, response time, error message)
- Tracks consecutive failures; resets count on recovery

### Alerting

- Email notification sent when consecutive failures exceed the threshold
- No duplicate alerts — one alert per incident (tracked via is_alerted flag)

### History

- Per-monitor check log showing status, response code, response time, and timestamp

## Scope

### In Scope

- URL monitoring via HTTP GET requests (public URLs only)
- Preset check intervals (no free-form input)
- Email notifications on downtime
- Check history per monitor
- User auth via Clerk

### Out of Scope

- SSL certificate or DNS monitoring
- Response time graphs or analytics
- Keyword / response body checks
- Non-email notification channels (SMS, Slack, webhook)
- Custom HTTP methods or headers
- Public status pages
- Monitor grouping (post-MVP)

## Success Criteria

1. A signed-in user can create a monitor and see it appear on the dashboard
2. The cron job runs a check for every due monitor every minute without manual intervention
3. A user receives an email alert after N consecutive failures and no duplicate alert until recovery
4. A user can view the full check history for any monitor
5. A deleted monitor no longer receives checks but its history remains intact