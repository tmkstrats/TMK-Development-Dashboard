import express from "express";
import { migrate, pool, q, setSetting } from "./db.js";
import { initAuth, isSignedIn, login, logout, requireAuth } from "./auth.js";
import { initPush, notify, startScheduler, vapidPublicKey } from "./notify.js";
import { performance, projectsWithStats, timeByProject, timezone, today } from "./queries.js";

await migrate();
await initAuth();
await initPush();

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(express.static(new URL("../public", import.meta.url).pathname));

app.get("/healthz", (_req, res) => res.send("ok"));
app.post("/api/login", login);
app.post("/api/logout", logout);
app.get("/api/me", (req, res) => res.json({ signedIn: isSignedIn(req) }));

const api = express.Router();
api.use(requireAuth);
app.use("/api", api);

class BadRequest extends Error {}
const str = (v, name, { optional = false, max = 2000 } = {}) => {
  if (v == null || v === "") {
    if (optional) return null;
    throw new BadRequest(`${name} is required`);
  }
  if (typeof v !== "string" || v.length > max) throw new BadRequest(`${name} is invalid`);
  return v.trim();
};
const date = (v, name) => {
  if (v == null || v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadRequest(`${name} must be YYYY-MM-DD`);
  return v;
};
const one = (rows, res) => (rows[0] ? res.json(rows[0]) : res.status(404).json({ error: "Not found" }));
const STATUSES = ["active", "building", "paused", "idea", "archived"];

// --- Settings -------------------------------------------------------------
api.get("/settings", async (_req, res) => res.json({ timezone: await timezone(), vapidPublicKey: vapidPublicKey() }));
api.put("/settings", async (req, res) => {
  const tz = str(req.body.timezone, "timezone", { max: 64 });
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { throw new BadRequest("Unknown time zone"); }
  await setSetting("timezone", tz);
  res.json({ timezone: tz });
});

// --- Dashboard ------------------------------------------------------------
api.get("/today", async (_req, res) => res.json(await today(await timezone())));
api.get("/performance", async (req, res) => {
  const weeks = Math.min(Math.max(Number(req.query.weeks) || 8, 1), 52);
  const tz = await timezone();
  const [series, projects] = await Promise.all([performance(tz, weeks), projectsWithStats(tz)]);
  res.json({ weeks: series, projects });
});

// --- Projects -------------------------------------------------------------
api.get("/projects", async (_req, res) => res.json(await projectsWithStats(await timezone())));

function projectFields(b) {
  const out = {};
  if ("name" in b) out.name = str(b.name, "name", { max: 120 });
  if ("type" in b) out.type = str(b.type, "type", { optional: true, max: 60 }) || "";
  if ("description" in b) out.description = str(b.description, "description", { optional: true }) || "";
  if ("status" in b) {
    if (!Array.isArray(b.status) || b.status.some((s) => !STATUSES.includes(s))) throw new BadRequest("status is invalid");
    out.status = b.status;
  }
  if ("tags" in b) {
    if (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== "string")) throw new BadRequest("tags is invalid");
    out.tags = b.tags.map((t) => t.trim()).filter(Boolean);
  }
  for (const k of ["links", "documents"]) {
    if (!(k in b)) continue;
    if (!Array.isArray(b[k]) || b[k].some((l) => typeof l?.label !== "string" || !/^https?:\/\//.test(l?.url || ""))) {
      throw new BadRequest(`${k} must be a list of { label, url } with http(s) URLs`);
    }
    out[k] = JSON.stringify(b[k].map(({ label, url }) => ({ label, url })));
  }
  return out;
}

api.post("/projects", async (req, res) => {
  const f = projectFields({ status: [], ...req.body });
  if (!f.name) throw new BadRequest("name is required");
  const id = f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `project-${Date.now()}`;
  const cols = ["id", "sort", ...Object.keys(f)];
  const { rows } = await q(
    `insert into projects (${cols.join(", ")})
     values ($1, (select coalesce(max(sort), 0) + 1 from projects), ${Object.keys(f).map((_, i) => `$${i + 2}`).join(", ")})
     returning *`,
    [id, ...Object.values(f)]
  );
  res.status(201).json(rows[0]);
});

api.patch("/projects/:id", async (req, res) => {
  const f = projectFields(req.body);
  const keys = Object.keys(f);
  if (!keys.length) throw new BadRequest("Nothing to update");
  const { rows } = await q(
    `update projects set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1 returning *`,
    [req.params.id, ...Object.values(f)]
  );
  one(rows, res);
});

// --- Tasks & milestones ---------------------------------------------------
api.get("/projects/:id/tasks", async (req, res) => {
  const { rows } = await q(
    "select * from tasks where project_id = $1 order by done_at is not null, due_date nulls last, id",
    [req.params.id]
  );
  res.json(rows);
});

api.post("/tasks", async (req, res) => {
  const kind = req.body.kind === "milestone" ? "milestone" : "task";
  const { rows } = await q(
    "insert into tasks (project_id, kind, title, due_date) values ($1, $2, $3, $4) returning *",
    [str(req.body.project_id, "project_id", { max: 120 }), kind, str(req.body.title, "title", { max: 300 }), date(req.body.due_date, "due_date")]
  );
  res.status(201).json(rows[0]);
});

api.patch("/tasks/:id", async (req, res) => {
  const sets = [];
  const vals = [req.params.id];
  const add = (sql, v) => { vals.push(v); sets.push(sql.replace("?", `$${vals.length}`)); };
  if ("title" in req.body) add("title = ?", str(req.body.title, "title", { max: 300 }));
  if ("due_date" in req.body) add("due_date = ?", date(req.body.due_date, "due_date"));
  if ("done" in req.body) sets.push(req.body.done ? "done_at = coalesce(done_at, now())" : "done_at = null");
  if (!sets.length) throw new BadRequest("Nothing to update");
  const { rows } = await q(`update tasks set ${sets.join(", ")} where id = $1 returning *`, vals);
  one(rows, res);
});

api.delete("/tasks/:id", async (req, res) => {
  await q("delete from tasks where id = $1", [req.params.id]);
  res.status(204).end();
});

// --- Time tracking --------------------------------------------------------
const days = (req) => Math.min(Math.max(Number(req.query.days) || 30, 1), 365);

api.get("/time", async (req, res) => {
  const { rows } = await q(
    `select e.*, p.name as project_name from time_entries e join projects p on p.id = e.project_id
      where e.started_at > now() - make_interval(days => $1::int) order by e.started_at desc limit 200`,
    [days(req)]
  );
  res.json(rows);
});
api.get("/time/summary", async (req, res) => res.json(await timeByProject(days(req))));

api.post("/time/start", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("update time_entries set ended_at = now() where ended_at is null");
    const { rows } = await client.query(
      "insert into time_entries (project_id, started_at, note) values ($1, now(), $2) returning *",
      [str(req.body.project_id, "project_id", { max: 120 }), str(req.body.note, "note", { optional: true, max: 500 }) || ""]
    );
    await client.query("commit");
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
});

api.post("/time/stop", async (_req, res) => {
  const { rows } = await q("update time_entries set ended_at = now() where ended_at is null returning *");
  res.json(rows[0] || null);
});

// Manual entry: a date plus hours, or explicit start/end timestamps.
api.post("/time", async (req, res) => {
  const b = req.body;
  let start, end;
  if (b.date) {
    const hours = Number(b.hours);
    if (!(hours > 0 && hours <= 24)) throw new BadRequest("hours must be between 0 and 24");
    const tz = await timezone();
    const { rows } = await q("select ($1::date + time '09:00') at time zone $2 as s", [date(b.date, "date"), tz]);
    start = rows[0].s;
    end = new Date(start.getTime() + hours * 3_600_000);
  } else {
    start = new Date(b.started_at);
    end = new Date(b.ended_at);
    if (isNaN(start) || isNaN(end) || end < start) throw new BadRequest("started_at/ended_at are invalid");
  }
  const { rows } = await q(
    "insert into time_entries (project_id, started_at, ended_at, note) values ($1, $2, $3, $4) returning *",
    [str(b.project_id, "project_id", { max: 120 }), start, end, str(b.note, "note", { optional: true, max: 500 }) || ""]
  );
  res.status(201).json(rows[0]);
});

api.delete("/time/:id", async (req, res) => {
  await q("delete from time_entries where id = $1", [req.params.id]);
  res.status(204).end();
});

// --- Reminders & notifications -------------------------------------------
api.get("/reminders", async (_req, res) => {
  const { rows } = await q(
    "select r.*, to_char(r.time_of_day, 'HH24:MI') as time_of_day from reminders r order by r.kind = 'daily_brief' desc, r.time_of_day, r.id"
  );
  res.json(rows);
});

function reminderFields(b) {
  const out = {};
  if ("title" in b) out.title = str(b.title, "title", { max: 200 });
  if ("body" in b) out.body = str(b.body, "body", { optional: true, max: 500 }) || "";
  if ("project_id" in b) out.project_id = str(b.project_id, "project_id", { optional: true, max: 120 });
  if ("time_of_day" in b) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time_of_day || "")) throw new BadRequest("time_of_day must be HH:MM");
    out.time_of_day = b.time_of_day;
  }
  if ("days" in b) {
    if (!Array.isArray(b.days) || !b.days.length || b.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new BadRequest("days is invalid");
    out.days = [...new Set(b.days)];
  }
  if ("enabled" in b) out.enabled = !!b.enabled;
  return out;
}

api.post("/reminders", async (req, res) => {
  const f = reminderFields(req.body);
  if (!f.title || !f.time_of_day) throw new BadRequest("title and time_of_day are required");
  const keys = Object.keys(f);
  const { rows } = await q(
    `insert into reminders (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    Object.values(f)
  );
  res.status(201).json(rows[0]);
});

api.patch("/reminders/:id", async (req, res) => {
  const f = reminderFields(req.body);
  const keys = Object.keys(f);
  if (!keys.length) throw new BadRequest("Nothing to update");
  // A changed time should be able to fire again today.
  const reset = "time_of_day" in f || "days" in f ? ", last_sent_on = null" : "";
  const { rows } = await q(
    `update reminders set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}${reset} where id = $1 returning *`,
    [req.params.id, ...Object.values(f)]
  );
  one(rows, res);
});

api.delete("/reminders/:id", async (req, res) => {
  await q("delete from reminders where id = $1 and kind = 'custom'", [req.params.id]);
  res.status(204).end();
});

api.get("/notifications", async (_req, res) => {
  const { rows } = await q("select * from notifications order by created_at desc limit 50");
  res.json(rows);
});
api.post("/notifications/read", async (_req, res) => {
  await q("update notifications set read_at = now() where read_at is null");
  res.status(204).end();
});

api.post("/push/subscribe", async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint) || !keys?.p256dh || !keys?.auth) throw new BadRequest("Invalid subscription");
  await q(
    "insert into push_subscriptions (endpoint, keys) values ($1, $2) on conflict (endpoint) do update set keys = excluded.keys",
    [endpoint, JSON.stringify({ p256dh: keys.p256dh, auth: keys.auth })]
  );
  res.status(201).json({ ok: true });
});
api.post("/push/test", async (_req, res) => {
  await notify("Test notification", "Portal notifications are working.");
  res.json({ ok: true });
});

// --- Errors ---------------------------------------------------------------
app.use((err, _req, res, _next) => {
  if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
  if (err.code === "23503") return res.status(400).json({ error: "Unknown project" });
  if (err.code === "23505") return res.status(409).json({ error: "Already exists" });
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`TMK Portal listening on :${port}`));
startScheduler();
