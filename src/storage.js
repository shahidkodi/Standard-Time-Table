import { supabase, supabaseReady } from "./supabaseClient";

const ROW_ID = "main";          // classes, teachers, mapping, rules, timetable …
const EXTRA_ID = "main-extra";  // big, rarely-changed parts: logo, signature, seal, saved versions, safety copies
const LS_KEY = "tt_cfg_cache";
const HEAVY = ["logo", "logoIcon", "hmSign", "seal", "versions", "snapshots"];

let lastStamp = null;      // updated_at of the "main" row we last loaded or saved (for the two-editors check)
let lastExtraJSON = null;  // what is in the "main-extra" row now, so it is only re-sent when it changed
let cacheMain = null, cacheExtra = null;
let loadSource = "server";
export function getLoadSource() { return loadSource; }
let extraOff = false;       // if the extra row can't be written (database rules), everything is kept in one row as before
const own = new Set();      // our own saves, so their live "echo" is not treated as someone else's change
const ms = (t) => (t ? Date.parse(t) : NaN);

function split(cfg) {
  const main = {}, extra = {};
  for (const k of Object.keys(cfg || {})) (HEAVY.includes(k) ? extra : main)[k] = cfg[k];
  return { main, extra };
}
function merge(main, extra) { return main ? { ...main, ...(extra || {}) } : null; }
function cache(cfg) { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch {} }

// Load the shared timetable config. Falls back to a local cache when offline.
export async function loadConfig() {
  if (supabaseReady) {
    try {
      const { data, error } = await supabase.from("timetables").select("id, data, updated_at").in("id", [ROW_ID, EXTRA_ID]);
      if (!error && data) {
        const m = data.find((r) => r.id === ROW_ID), x = data.find((r) => r.id === EXTRA_ID);
        if (m && m.data) {
          lastStamp = m.updated_at || null;
          cacheMain = m.data; cacheExtra = x && x.data ? x.data : null;
          lastExtraJSON = cacheExtra ? JSON.stringify(cacheExtra) : null;
          const cfg = merge(cacheMain, cacheExtra);
          cache(cfg);
          return cfg;
        }
      }
    } catch {}
  }
  try { const cached = localStorage.getItem(LS_KEY); if (cached) { loadSource = "cache"; return JSON.parse(cached); } return null; } catch { return null; }
}

// Save. The big parts go to their own row and are only sent when they changed.
// If someone else saved in between, a ConflictError is thrown (unless force) so nobody's work is silently lost.
export async function saveConfig(cfg, opts = {}) {
  cache(cfg);
  if (!supabaseReady) return;
  let { main, extra } = split(cfg);
  const now = new Date().toISOString();
  own.add(ms(now)); if (own.size > 50) own.delete(own.values().next().value);
  if (!extraOff) {
    const xs = JSON.stringify(extra);
    if (xs !== lastExtraJSON) {
      const { error } = await supabase.from("timetables").upsert({ id: EXTRA_ID, data: extra, updated_at: now });
      if (error) { extraOff = true; } else { lastExtraJSON = xs; cacheExtra = extra; }
    }
  }
  if (extraOff) { main = cfg; }
  if (lastStamp && !opts.force) {
    const { data, error } = await supabase.from("timetables").update({ data: main, updated_at: now }).eq("id", ROW_ID).eq("updated_at", lastStamp).select("updated_at");
    if (error) throw error;
    if (!data || !data.length) {
      const { data: cur } = await supabase.from("timetables").select("data, updated_at").eq("id", ROW_ID).single();
      const err = new Error("Someone else saved a change at the same time.");
      err.conflict = true;
      err.remote = cur && cur.data ? merge(cur.data, cacheExtra) : null;
      err.remoteStamp = cur ? cur.updated_at : null;
      throw err;
    }
    lastStamp = data[0].updated_at; cacheMain = main;
    return;
  }
  const { data, error } = await supabase.from("timetables").upsert({ id: ROW_ID, data: main, updated_at: now }).select("updated_at");
  if (error) throw error;
  lastStamp = data && data[0] ? data[0].updated_at : now; cacheMain = main;
}

// After "Load their version" in a conflict: remember their stamp so the next save goes through.
export function acceptRemote(stamp) { if (stamp) lastStamp = stamp; }

// Live updates when another staff member saves a change.
export function subscribeConfig(onChange) {
  if (!supabaseReady) return null;
  return supabase
    .channel("tt-main")
    .on("postgres_changes", { event: "*", schema: "public", table: "timetables" }, (payload) => {
      const row = payload.new; if (!row || !row.data) return;
      if (own.has(ms(row.updated_at))) { if (row.id === ROW_ID) lastStamp = row.updated_at; return; }
      if (row.id === ROW_ID) { if (row.updated_at) lastStamp = row.updated_at; cacheMain = row.data; onChange(merge(cacheMain, cacheExtra)); }
      else if (row.id === EXTRA_ID) { cacheExtra = row.data; lastExtraJSON = JSON.stringify(row.data); if (cacheMain) onChange(merge(cacheMain, cacheExtra)); }
    })
    .subscribe();
}

/* ---------- Teacher links: small read-only pages, one row per teacher ---------- */
let lastPub = {};
try { lastPub = JSON.parse(localStorage.getItem("tt_pub_hash") || "{}"); } catch {}

// rows: [{ token, data }]. Only rows that changed are sent; tokens not in the list are removed.
export async function publishTeacherPages(rows) {
  if (!supabaseReady) return { ok: false, error: "Supabase is not connected" };
  const changed = rows.filter((r) => lastPub[r.token] !== JSON.stringify(r.data));
  if (changed.length) {
    const now = new Date().toISOString();
    for (let i = 0; i < changed.length; i += 25) {
      const part = changed.slice(i, i + 25).map((r) => ({ token: r.token, data: r.data, updated_at: now }));
      const { error } = await supabase.from("teacher_pages").upsert(part);
      if (error) return { ok: false, error: error.message || String(error) };
    }
  }
  const keep = rows.map((r) => r.token);
  const gone = Object.keys(lastPub).filter((k) => !keep.includes(k));
  if (gone.length) await supabase.from("teacher_pages").delete().in("token", gone);
  const next = {}; rows.forEach((r) => (next[r.token] = JSON.stringify(r.data)));
  lastPub = next;
  try { localStorage.setItem("tt_pub_hash", JSON.stringify(next)); } catch {}
  return { ok: true, sent: changed.length };
}

// Used by the teacher page (no login): reads one page through a safe function.
export async function loadTeacherPage(token) {
  if (!supabaseReady) return { error: "not connected" };
  const [a, b] = await Promise.all([
    supabase.rpc("get_teacher_page", { p_token: token }),
    supabase.rpc("get_teacher_page", { p_token: "_school" }),
  ]);
  if (a.error) return { error: a.error.message || String(a.error) };
  return { page: a.data, school: b.data || null };
}
