const STATUSES = ["active", "building", "paused", "idea", "archived"];
const state = { projects: [], type: "", status: "", q: "" };

// `status` may be a single string or an array, e.g. ["active", "building"].
const statusesOf = (p) => [].concat(p.status || []).filter(Boolean);
const linkList = (items) => el("div", { class: "links" }, ...items.map((l) => el("a", { href: l.url, target: "_blank", rel: "noopener" }, l.label + " ↗")));

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
};

function initTheme() {
  try {
    const saved = localStorage.getItem("theme");
    if (saved) document.documentElement.dataset.theme = saved;
  } catch {}
  $("theme").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
  });
}

function renderStats() {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  state.projects.forEach((p) => statusesOf(p).forEach((s) => { counts[s] = (counts[s] || 0) + 1; }));
  const items = [["Total", state.projects.length], ...STATUSES.filter((s) => counts[s]).map((s) => [s[0].toUpperCase() + s.slice(1), counts[s]])];
  $("stats").replaceChildren(...items.map(([label, n]) => el("div", { class: "stat" }, el("b", {}, String(n)), el("span", {}, label))));
}

function renderFilters() {
  const types = [...new Set(state.projects.map((p) => p.type).filter(Boolean))].sort();
  const chip = (label, value) => {
    const b = el("button", { class: "chip", "aria-pressed": String(state.type === value) }, label);
    b.addEventListener("click", () => { state.type = value; renderFilters(); renderGrid(); });
    return b;
  };
  $("typeFilters").replaceChildren(chip("All", ""), ...types.map((t) => chip(t, t)));

  const sel = $("statusFilter");
  if (sel.options.length === 1) {
    STATUSES.forEach((s) => sel.append(el("option", { value: s }, s[0].toUpperCase() + s.slice(1))));
  }
}

function card(p) {
  const integrations = Object.entries(p.integrations || {}).filter(([, v]) => v);
  return el("article", { class: "card" },
    el("div", { class: "card-head" },
      el("div", {}, el("div", { class: "type" }, p.type || ""), el("h2", {}, p.name)),
      el("div", { class: "badges" }, ...(statusesOf(p).length
        ? statusesOf(p).map((s) => el("span", { class: `badge ${s}` }, s))
        : [el("span", { class: "badge archived" }, "unset")]))
    ),
    p.description ? el("p", { class: "desc" }, p.description) : null,
    p.tags?.length ? el("div", { class: "tags" }, ...p.tags.map((t) => el("span", { class: "tag" }, t))) : null,
    p.links?.length ? linkList(p.links) : null,
    p.documents?.length ? el("div", { class: "docs" }, el("div", { class: "section-label" }, "Documents"), linkList(p.documents)) : null,
    integrations.length ? el("div", { class: "integrations" }, "Connected: " + integrations.map(([k]) => k).join(", ")) : null
  );
}

function renderGrid() {
  const q = state.q.toLowerCase();
  const list = state.projects.filter((p) =>
    (!state.type || p.type === state.type) &&
    (!state.status || statusesOf(p).includes(state.status)) &&
    (!q || [p.name, p.description, p.type, ...(p.tags || [])].join(" ").toLowerCase().includes(q))
  );
  $("grid").replaceChildren(...list.map(card));
  $("empty").hidden = list.length > 0;
}

async function main() {
  initTheme();
  $("search").addEventListener("input", (e) => { state.q = e.target.value; renderGrid(); });
  $("statusFilter").addEventListener("change", (e) => { state.status = e.target.value; renderGrid(); });
  try {
    const res = await fetch("data/projects.json", { cache: "no-cache" });
    const data = await res.json();
    state.projects = data.projects || [];
    if (data.owner) { $("title").textContent = `${data.owner} Portal`; document.title = `${data.owner} Portal`; }
  } catch (err) {
    $("empty").textContent = "Couldn't load data/projects.json.";
  }
  renderStats();
  renderFilters();
  renderGrid();
}

main();
