import { q, getSetting } from "./db.js";

export const STALL_DAYS = 7;
export const timezone = () => getSetting("timezone", "UTC");

// Hours of an entry; a running timer counts up to now.
const HOURS = "extract(epoch from coalesce(e.ended_at, now()) - e.started_at) / 3600";

export async function projectsWithStats(tz) {
  const { rows } = await q(
    `select p.*,
            coalesce(t.total, 0)::int   as total_tasks,
            coalesce(t.done, 0)::int    as done_tasks,
            coalesce(t.overdue, 0)::int as overdue_tasks,
            coalesce(h.hours_30d, 0)::float as hours_30d,
            greatest(p.created_at, p.updated_at, t.last_touch, h.last_touch) as last_activity
       from projects p
       left join (
         select project_id, count(*) as total, count(done_at) as done,
                count(*) filter (where done_at is null and due_date < (now() at time zone $1)::date) as overdue,
                max(greatest(created_at, done_at)) as last_touch
           from tasks group by project_id
       ) t on t.project_id = p.id
       left join (
         select e.project_id,
                sum(${HOURS}) filter (where e.started_at > now() - interval '30 days') as hours_30d,
                max(coalesce(e.ended_at, now())) as last_touch
           from time_entries e group by e.project_id
       ) h on h.project_id = p.id
      order by p.sort, p.name`,
    [tz]
  );
  return rows.map((p) => ({
    ...p,
    progress: p.total_tasks ? Math.round((100 * p.done_tasks) / p.total_tasks) : null,
    stalled: isTrackable(p) && Date.now() - new Date(p.last_activity) > STALL_DAYS * 86_400_000,
  }));
}

// Ideas, paused and archived projects aren't expected to move, so they never count as stalled.
const isTrackable = (p) => p.status.some((s) => s === "active" || s === "building");

export async function today(tz) {
  const [tasks, running, hours, projects] = await Promise.all([
    q(
      `select t.*, p.name as project_name,
              case when t.due_date < (now() at time zone $1)::date then 'overdue'
                   when t.due_date = (now() at time zone $1)::date then 'today'
                   else 'upcoming' end as bucket
         from tasks t join projects p on p.id = t.project_id
        where t.done_at is null and t.due_date <= (now() at time zone $1)::date + 7
        order by t.due_date, t.id`,
      [tz]
    ),
    q(`select e.*, p.name as project_name from time_entries e join projects p on p.id = e.project_id where e.ended_at is null`),
    q(
      `select coalesce(sum(${HOURS}) filter (where (e.started_at at time zone $1)::date = (now() at time zone $1)::date), 0)::float as today,
              coalesce(sum(${HOURS}) filter (where date_trunc('week', e.started_at at time zone $1) = date_trunc('week', now() at time zone $1)), 0)::float as week
         from time_entries e`,
      [tz]
    ),
    projectsWithStats(tz),
  ]);
  const by = (b) => tasks.rows.filter((t) => t.bucket === b);
  return {
    timezone: tz,
    overdue: by("overdue"),
    dueToday: by("today"),
    upcoming: by("upcoming"),
    running: running.rows[0] || null,
    hours: hours.rows[0],
    stalled: projects.filter((p) => p.stalled).map(({ id, name, last_activity }) => ({ id, name, last_activity })),
  };
}

export async function performance(tz, weeks) {
  const { rows } = await q(
    `with w as (
       select generate_series(date_trunc('week', now() at time zone $1) - ($2::int - 1) * interval '1 week',
                              date_trunc('week', now() at time zone $1), interval '1 week') as wk
     )
     select w.wk::date as week,
            coalesce((select sum(${HOURS}) from time_entries e
                       where date_trunc('week', e.started_at at time zone $1) = w.wk), 0)::float as hours,
            (select count(*) from tasks t
              where t.done_at is not null and date_trunc('week', t.done_at at time zone $1) = w.wk)::int as tasks_done
       from w order by w.wk`,
    [tz, weeks]
  );
  return rows;
}

export async function timeByProject(days) {
  const { rows } = await q(
    `select p.id, p.name, coalesce(sum(${HOURS}), 0)::float as hours
       from projects p
       left join time_entries e on e.project_id = p.id and e.started_at > now() - make_interval(days => $1::int)
      group by p.id order by hours desc, p.sort`,
    [days]
  );
  return rows;
}

export function briefText(t) {
  const parts = [];
  if (t.overdue.length) parts.push(`${t.overdue.length} overdue`);
  if (t.dueToday.length) parts.push(`${t.dueToday.length} due today`);
  if (t.stalled.length) parts.push(`stalled: ${t.stalled.map((p) => p.name).join(", ")}`);
  parts.push(`${t.hours.week.toFixed(1)}h logged this week`);
  return parts.join(" · ");
}
