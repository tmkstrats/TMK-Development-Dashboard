import webpush from "web-push";
import { q, getSetting, setSetting } from "./db.js";
import { briefText, timezone, today } from "./queries.js";

// A reminder that comes due while the server is down still fires if it restarts within this window.
const CATCH_UP_MINUTES = 120;

let publicKey;

export async function initPush() {
  let keys = await getSetting("vapid");
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    await setSetting("vapid", keys);
  }
  const subject = process.env.RENDER_EXTERNAL_URL || process.env.PUSH_CONTACT || "mailto:portal@example.com";
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  publicKey = keys.publicKey;
}

export const vapidPublicKey = () => publicKey;

// Stores the notification for the in-portal inbox and pushes it to every subscribed device.
export async function notify(title, body, url = "/#today") {
  await q("insert into notifications (title, body, url) values ($1, $2, $3)", [title, body, url]);
  const { rows } = await q("select endpoint, keys from push_subscriptions");
  const payload = JSON.stringify({ title, body, url });
  await Promise.all(
    rows.map((s) =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload).catch(async (err) => {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await q("delete from push_subscriptions where endpoint = $1", [s.endpoint]);
        } else {
          console.error("push failed:", err.statusCode || err.message);
        }
      })
    )
  );
}

function localNow(tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
    }).formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
  };
}

async function tick() {
  const tz = await timezone();
  const now = localNow(tz);
  const { rows } = await q(
    `select r.*, extract(hour from r.time_of_day) * 60 + extract(minute from r.time_of_day) as at_minutes,
            p.name as project_name
       from reminders r left join projects p on p.id = r.project_id
      where r.enabled and $1 = any(r.days) and (r.last_sent_on is null or r.last_sent_on < $2::date)`,
    [now.dow, now.date]
  );
  for (const r of rows) {
    const late = now.minutes - Number(r.at_minutes);
    if (late < 0) continue;
    await q("update reminders set last_sent_on = $1 where id = $2", [now.date, r.id]);
    if (late > CATCH_UP_MINUTES) continue;
    if (r.kind === "daily_brief") {
      await notify(r.title, briefText(await today(tz)));
    } else {
      const body = [r.project_name, r.body].filter(Boolean).join(": ");
      await notify(r.title, body, r.project_id ? `/#project/${r.project_id}` : "/#today");
    }
  }
}

export function startScheduler() {
  const run = () => tick().catch((err) => console.error("reminder tick failed:", err));
  run();
  setInterval(run, 30_000);
}
