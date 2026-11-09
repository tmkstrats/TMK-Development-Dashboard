-- Idempotent: runs on every boot.

create table if not exists settings (
  key   text primary key,
  value jsonb not null
);

create table if not exists projects (
  id           text primary key,
  name         text not null,
  type         text not null default '',
  status       text[] not null default '{}',
  description  text not null default '',
  tags         text[] not null default '{}',
  links        jsonb not null default '[]',
  documents    jsonb not null default '[]',
  integrations jsonb not null default '{}',
  sort         int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Tasks and milestones share one table; kind distinguishes them.
create table if not exists tasks (
  id          serial primary key,
  project_id  text not null references projects(id) on delete cascade,
  kind        text not null default 'task' check (kind in ('task', 'milestone')),
  title       text not null,
  due_date    date,
  done_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists tasks_project_idx on tasks(project_id);

create table if not exists time_entries (
  id          serial primary key,
  project_id  text not null references projects(id) on delete cascade,
  started_at  timestamptz not null,
  ended_at    timestamptz,
  note        text not null default '',
  check (ended_at is null or ended_at >= started_at)
);
create index if not exists time_entries_started_idx on time_entries(started_at);
-- At most one running timer.
create unique index if not exists time_entries_one_running on time_entries((true)) where ended_at is null;

create table if not exists reminders (
  id           serial primary key,
  kind         text not null default 'custom' check (kind in ('custom', 'daily_brief')),
  title        text not null,
  body         text not null default '',
  project_id   text references projects(id) on delete set null,
  time_of_day  time not null,
  days         smallint[] not null default '{0,1,2,3,4,5,6}', -- 0 = Sunday
  enabled      boolean not null default true,
  last_sent_on date
);

create table if not exists notifications (
  id         serial primary key,
  title      text not null,
  body       text not null default '',
  url        text not null default '/',
  created_at timestamptz not null default now(),
  read_at    timestamptz
);

create table if not exists push_subscriptions (
  endpoint   text primary key,
  keys       jsonb not null,
  created_at timestamptz not null default now()
);
