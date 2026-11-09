import { readFile } from "node:fs/promises";
import pg from "pg";

// Return DATE columns as "YYYY-MM-DD" strings instead of midnight-UTC Date objects.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

// Render's internal URL needs no TLS; its external URL (and most hosted DBs) do.
const ssl = /sslmode=require/.test(url) || process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined;
export const pool = new pg.Pool({ connectionString: url, ssl });

export const q = (text, params) => pool.query(text, params);

export async function getSetting(key, fallback = null) {
  const { rows } = await q("select value from settings where key = $1", [key]);
  return rows[0] ? rows[0].value : fallback;
}

export async function setSetting(key, value) {
  await q(
    "insert into settings(key, value) values ($1, $2) on conflict (key) do update set value = excluded.value",
    [key, JSON.stringify(value)]
  );
}

export async function migrate() {
  await q(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));

  // Seed projects that don't exist yet; never overwrite edits made in the portal.
  const seed = JSON.parse(await readFile(new URL("./seed/projects.json", import.meta.url), "utf8"));
  for (const [i, p] of seed.projects.entries()) {
    await q(
      `insert into projects (id, name, type, status, description, tags, links, documents, integrations, sort)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (id) do nothing`,
      [p.id, p.name, p.type || "", [].concat(p.status || []), p.description || "", p.tags || [],
       JSON.stringify(p.links || []), JSON.stringify(p.documents || []), JSON.stringify(p.integrations || {}), i]
    );
  }

  const { rowCount } = await q("select 1 from reminders where kind = 'daily_brief'");
  if (!rowCount) {
    await q("insert into reminders (kind, title, time_of_day) values ('daily_brief', 'Daily brief', '08:00')");
  }
}
