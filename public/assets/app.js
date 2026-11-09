const STATUSES = ["active", "building", "paused", "idea", "archived"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const state = { projects: [], settings: null, today: null, filter: { type: "", status: "", q: "" } };

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "style") node.style.cssText = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

class AuthError extends Error {}
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch("/api" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== "/login") throw new AuthError();
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const statusesOf = (p) => [].concat(p.status || []).filter(Boolean);
const fmtHours = (h) => (h >= 10 ? h.toFixed(0) : h.toFixed(1)) + "h";
const tz = () => state.settings?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
const todayISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: tz() }).format(new Date());
const fmtDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fmtDateTime = (ts) => new Date(ts).toLocaleString(undefined, { timeZone: tz(), month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function ago(ts) {
  const d = Math.floor((Date.now() - new Date(ts)) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}
function duration(start, end) {
  const s = Math.max(0, Math.floor(((end ? new Date(end) : new Date()) - new Date(start)) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
}
const projectOptions = (selected) => state.projects.map((p) => el("option", { value: p.id, selected: p.id === selected }, p.name));

function toast(err) {
  if (err instanceof AuthError) return showLogin();
  console.error(err);
  alert(err.message || String(err));
}
// Wraps an async handler so failures surface instead of vanishing.
const act = (fn) => async (e) => {
  e?.preventDefault?.();
  try { await fn(e); } catch (err) { toast(err); }
};

// ---------- tooltip ----------
const tip = $("tooltip");
document.addEventListener("pointerover", (e) => {
  const t = e.target.closest("[data-tip]");
  if (!t) return (tip.hidden = true);
  tip.textContent = t.dataset.tip;
  tip.hidden = false;
});
document.addEventListener("pointermove", (e) => {
  if (tip.hidden) return;
  const x = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8);
  tip.style.left = x + "px";
  tip.style.top = e.clientY - tip.offsetHeight - 10 + "px";
});

// ---------- theme ----------
function initTheme() {
  try {
    const saved = localStorage.getItem("theme");
    if (saved) document.documentElement.dataset.theme = saved;
  } catch {}
  $("theme").addEventListener("click", () => {
    const current = document.documentElement.dataset.theme;
    const dark = current ? current === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
  });
}

// ---------- auth ----------
function showLogin() {
  $("app").hidden = true;
  $("login").hidden = false;
}
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  try {
    await api("/login", { method: "POST", body: { password: e.target.password.value } });
    e.target.reset();
    await boot();
  } catch (err) {
    $("loginError").textContent = err.message;
  }
});
$("logout").addEventListener("click", act(async () => {
  await api("/logout", { method: "POST" });
  showLogin();
}));

// ---------- shared chrome: timer pill + bell ----------
let pillTimer;
function renderChrome() {
  const run = state.today?.running;
  const pill = $("timerPill");
  clearInterval(pillTimer);
  pill.hidden = !run;
  if (run) {
    const draw = () => (pill.textContent = `■ ${run.project_name} · ${duration(run.started_at)}`);
    draw();
    pillTimer = setInterval(draw, 1000);
    pill.onclick = act(async () => { await api("/time/stop", { method: "POST" }); await refresh(); });
    pill.title = "Stop timer";
  }
}
async function refreshBell() {
  const list = await api("/notifications");
  const unread = list.filter((n) => !n.read_at).length;
  $("bellCount").hidden = !unread;
  $("bellCount").textContent = unread;
  return list;
}

async function loadCore() {
  [state.projects, state.today] = await Promise.all([api("/projects"), api("/today")]);
  renderChrome();
}
async function refresh() {
  await loadCore();
  await route();
}

async function startTimer(projectId) {
  await api("/time/start", { method: "POST", body: { project_id: projectId } });
  await refresh();
}

// ---------- reusable pieces ----------
function badges(p) {
  const s = statusesOf(p);
  return el("div", { class: "badges" }, s.length ? s.map((x) => el("span", { class: `badge ${x}` }, x)) : el("span", { class: "badge unset" }, "unset"));
}
function meter(pct, label) {
  return el("div", { class: "meter", "aria-label": label },
    el("div", { class: "track" }, el("div", { class: "fill", style: `width:${pct || 0}%` })),
    el("span", {}, pct == null ? "no tasks" : `${pct}%`));
}
function linkList(items) {
  return el("div", { class: "links" }, items.map((l) => el("a", { href: l.url, target: "_blank", rel: "noopener" }, l.label + " ↗")));
}
function taskItem(t, { showProject = false, onChange }) {
  const overdue = !t.done_at && t.due_date && t.due_date < todayISO();
  return el("li", { class: t.done_at ? "done" : "" },
    el("input", {
      type: "checkbox", checked: !!t.done_at, "aria-label": `Mark "${t.title}" done`,
      onchange: act(async (e) => { await api(`/tasks/${t.id}`, { method: "PATCH", body: { done: e.target.checked } }); await onChange(); }),
    }),
    el("div", { class: "grow" },
      el("div", { class: "title" }, t.kind === "milestone" ? "◆ " : "", t.title),
      el("div", { class: "meta" },
        showProject ? el("a", { href: `#project/${t.project_id}` }, t.project_name) : null,
        showProject && t.due_date ? " · " : null,
        t.due_date ? `due ${fmtDate(t.due_date)}` : null)),
    overdue ? el("span", { class: "pill overdue" }, "overdue") : null);
}

// Horizontal bars: one hue, sorted, direct value labels, hover tooltip.
function hbars(rows, { value, label, fmt }) {
  const max = Math.max(...rows.map(value), 0) || 1;
  const total = rows.reduce((s, r) => s + value(r), 0) || 1;
  return el("div", { class: "hbars" }, rows.flatMap((r) => {
    const v = value(r);
    const text = `${fmt(v)} · ${Math.round((100 * v) / total)}%`;
    return [
      el("div", { class: "label", title: label(r) }, label(r)),
      el("div", { class: "bar-row", "data-tip": `${label(r)}: ${text}` },
        el("div", { class: "bar", style: `width:${(78 * v) / max}%` }),
        el("span", { class: "value" }, v ? text : "—")),
    ];
  }));
}

// Column chart for a weekly series; labels the peak and the latest week only.
function columns(rows, { value, label, fmt, name }) {
  const max = Math.max(...rows.map(value), 0) || 1;
  const peak = rows.findIndex((r) => value(r) === max);
  return el("div", {},
    el("div", { class: "cols-chart", role: "img", "aria-label": name },
      rows.map((r, i) => el("div", { class: "col", "data-tip": `${label(r)}: ${fmt(value(r))}` },
        (i === peak || i === rows.length - 1) && value(r) ? el("b", { style: `bottom:${(100 * value(r)) / max}%` }, fmt(value(r))) : null,
        el("i", { style: `height:${(100 * value(r)) / max}%` })))),
    el("div", { class: "cols-axis" }, rows.map((r) => el("span", {}, label(r)))));
}

// ---------- views ----------
const views = {};

views.today = async () => {
  const t = state.today;
  const hasTasks = t.overdue.length + t.dueToday.length + t.upcoming.length;
  const quick = el("form", { class: "row", onsubmit: act((e) => startTimer(e.target.project.value)) },
    el("select", { name: "project", "aria-label": "Project" }, projectOptions()),
    el("button", { class: "primary", type: "submit" }, t.running ? "Switch timer" : "Start timer"));
  const section = (title, items) => items.length
    ? el("div", {}, el("h3", {}, title), el("ul", { class: "list" }, items.map((x) => taskItem(x, { showProject: true, onChange: refresh }))))
    : null;

  return [
    el("div", { class: "page-head" }, el("h1", {}, new Date().toLocaleDateString(undefined, { timeZone: tz(), weekday: "long", month: "long", day: "numeric" })), quick),
    el("div", { class: "stats" },
      el("div", { class: "stat" }, el("b", {}, fmtHours(t.hours.today)), el("span", {}, "Logged today")),
      el("div", { class: "stat" }, el("b", {}, fmtHours(t.hours.week)), el("span", {}, "This week")),
      el("div", { class: "stat" + (t.overdue.length ? " alert" : "") }, el("b", {}, String(t.overdue.length)), el("span", {}, "Overdue")),
      el("div", { class: "stat" }, el("b", {}, String(t.dueToday.length)), el("span", {}, "Due today"))),
    el("div", { class: "cols" },
      el("section", { class: "panel" },
        el("h2", { style: "margin-bottom:12px" }, "Tasks"),
        hasTasks ? [section("Overdue", t.overdue), section("Due today", t.dueToday), section("Next 7 days", t.upcoming)]
                 : el("p", { class: "empty" }, "Nothing due this week. Add tasks with due dates from a project page.")),
      el("section", { class: "panel" },
        el("h2", { style: "margin-bottom:12px" }, "Needs attention"),
        t.stalled.length
          ? el("ul", { class: "list" }, t.stalled.map((p) => el("li", {},
              el("span", { class: "flag" }, "⚠"),
              el("div", { class: "grow" }, el("a", { href: `#project/${p.id}` }, p.name), el("div", { class: "meta" }, `No activity since ${ago(p.last_activity)}`)))))
          : el("p", { class: "empty" }, "No stalled projects. Active and building projects are flagged after 7 days without a task or time entry."))),
  ];
};

views.projects = async () => {
  const f = state.filter;
  const types = [...new Set(state.projects.map((p) => p.type).filter(Boolean))].sort();
  const grid = el("section", { class: "grid" });
  const draw = () => {
    const q = f.q.toLowerCase();
    const list = state.projects.filter((p) =>
      (!f.type || p.type === f.type) && (!f.status || statusesOf(p).includes(f.status)) &&
      (!q || [p.name, p.description, p.type, ...p.tags].join(" ").toLowerCase().includes(q)));
    grid.replaceChildren(...(list.length ? list.map(projectCard) : [el("p", { class: "empty" }, "No projects match.")]));
  };
  const chips = el("div", { class: "filters" });
  const drawChips = () => chips.replaceChildren(...["", ...types].map((t) =>
    el("button", { class: "chip small", "aria-pressed": String(f.type === t), onclick: () => { f.type = t; drawChips(); draw(); } }, t || "All")));
  drawChips();
  draw();
  return [
    el("div", { class: "page-head" }, el("h1", {}, "Projects"), el("button", { class: "primary", onclick: act(newProject) }, "+ New project")),
    el("section", { class: "controls" },
      el("input", { type: "search", placeholder: "Search projects…", "aria-label": "Search projects", value: f.q, oninput: (e) => { f.q = e.target.value; draw(); } }),
      chips,
      el("select", { "aria-label": "Filter by status", onchange: (e) => { f.status = e.target.value; draw(); } },
        el("option", { value: "" }, "All statuses"), STATUSES.map((s) => el("option", { value: s, selected: f.status === s }, s)))),
    grid,
  ];
};

function projectCard(p) {
  return el("a", { class: "card", href: `#project/${p.id}` },
    el("div", { class: "card-head" }, el("div", {}, el("div", { class: "type" }, p.type), el("h2", {}, p.name)), badges(p)),
    p.description ? el("p", { class: "desc" }, p.description) : null,
    meter(p.progress, `${p.name} progress`),
    el("div", { class: "card-foot" },
      el("span", {}, `${p.total_tasks - p.done_tasks} open`, p.overdue_tasks ? ` · ${p.overdue_tasks} overdue` : ""),
      p.stalled ? el("span", { class: "flag" }, "⚠ stalled") : el("span", {}, `${fmtHours(p.hours_30d)} · 30d`)));
}

async function newProject() {
  const name = prompt("Project name");
  if (!name) return;
  const p = await api("/projects", { method: "POST", body: { name } });
  await loadCore();
  location.hash = `#project/${p.id}`;
}

views.project = async (id) => {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return el("p", { class: "empty" }, "Project not found. ", el("a", { href: "#projects" }, "Back to projects"));
  const [tasks, entries] = await Promise.all([api(`/projects/${id}/tasks`), api("/time?days=90")]);
  const mine = entries.filter((e) => e.project_id === id);
  const reload = () => refresh();

  const addTask = el("form", { class: "form", onsubmit: act(async (e) => {
    const f = e.target;
    await api("/tasks", { method: "POST", body: { project_id: id, title: f.title.value, due_date: f.due.value || null, kind: f.milestone.checked ? "milestone" : "task" } });
    await reload();
  }) },
    el("label", { class: "wide" }, "New task", el("input", { name: "title", required: true, placeholder: "What needs doing?" })),
    el("label", {}, "Due", el("input", { name: "due", type: "date" })),
    el("label", { class: "check" }, el("input", { name: "milestone", type: "checkbox" }), "Milestone"),
    el("button", { class: "primary", type: "submit" }, "Add"));

  const taskList = tasks.length
    ? el("ul", { class: "list" }, tasks.map((t) => {
        const li = taskItem(t, { onChange: reload });
        li.append(el("button", { class: "link-btn danger", "aria-label": `Delete ${t.title}`, onclick: act(async () => {
          if (!confirm(`Delete "${t.title}"?`)) return;
          await api(`/tasks/${t.id}`, { method: "DELETE" });
          await reload();
        }) }, "✕"));
        return li;
      }))
    : el("p", { class: "empty" }, "No tasks yet. Progress is the share of tasks and milestones checked off.");

  const running = state.today.running?.project_id === id;
  return [
    el("p", {}, el("a", { href: "#projects" }, "← All projects")),
    el("div", { class: "page-head" },
      el("div", {}, el("div", { class: "type" }, p.type), el("h1", {}, p.name)),
      el("div", { class: "row" }, badges(p),
        running
          ? el("button", { onclick: act(async () => { await api("/time/stop", { method: "POST" }); await reload(); }) }, "■ Stop timer")
          : el("button", { class: "primary", onclick: act(() => startTimer(id)) }, "▶ Start timer"))),
    el("div", { class: "stats" },
      el("div", { class: "stat" }, el("b", {}, p.progress == null ? "—" : p.progress + "%"), el("span", {}, "Progress")),
      el("div", { class: "stat" }, el("b", {}, String(p.total_tasks - p.done_tasks)), el("span", {}, "Open tasks")),
      el("div", { class: "stat" + (p.overdue_tasks ? " alert" : "") }, el("b", {}, String(p.overdue_tasks)), el("span", {}, "Overdue")),
      el("div", { class: "stat" }, el("b", {}, fmtHours(p.hours_30d)), el("span", {}, "Hours, last 30 days"))),
    el("div", { class: "cols" },
      el("section", { class: "panel" }, el("h2", { style: "margin-bottom:12px" }, "Tasks & milestones"), addTask, taskList),
      el("section", { class: "panel" }, el("h2", { style: "margin-bottom:12px" }, "Details"), projectEditor(p))),
    el("section", { class: "panel" },
      el("h2", { style: "margin-bottom:12px" }, "Recent time"),
      mine.length ? entriesTable(mine.slice(0, 20), { showProject: false }) : el("p", { class: "empty" }, "No time logged in the last 90 days.")),
  ];
};

function projectEditor(p) {
  const status = new Set(statusesOf(p));
  const toLines = (items) => items.map((l) => `${l.label} | ${l.url}`).join("\n");
  const fromLines = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [label, url] = line.includes("|") ? line.split("|").map((s) => s.trim()) : [line.replace(/^https?:\/\//, ""), line];
    return { label, url };
  });
  const statusButtons = el("div", { class: "days" }, STATUSES.map((s) => el("button", {
    type: "button", "aria-pressed": String(status.has(s)),
    onclick: (e) => { status.has(s) ? status.delete(s) : status.add(s); e.target.setAttribute("aria-pressed", String(status.has(s))); },
  }, s)));
  return el("form", { class: "edit-grid", onsubmit: act(async (e) => {
    const f = e.target;
    await api(`/projects/${p.id}`, { method: "PATCH", body: {
      name: f.pname.value, type: f.ptype.value, description: f.desc.value, status: [...status],
      tags: f.tags.value.split(",").map((t) => t.trim()).filter(Boolean),
      links: fromLines(f.links.value), documents: fromLines(f.docs.value),
    } });
    await refresh();
  }) },
    el("label", {}, "Name", el("input", { name: "pname", value: p.name, required: true })),
    el("label", {}, "Type", el("input", { name: "ptype", value: p.type, placeholder: "Business, Venture, Nonprofit…" })),
    el("div", {}, el("label", {}, "Status"), statusButtons),
    el("label", {}, "Description", el("textarea", { name: "desc", rows: 2 }, p.description)),
    el("label", {}, "Tags (comma separated)", el("input", { name: "tags", value: p.tags.join(", ") })),
    el("label", {}, "Links (one per line: Label | https://…)", el("textarea", { name: "links", rows: 2 }, toLines(p.links))),
    el("label", {}, "Documents (one per line: Label | https://…)", el("textarea", { name: "docs", rows: 2 }, toLines(p.documents))),
    p.links.length || p.documents.length ? linkList([...p.links, ...p.documents]) : null,
    el("div", { class: "row" }, el("button", { class: "primary", type: "submit" }, "Save")));
}

function entriesTable(entries, { showProject = true } = {}) {
  return el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, el("th", {}, "Started"), showProject ? el("th", {}, "Project") : null, el("th", {}, "Note"), el("th", { class: "num" }, "Duration"), el("th", {}))),
    el("tbody", {}, entries.map((e) => el("tr", {},
      el("td", {}, fmtDateTime(e.started_at)),
      showProject ? el("td", {}, el("a", { href: `#project/${e.project_id}` }, e.project_name)) : null,
      el("td", { class: "muted" }, e.note),
      el("td", { class: "num" }, e.ended_at ? duration(e.started_at, e.ended_at) : "running"),
      el("td", { class: "num" }, el("button", { class: "link-btn danger", "aria-label": "Delete entry", onclick: act(async () => {
        if (!confirm("Delete this time entry?")) return;
        await api(`/time/${e.id}`, { method: "DELETE" });
        await refresh();
      }) }, "✕")))))));
}

views.time = async () => {
  const range = Number(sessionStorage.getItem("timeRange")) || 30;
  const [summary, entries] = await Promise.all([api(`/time/summary?days=${range}`), api(`/time?days=${range}`)]);
  const total = summary.reduce((s, r) => s + r.hours, 0);
  const log = el("form", { class: "form", onsubmit: act(async (e) => {
    const f = e.target;
    await api("/time", { method: "POST", body: { project_id: f.project.value, date: f.date.value, hours: Number(f.hours.value), note: f.note.value } });
    await refresh();
  }) },
    el("label", {}, "Project", el("select", { name: "project" }, projectOptions())),
    el("label", {}, "Date", el("input", { name: "date", type: "date", value: todayISO(), required: true })),
    el("label", {}, "Hours", el("input", { name: "hours", type: "number", min: "0.25", max: "24", step: "0.25", required: true, style: "width:90px" })),
    el("label", { class: "wide" }, "Note", el("input", { name: "note", placeholder: "Optional" })),
    el("button", { class: "primary", type: "submit" }, "Log time"));

  return [
    el("div", { class: "page-head" }, el("h1", {}, "Time distribution"),
      el("select", { "aria-label": "Range", onchange: (e) => { sessionStorage.setItem("timeRange", e.target.value); route(); } },
        [[7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"]].map(([v, l]) => el("option", { value: v, selected: v === range }, l)))),
    el("section", { class: "panel" },
      el("h2", {}, `Hours by project · ${fmtHours(total)} total`),
      el("p", { class: "muted", style: "margin:4px 0 14px;font-size:13px" }, "Share of tracked time per project over the selected range."),
      total ? hbars(summary, { value: (r) => r.hours, label: (r) => r.name, fmt: fmtHours }) : el("p", { class: "empty" }, "No time logged in this range yet.")),
    el("section", { class: "panel" }, el("h2", { style: "margin-bottom:12px" }, "Log time manually"), log),
    el("section", { class: "panel" }, el("h2", { style: "margin-bottom:12px" }, "Entries"),
      entries.length ? entriesTable(entries) : el("p", { class: "empty" }, "No entries.")),
  ];
};

views.performance = async () => {
  const data = await api("/performance?weeks=8");
  const wk = (r) => fmtDate(r.week);
  const weeklyTable = el("details", { class: "table-view" }, el("summary", {}, "Show as table"),
    el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Week of"), el("th", { class: "num" }, "Hours"), el("th", { class: "num" }, "Tasks done"))),
      el("tbody", {}, data.weeks.map((r) => el("tr", {}, el("td", {}, wk(r)), el("td", { class: "num" }, r.hours.toFixed(1)), el("td", { class: "num" }, String(r.tasks_done)))))));

  return [
    el("div", { class: "page-head" }, el("h1", {}, "Performance"), el("span", { class: "muted" }, "Last 8 weeks")),
    el("div", { class: "cols" },
      el("section", { class: "panel" }, el("h2", { style: "margin-bottom:6px" }, "Hours logged per week"),
        columns(data.weeks, { value: (r) => r.hours, label: wk, fmt: fmtHours, name: "Hours logged per week" })),
      el("section", { class: "panel" }, el("h2", { style: "margin-bottom:6px" }, "Tasks completed per week"),
        columns(data.weeks, { value: (r) => r.tasks_done, label: wk, fmt: String, name: "Tasks completed per week" }))),
    weeklyTable,
    el("section", { class: "panel" }, el("h2", { style: "margin-bottom:12px" }, "Projects"),
      el("div", { class: "table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Project", "Status", "Progress", "Open", "Overdue", "Hours (30d)", "Last activity"].map((h, i) => el("th", { class: i >= 3 && i <= 5 ? "num" : null }, h)))),
        el("tbody", {}, data.projects.map((p) => el("tr", {},
          el("td", {}, el("a", { href: `#project/${p.id}` }, p.name)),
          el("td", {}, badges(p)),
          el("td", { style: "min-width:140px" }, meter(p.progress, `${p.name} progress`)),
          el("td", { class: "num" }, String(p.total_tasks - p.done_tasks)),
          el("td", { class: "num" }, String(p.overdue_tasks)),
          el("td", { class: "num" }, p.hours_30d.toFixed(1)),
          el("td", {}, p.stalled ? el("span", { class: "flag" }, `⚠ ${ago(p.last_activity)}`) : ago(p.last_activity)))))))),
  ];
};

// ---------- reminders & notifications ----------
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function enablePush() {
  const reg = await navigator.serviceWorker.register("/sw.js");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications were not allowed. You can change this in your browser's site settings.");
  const key = Uint8Array.from(atob(state.settings.vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  await api("/push/subscribe", { method: "POST", body: sub.toJSON() });
}

function daysPicker(selected) {
  const set = new Set(selected);
  const wrap = el("div", { class: "days" }, DAY_NAMES.map((d, i) => el("button", {
    type: "button", "aria-pressed": String(set.has(i)),
    onclick: (e) => { set.has(i) ? set.delete(i) : set.add(i); e.target.setAttribute("aria-pressed", String(set.has(i))); },
  }, d)));
  wrap.value = () => [...set].sort();
  return wrap;
}

views.reminders = async () => {
  const [reminders, notes] = await Promise.all([api("/reminders"), refreshBell()]);
  const perm = pushSupported() ? Notification.permission : "unsupported";
  const isIOS = /iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone;

  const pushPanel = el("section", { class: "panel" },
    el("h2", {}, "Notifications on this device"),
    el("p", { class: "muted", style: "font-size:14px" },
      perm === "granted" ? "This device receives portal notifications." :
      perm === "denied" ? "Notifications are blocked for this site. Allow them in your browser's site settings." :
      perm === "unsupported" ? (isIOS ? "On iPhone/iPad: tap Share → Add to Home Screen, open the portal from there, then enable notifications." : "This browser doesn't support push notifications.") :
      "Enable notifications to get reminders even when the portal isn't open."),
    el("div", { class: "row" },
      perm !== "unsupported" && perm !== "denied" ? el("button", { class: "primary", onclick: act(async () => { await enablePush(); await route(); }) }, perm === "granted" ? "Re-register this device" : "Enable notifications") : null,
      el("button", { onclick: act(async () => { await api("/push/test", { method: "POST" }); await route(); }) }, "Send test")),
    el("p", { class: "muted", style: "font-size:13px;margin-bottom:0" }, `Reminder times use ${tz()}. `,
      el("button", { class: "link-btn", onclick: act(async () => {
        state.settings = { ...state.settings, ...(await api("/settings", { method: "PUT", body: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } })) };
        await route();
      }) }, "Use this device's time zone")));

  const newDays = daysPicker([1, 2, 3, 4, 5]);
  const add = el("form", { class: "form", onsubmit: act(async (e) => {
    const f = e.target;
    await api("/reminders", { method: "POST", body: { title: f.title.value, body: f.body.value, time_of_day: f.time.value, days: newDays.value(), project_id: f.project.value || null } });
    await route();
  }) },
    el("label", { class: "wide" }, "Reminder", el("input", { name: "title", required: true, placeholder: "e.g. Review Shoreguard supplier quotes" })),
    el("label", {}, "Time", el("input", { name: "time", type: "time", value: "09:00", required: true })),
    el("label", {}, "Project", el("select", { name: "project" }, el("option", { value: "" }, "None"), projectOptions())),
    el("label", { class: "wide" }, "Details", el("input", { name: "body", placeholder: "Optional" })),
    el("div", {}, el("label", {}, "Days"), newDays),
    el("button", { class: "primary", type: "submit" }, "Add reminder"));

  const reminderRow = (r) => {
    const days = daysPicker(r.days);
    const save = (body) => act(async () => { await api(`/reminders/${r.id}`, { method: "PATCH", body }); await route(); });
    return el("li", {},
      el("input", { type: "checkbox", checked: r.enabled, "aria-label": "Enabled", onchange: (e) => save({ enabled: e.target.checked })() }),
      el("div", { class: "grow" },
        el("div", { class: "title" }, r.title, r.kind === "daily_brief" ? el("span", { class: "muted", style: "font-size:13px" }, " · overdue, due today, stalled projects and hours") : null),
        el("div", { class: "row", style: "margin-top:6px" },
          el("input", { type: "time", value: r.time_of_day, "aria-label": "Time", onchange: (e) => save({ time_of_day: e.target.value })() }),
          days,
          el("button", { class: "small", onclick: () => save({ days: days.value() })() }, "Save days"))),
      r.kind === "custom" ? el("button", { class: "link-btn danger", "aria-label": `Delete ${r.title}`, onclick: act(async () => {
        if (!confirm(`Delete reminder "${r.title}"?`)) return;
        await api(`/reminders/${r.id}`, { method: "DELETE" });
        await route();
      }) }, "✕") : null);
  };

  const unread = notes.some((n) => !n.read_at);
  return [
    el("div", { class: "page-head" }, el("h1", {}, "Reminders")),
    pushPanel,
    el("section", { class: "panel" }, el("h2", { style: "margin-bottom:12px" }, "Scheduled"), el("ul", { class: "list" }, reminders.map(reminderRow))),
    el("section", { class: "panel" }, el("h2", { style: "margin-bottom:12px" }, "New reminder"), add),
    el("section", { class: "panel" },
      el("div", { class: "page-head", style: "margin-bottom:8px" }, el("h2", {}, "Inbox"),
        unread ? el("button", { class: "small", onclick: act(async () => { await api("/notifications/read", { method: "POST" }); await route(); }) }, "Mark all read") : null),
      notes.length
        ? el("ul", { class: "list" }, notes.map((n) => el("li", {},
            el("div", { class: "grow" }, el("div", { class: "title", style: n.read_at ? "" : "font-weight:600" }, n.title), el("div", { class: "meta" }, n.body)),
            el("span", { class: "meta" }, fmtDateTime(n.created_at)))))
        : el("p", { class: "empty" }, "No notifications yet.")),
  ];
};

// ---------- router ----------
async function route() {
  const [name, arg] = (location.hash.slice(1) || "today").split("/");
  const view = views[name] || views.today;
  for (const a of $("nav").querySelectorAll("a")) {
    a.toggleAttribute("aria-current", a.getAttribute("href") === "#" + (name === "project" ? "projects" : name));
    if (a.hasAttribute("aria-current")) a.setAttribute("aria-current", "page");
  }
  try {
    $("view").replaceChildren(...[await view(decodeURIComponent(arg || ""))].flat().filter(Boolean));
  } catch (err) {
    toast(err);
  }
}
addEventListener("hashchange", route);

async function boot() {
  try {
    const me = await api("/me");
    if (!me.signedIn) return showLogin();
    state.settings = await api("/settings");
    // First sign-in: adopt this device's time zone for reminders and "today".
    const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (state.settings.timezone === "UTC" && deviceTz !== "UTC") {
      state.settings = { ...state.settings, ...(await api("/settings", { method: "PUT", body: { timezone: deviceTz } })) };
    }
    $("login").hidden = true;
    $("app").hidden = false;
    await loadCore();
    await Promise.all([route(), refreshBell()]);
  } catch (err) {
    toast(err);
  }
}

// Keep the dashboard fresh while it's open.
setInterval(() => { if (!$("app").hidden && document.visibilityState === "visible") refreshBell().catch(() => {}); }, 60_000);
navigator.serviceWorker?.addEventListener("message", () => refreshBell().catch(() => {}));

initTheme();
boot();
