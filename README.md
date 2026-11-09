# TMK Portal

One place for every TMK project, business and venture: progress tracking, time distribution,
a performance dashboard and reminders with notifications on your phone or computer.

## What's in it

| Page | What it does |
| --- | --- |
| **Today** | Hours logged today/this week, overdue and due-soon tasks across all projects, stalled projects, one-click timer |
| **Projects** | Cards with status, progress (% of tasks and milestones done), open/overdue counts and 30-day hours. Each project page has tasks, milestones, links, documents, and its time log |
| **Time** | Hours per project for 7/30/90 days, manual time entry, full entry list |
| **Performance** | Hours and tasks completed per week (8 weeks), per-project progress and last activity |
| **Reminders** | Daily brief + custom reminders by time and weekday, push notifications, notification inbox |

A project counts as **stalled** when it is `active` or `building` and has had no task or time activity for 7 days.

## Deploy on Render

1. Render dashboard → **New → Blueprint** → select this repository. It creates the web service and Postgres database from `render.yaml`.
2. When asked, set **`PORTAL_PASSWORD`**, the password you'll sign in with.
3. Open the service URL, sign in, then go to **Reminders → Enable notifications** on each device.
   On iPhone/iPad, first add the portal to your home screen (Share → Add to Home Screen) and open it from there.

The database tables, the seven starting projects (`server/seed/projects.json`), the session secret and the
push keys are all created automatically on first start.

**Cost:** `render.yaml` uses the Starter web service and the smallest paid database. Free web services
sleep when idle, so reminders would be late or missed; free databases are deleted after about 30 days.

## Run locally

```sh
npm install
DATABASE_URL=postgres://localhost/tmk_portal PORTAL_PASSWORD=change-me npm run dev
# open http://localhost:3000
```

## Environment variables

| Name | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string (set automatically by the Blueprint) |
| `PORTAL_PASSWORD` | yes | Sign-in password |
| `SESSION_SECRET` | no | Generated and stored in the database if unset |
| `PGSSL` | no | Set to `1` if your database needs TLS and the URL has no `sslmode=require` |
| `PUSH_CONTACT` | no | `mailto:` or `https:` contact for push services; defaults to the Render URL |

## Layout

```
public/            static frontend (no build step)
server/index.js    Express app and API
server/schema.sql  tables (applied on every start; idempotent)
server/notify.js   reminder scheduler and web push
server/queries.js  dashboard and performance queries
```
