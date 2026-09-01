import React, { useState, useEffect, useMemo, useRef } from "react";
import { SEED } from "./seed";
import { loadConfig, saveConfig, subscribeConfig } from "./storage";
import { supabase } from "./supabaseClient";

/* ============================================================
   AMUPS Pallikkal — Timetable Manager  (v2)
   The B-Key is the source of truth: it sets which teacher takes
   which subject in each class, and how many periods per week.
   The master grid can only place what the B-Key allows, and every
   teacher's load is tracked against their B-Key target.
   ============================================================ */

const STORE_KEY = "tt_cfg_v2";

const WEEK_ORDER = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const DAY_FULL = { MON: "Monday", TUE: "Tuesday", WED: "Wednesday", THU: "Thursday", FRI: "Friday", SAT: "Saturday", SUN: "Sunday" };

const C = {
  paper: "#eef1f5", surface: "#ffffff", ink: "#16213a", sub: "#647189", line: "#e4e8ef",
  primary: "#0e6b73", primaryDeep: "#0a4f55", primarySoft: "#e1f0f0", accent: "#d98a2b", accentSoft: "#fbeeda",
  clash: "#d64545", clashSoft: "#fbe6e4", free: "#1f9d57", freeSoft: "#e3f5ec",
  warn: "#bd861d", warnSoft: "#fbf2dd",
  shadow: "0 1px 2px rgba(22,33,58,.04), 0 4px 16px rgba(22,33,58,.05)",
};
const SUBJECT_BAR = {
  ENG: "#3b76d1", MAT: "#e07b1f", SS: "#1f9d57", BS: "#7a8a2e", HIN: "#a64bbf",
  "MAL-2": "#138a9c", LAN: "#c08a2e", IT: "#5a5bd6", PET: "#e0574b", LB: "#5b7088", TAB: "#cf5a93",
};
const tintOf = (hex, a = 0.13) => {
  const n = parseInt(hex.slice(1), 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
};
const SUBJECT_TINT = Object.fromEntries(Object.entries(SUBJECT_BAR).map(([k, v]) => [k, tintOf(v)]));
const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const sans = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const THEMES = {
  teal:    { name: "Teal",    bg: "#eef1f5", g1: "#0e6b73", g2: "#0a4f55", accent: "#0e6b73" },
  indigo:  { name: "Indigo",  bg: "#eef0f8", g1: "#4f46e5", g2: "#3730a3", accent: "#4f46e5" },
  emerald: { name: "Emerald", bg: "#ecf4ef", g1: "#059669", g2: "#046c50", accent: "#059669" },
  plum:    { name: "Plum",    bg: "#f3eef6", g1: "#7c3aed", g2: "#5b21b6", accent: "#7c3aed" },
  slate:   { name: "Slate",   bg: "#eceef2", g1: "#475569", g2: "#1e293b", accent: "#475569" },
  rose:    { name: "Rose",    bg: "#f7eef1", g1: "#e11d63", g2: "#9d174d", accent: "#e11d63" },
};

const TABS = [
  ["classes", "Class timetables"], ["teachers", "Teacher timetables"], ["free", "Free & substitution"],
  ["bkey", "B-Key & teacher load"], ["edit", "Assign timetable"], ["rules", "Scheduling rules"],
  ["combined", "Language sessions"], ["analysis", "Analysis & checks"], ["assistant", "AI assistant"], ["setup", "Classes & setup"],
];

function useIsMobile(q = "(max-width: 760px)") {
  const get = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(q).matches : false);
  const [m, setM] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
    return () => (mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on));
  }, [q]);
  return m;
}

const emptyDay = () => Array.from({ length: 8 }, () => [null, null]);
const clone = (o) => JSON.parse(JSON.stringify(o));
const stdOf = (cls) => String(cls).split(" ")[0];
const baseName = (code) => (code ? code.replace(/ \d+$/, "") : code);
const periodsFor = (cfg, cls, sub) => Number(cfg.stdPeriods?.[stdOf(cls)]?.[sub]) || 0;
const standardsOf = (cfg) => [...new Set(cfg.classes.map(stdOf))].sort((a, b) => (isNaN(a) || isNaN(b) ? String(a).localeCompare(b) : a - b));

// ---- automated scheduler (deterministic CSP, randomized restarts) ----
function makeRng(seed) { return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; }
function shuf(a, r) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function autoSchedule(cfg, mode = "all", onlyClass = null) {
  const singles = new Set(cfg.singles);
  const cByBase = {}; (cfg.combined || []).forEach((s) => (cByBase[s.name] = s));
  const isC = (code) => !!cByBase[baseName(code)];
  const tOf = (code) => { const s = cByBase[baseName(code)]; if (s) return s.teachers.filter((t) => singles.has(t)); if (singles.has(code)) return [code]; return code.split(" ").filter((t) => singles.has(t)); };
  const pf = (c, sub) => Number(cfg.stdPeriods?.[stdOf(c)]?.[sub]) || 0;
  const D = cfg.days.length, P = cfg.periods.length;
  const RULES = cfg.rules || {};
  const R = (sub) => RULES[sub] || {};
  const twiceOK = (c, sub) => !!(cfg.twice && cfg.twice[stdOf(c)] && cfg.twice[stdOf(c)][sub]);
  const allowed = (sub, p) => { const r = R(sub); if (r.pin && r.pin !== p + 1) return false; if (r.forbid && r.forbid.includes(p + 1)) return false; return true; };

  const gen = (seed) => {
    const r = makeRng(seed);
    const grid = {}; cfg.classes.forEach((c) => (grid[c] = Array.from({ length: D }, () => Array.from({ length: P }, () => [null, null]))));
    const tbusy = Array.from({ length: D }, () => Array.from({ length: P }, () => new Set()));
    const subDay = {}, subPer = {};
    const mark = (c, sub, d, p) => { subDay[`${c}|${sub}|${d}`] = (subDay[`${c}|${sub}|${d}`] || 0) + 1; subPer[`${c}|${sub}|${p}`] = (subPer[`${c}|${sub}|${p}`] || 0) + 1; };
    const seedExisting = (keep) => {
      for (const c of cfg.classes) for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) {
        if (mode === "class" && c !== keep) { } // include others as busy
        const slot = cfg.grid[c]?.[cfg.days[d]]?.[p]; if (!slot || !slot[0]) continue;
        grid[c][d][p] = [slot[0], slot[1]]; tOf(slot[0]).forEach((t) => tbusy[d][p].add(t)); mark(c, slot[1], d, p);
      }
    };
    if (mode !== "all") seedExisting(onlyClass);
    const frozen = new Set();
    for (const key in (cfg.locked || {})) {
      if (!cfg.locked[key]) continue;
      const parts = key.split("|"); const c = parts[0], day = parts[1], p = +parts[2];
      const di = cfg.days.indexOf(day); if (di < 0 || !cfg.grid[c]) continue;
      frozen.add(c + "|" + di + "|" + p);
      if (mode === "all") { const slot = cfg.grid[c][day] && cfg.grid[c][day][p]; if (slot && slot[0]) { grid[c][di][p] = [slot[0], slot[1]]; tOf(slot[0]).forEach((t) => tbusy[di][p].add(t)); mark(c, slot[1], di, p); } }
    }
    const free = (c, d, p) => !grid[c][d][p][0] && !frozen.has(c + "|" + d + "|" + p);
    const tFree = (toks, d, p) => toks.every((t) => !tbusy[d][p].has(t));
    const book = (c, d, p, code, sub) => { grid[c][d][p] = [code, sub]; tOf(code).forEach((t) => tbusy[d][p].add(t)); mark(c, sub, d, p); };
    const unbook = (c, d, p) => { const cur = grid[c][d][p]; const code = cur[0], sub = cur[1]; if (!code) return; tOf(code).forEach((t) => tbusy[d][p].delete(t)); if (subDay[`${c}|${sub}|${d}`]) subDay[`${c}|${sub}|${d}`]--; if (subPer[`${c}|${sub}|${p}`]) subPer[`${c}|${sub}|${p}`]--; grid[c][d][p] = [null, null]; };
    const okSoft = (c, sub, d, p) => { const lim = twiceOK(c, sub) ? 2 : 1; if ((subDay[`${c}|${sub}|${d}`] || 0) >= lim) return false; if (R(sub).distinct && subPer[`${c}|${sub}|${p}`]) return false; return true; };
    const slots = () => { const s = []; for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) s.push([d, p]); return s; };
    let unplaced = 0;

    // per-class fixed-slot rules (highest priority): e.g. class teacher / a chosen subject in P1
    const CR = cfg.classRules || {};
    const resolveRule = (c, rule) => {
      if (!rule) return null;
      if (rule.kind === "ct") { const ct = cfg.classTeacher[c]; const row = (cfg.bkey[c] || []).find((r) => r.teacher === ct && !isC(r.teacher)); return row ? { sub: row.sub, teacher: ct } : null; }
      if (rule.kind === "pair") return isC(rule.teacher) ? null : { sub: rule.sub, teacher: rule.teacher };
      return null;
    };
    const placeFixed = (list) => {
      for (const c of list) {
        const cr = CR[c]; if (!cr) continue;
        for (const pStr of Object.keys(cr)) {
          const p = (+pStr) - 1; if (p < 0 || p >= P) continue; const res = resolveRule(c, cr[pStr]); if (!res) continue; const toks = tOf(res.teacher);
          for (let d = 0; d < D; d++) {
            let placed = 0; for (let dd = 0; dd < D; dd++) for (let pp = 0; pp < P; pp++) if (grid[c][dd][pp][0] === res.teacher && grid[c][dd][pp][1] === res.sub) placed++;
            if (placed >= pf(c, res.sub)) break;
            if (free(c, d, p) && tFree(toks, d, p) && !subDay[`${c}|${res.sub}|${d}`]) book(c, d, p, res.teacher, res.sub);
          }
        }
      }
    };
    placeFixed(mode === "all" ? cfg.classes : [onlyClass]);

    if (mode === "all" && (cfg.combined || []).length) {
      // Parallel language block: place EVERY language session at the SAME period-slots, so the
      // shared language teachers each teach one pooled group per slot (not serialised across the week).
      const need = Math.max(...cfg.combined.map((sx) => pf(sx.divisions[0] || cfg.classes[0], sx.sub)));
      const combT = new Set(); cfg.combined.forEach((sx) => sx.teachers.forEach((t) => singles.has(t) && combT.add(t)));
      const combSub = cfg.combined[0].sub;
      let placed = 0; const usedD = new Set();
      for (const d of shuf([...Array(D).keys()], r)) {
        if (placed >= need) break; if (usedD.has(d)) continue;
        for (const p of shuf([...Array(P).keys()], r)) {
          if (!allowed(combSub, p)) continue;
          let ok = true;
          for (const t of combT) if (tbusy[d][p].has(t)) { ok = false; break; }
          if (ok) for (const sx of cfg.combined) { for (const c of sx.divisions) if (!free(c, d, p) || !okSoft(c, sx.sub, d, p)) { ok = false; break; } if (!ok) break; }
          if (ok) { for (const sx of cfg.combined) for (const c of sx.divisions) book(c, d, p, sx.name, sx.sub); placed++; usedD.add(d); break; }
        }
      }
      unplaced += Math.max(0, need - placed) * cfg.combined.reduce((a, sx) => a + sx.divisions.length, 0);
    }

    const targets = mode === "class" ? [onlyClass] : cfg.classes;
    let lessons = [];
    for (const c of targets) for (const row of cfg.bkey[c] || []) {
      if (isC(row.teacher)) continue;
      let already = 0; for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) if (grid[c][d][p][0] === row.teacher && grid[c][d][p][1] === row.sub) already++;
      for (let k = already; k < pf(c, row.sub); k++) lessons.push({ c, sub: row.sub, teacher: row.teacher });
    }
    const load = {}; lessons.forEach((l) => tOf(l.teacher).forEach((t) => (load[t] = (load[t] || 0) + 1)));
    lessons = shuf(lessons, r);
    lessons.sort((a, b) => { const pa = R(a.sub).pin ? 0 : 1, pb = R(b.sub).pin ? 0 : 1; if (pa !== pb) return pa - pb; return Math.max(...tOf(b.teacher).map((t) => load[t] || 0)) - Math.max(...tOf(a.teacher).map((t) => load[t] || 0)); });
    const unplacedList = [];
    for (const l of lessons) {
      const toks = tOf(l.teacher); const band = R(l.sub).band;
      let cand = shuf(slots(), r).filter(([, p]) => allowed(l.sub, p));
      if (band === "early") cand.sort((a, b) => a[1] - b[1]); else if (band === "late") cand.sort((a, b) => b[1] - a[1]);
      let done = false;
      for (const [d, p] of cand) if (free(l.c, d, p) && tFree(toks, d, p) && okSoft(l.c, l.sub, d, p)) { book(l.c, d, p, l.teacher, l.sub); done = true; break; }
      if (!done) { const lim = twiceOK(l.c, l.sub) ? 2 : 1; for (const [d, p] of cand) if (free(l.c, d, p) && tFree(toks, d, p) && (subDay[`${l.c}|${l.sub}|${d}`] || 0) < lim) { book(l.c, d, p, l.teacher, l.sub); done = true; break; } }
      if (!done) unplacedList.push(l);
    }
    // auto-relocation repair: resolve any unplaced lesson by borrowing a slot (first periods first)
    // and moving the movable occupant (e.g. a class teacher's P1 period) to another free slot.
    let remaining = unplacedList;
    for (let pass = 0; pass < 2; pass++) {
    const stillRem = [];
    for (const l of remaining) {
      const toks = tOf(l.teacher); let fixed = false;
      const cand = shuf(slots(), r).filter(([, p]) => allowed(l.sub, p));
      cand.sort((a, b) => a[1] - b[1]);
      for (const [d, p] of cand) {
        if (!tFree(toks, d, p)) continue;
        if (free(l.c, d, p)) { if (okSoft(l.c, l.sub, d, p)) { book(l.c, d, p, l.teacher, l.sub); fixed = true; break; } continue; }
        const occ = grid[l.c][d][p]; if (isC(occ[0])) continue;
        const oc = occ[0], os = occ[1], otoks = tOf(oc);
        unbook(l.c, d, p);
        let moved = null;
        for (const [d2, p2] of shuf(slots(), r)) { if (d2 === d && p2 === p) continue; if (allowed(os, p2) && free(l.c, d2, p2) && tFree(otoks, d2, p2) && okSoft(l.c, os, d2, p2)) { book(l.c, d2, p2, oc, os); moved = [d2, p2]; break; } }
        if (moved && free(l.c, d, p) && tFree(toks, d, p) && okSoft(l.c, l.sub, d, p)) { book(l.c, d, p, l.teacher, l.sub); fixed = true; break; }
        else { if (moved) unbook(l.c, moved[0], moved[1]); book(l.c, d, p, oc, os); }
      }
      if (!fixed) stillRem.push(l);
    }
    remaining = stillRem;
    }
    unplaced += remaining.length;
    const out = {}; for (const c of cfg.classes) { out[c] = {}; cfg.days.forEach((day, d) => (out[c][day] = grid[c][d])); }
    return { grid: out, unplaced };
  };

  let best = null;
  for (let s = 1; s <= 80; s++) { const res = gen(s * 7 + 1); if (!best || res.unplaced < best.unplaced) best = res; if (best.unplaced === 0) break; }
  return best;
}

export default function App() {
  const [cfg, setCfg] = useState(null);
  const [view, setView] = useState("classes");
  const [cls, setCls] = useState(SEED.classes[0]);
  const [tch, setTch] = useState(SEED.singles[0]);
  const [fday, setFday] = useState(SEED.days[0]);
  const [fper, setFper] = useState(1);
  const [saved, setSaved] = useState("loaded");
  const [confirmState, setConfirmState] = useState(null);
  const ask = (msg, onYes) => setConfirmState({ msg, onYes });
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState("teal");
  const mobile = useIsMobile();
  useEffect(() => { try { const t = localStorage.getItem("tt_theme"); if (t) setTheme(t); } catch {} }, []);
  const persistTheme = (name) => { setTheme(name); setMenuOpen(false); try { localStorage.setItem("tt_theme", name); } catch {} };
  const TH = THEMES[theme] || THEMES.teal;
  const handleSignOut = () => { if (typeof supabase !== "undefined") { try { supabase.auth.signOut(); } catch {} } else { alert("Sign out works on your deployed app, which has staff login. This in-chat preview has no login to sign out of."); } };

  useEffect(() => {
    let alive = true;
    (async () => {
      let next = null; let wasEmpty = false;
      try { next = await loadConfig(); } catch {}
      if (!next) { next = clone(SEED); wasEmpty = true; }
      // migrate older configs: ensure combined sessions + stdPeriods exist
      if (!next.combined) {
        const singles = new Set(next.singles);
        const bases = {};
        for (const cn of next.classes) for (const r of next.bkey[cn] || []) {
          const b = baseName(r.teacher);
          if (!singles.has(r.teacher) && r.teacher.includes(" ")) {
            (bases[b] ||= { name: b, sub: r.sub, teachers: new Set(), divisions: new Set() });
            r.teacher.split(" ").forEach((t) => singles.has(t) && bases[b].teachers.add(t));
            bases[b].divisions.add(cn);
          }
        }
        next.combined = Object.values(bases).map((x) => ({ name: x.name, sub: x.sub, teachers: [...x.teachers], divisions: [...x.divisions] }));
      }
      if (!next.stdPeriods) next.stdPeriods = {};
      if (!next.rules) next.rules = {};
      if (!next.classRules) next.classRules = {};
      if (!next.locked) next.locked = {};
      if (!next.twice) next.twice = {};
      if (!alive) return;
      setCfg(next);
      lastSaved.current = JSON.stringify(next);
      if (wasEmpty) { try { await saveConfig(next); } catch {} }
    })();
    const ch = subscribeConfig((remote) => { if (!remote) return; const js = JSON.stringify(remote); if (js === lastSaved.current) return; lastSaved.current = js; setCfg(remote); setSaved("synced"); });
    return () => { alive = false; if (ch) { try { supabase.removeChannel(ch); } catch {} } };
  }, []);

  const lastSaved = useRef("");
  const saveTimer = useRef(null);
  const persist = (next) => {
    setSaved("saving…");
    lastSaved.current = JSON.stringify(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => { try { await saveConfig(next); setSaved("saved"); } catch { setSaved("offline · saved on device"); } }, 600);
  };
  const update = (fn) => setCfg((prev) => { const next = clone(prev); fn(next); persist(next); return next; });

  const singlesSet = useMemo(() => new Set(cfg?.singles || []), [cfg]);
  const combinedByBase = useMemo(() => {
    const m = {}; (cfg?.combined || []).forEach((s) => (m[s.name] = s)); return m;
  }, [cfg]);
  const isCombined = (code) => !!combinedByBase[baseName(code)];
  const teachersOf = (code) => {
    if (!code) return [];
    const s = combinedByBase[baseName(code)];
    if (s) return s.teachers.filter((t) => singlesSet.has(t));
    if (singlesSet.has(code)) return [code];
    return code.split(" ").filter((t) => singlesSet.has(t));
  };
  const expand = teachersOf; // alias kept for existing callers

  // occupancy[day][p] = { tok: Map(token -> {norm:Set(cn), comb:Set(base)}), sessions: Map(base -> Set(cn)) }
  const occupancy = useMemo(() => {
    if (!cfg) return {};
    const occ = {};
    for (const day of cfg.days) {
      occ[day] = cfg.periods.map(() => ({ tok: new Map(), sessions: new Map() }));
      for (const cn of cfg.classes) {
        (cfg.grid[cn]?.[day] || emptyDay()).forEach((slot, p) => {
          const code = slot[0]; if (!code) return;
          const comb = isCombined(code); const base = baseName(code);
          if (comb) { if (!occ[day][p].sessions.has(base)) occ[day][p].sessions.set(base, new Set()); occ[day][p].sessions.get(base).add(cn); }
          for (const t of teachersOf(code)) {
            if (!occ[day][p].tok.has(t)) occ[day][p].tok.set(t, { norm: new Set(), comb: new Set() });
            const e = occ[day][p].tok.get(t);
            if (comb) e.comb.add(base); else e.norm.add(cn);
          }
        });
      }
    }
    return occ;
  }, [cfg, combinedByBase]);

  // clash rule: a teacher in >1 regular class, or in a regular class AND a language session at once.
  const clashTokens = (day, p) => {
    const s = new Set(); const m = occupancy[day]?.[p]?.tok;
    if (m) for (const [t, e] of m) if (e.norm.size > 1 || (e.norm.size >= 1 && e.comb.size >= 1)) s.add(t);
    return s;
  };
  const totalClashes = useMemo(() => {
    let n = 0;
    for (const day of cfg?.days || []) for (let p = 0; p < cfg.periods.length; p++) {
      const m = occupancy[day]?.[p]?.tok;
      if (m) for (const [, e] of m) if (e.norm.size > 1 || (e.norm.size >= 1 && e.comb.size >= 1)) n++;
    }
    return n;
  }, [occupancy, cfg]);

  // teacher load: combined sessions count once (not per division)
  const teacherLoad = useMemo(() => {
    if (!cfg) return {};
    const t = {}; cfg.singles.forEach((x) => (t[x] = { target: 0, placed: 0 }));
    for (const cn of cfg.classes) for (const row of cfg.bkey[cn] || []) {
      if (isCombined(row.teacher)) continue;
      for (const tk of teachersOf(row.teacher)) if (t[tk]) t[tk].target += periodsFor(cfg, cn, row.sub);
    }
    for (const s of cfg.combined || []) {
      const rep = s.divisions[0] || cfg.classes[0]; const p = periodsFor(cfg, rep, s.sub);
      for (const tk of s.teachers) if (t[tk]) t[tk].target += p;
    }
    for (const day of cfg.days) for (let p = 0; p < cfg.periods.length; p++) {
      const seen = new Set();
      for (const cn of cfg.classes) {
        const code = cfg.grid[cn]?.[day]?.[p]?.[0]; if (!code) continue;
        if (isCombined(code)) { const b = baseName(code); if (seen.has(b)) continue; seen.add(b); for (const tk of teachersOf(code)) if (t[tk]) t[tk].placed += 1; }
        else for (const tk of teachersOf(code)) if (t[tk]) t[tk].placed += 1;
      }
    }
    return t;
  }, [cfg, combinedByBase]);

  if (!cfg) return <div style={{ padding: 40, fontFamily: sans, color: C.sub }}>Loading timetable…</div>;
  // guard: selected items may have been removed
  const safeCls = cfg.classes.includes(cls) ? cls : cfg.classes[0];
  const safeTch = cfg.singles.includes(tch) ? tch : cfg.singles[0];
  const safeFday = cfg.days.includes(fday) ? fday : cfg.days[0];

  const ctx = { cfg, update, expand, occupancy, clashTokens, teacherLoad, ask, isCombined, combinedByBase, mobile };

  return (
    <div style={{ fontFamily: sans, color: C.ink, background: TH.bg, minHeight: "100vh" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        *{box-sizing:border-box}
        select.tt-sel,input.tt-in{font-family:${mono};font-size:12px;border:1px solid ${C.line};border-radius:7px;padding:5px 6px;background:#fff;color:${C.ink};width:100%;transition:border-color .12s,box-shadow .12s}
        select.tt-sel:hover,input.tt-in:hover{border-color:#c4ccd8}
        select.tt-sel:focus,input.tt-in:focus{outline:none;border-color:${C.primary};box-shadow:0 0 0 3px ${C.primarySoft}}
        button.tt-btn{cursor:pointer;font-family:${sans};transition:transform .08s,box-shadow .12s,background .12s,color .12s}
        button.tt-btn:active{transform:translateY(1px)}
        .tt-tab{cursor:pointer;transition:background .14s,color .14s}
        .tt-list::-webkit-scrollbar,.tt-scroll::-webkit-scrollbar{width:9px;height:9px}
        .tt-list::-webkit-scrollbar-thumb,.tt-scroll::-webkit-scrollbar-thumb{background:#d3d9e2;border-radius:5px;border:2px solid transparent;background-clip:padding-box}
        .tt-row:hover td{background:#f8fafb}
        .tt-cellhover:hover{filter:brightness(.97)}
        @keyframes ttfade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
        .tt-fade{animation:ttfade .25s ease}
        @keyframes ttslide{from{transform:translateX(-100%)}to{transform:none}}
        @media print{.tt-noprint{display:none!important}.tt-printarea{box-shadow:none!important;border:none!important}body{background:#fff!important}.tt-printtitle{display:block!important}}
      `}</style>

      <header className="tt-noprint" style={{ background: `linear-gradient(115deg, ${TH.g2}, ${TH.g1})`, color: "#fff", padding: mobile ? "12px 14px" : "15px 22px", display: "flex", alignItems: "center", gap: mobile ? 10 : 16, position: "sticky", top: 0, zIndex: 30, flexWrap: "wrap", boxShadow: "0 2px 14px rgba(10,79,85,.25)" }}>
        <button className="tt-btn" onClick={() => setMenuOpen(true)} aria-label="Menu" style={{ border: "1px solid rgba(255,255,255,.28)", background: "rgba(255,255,255,.14)", color: "#fff", width: 40, height: 40, borderRadius: 10, fontSize: 20, lineHeight: 1, display: "grid", placeItems: "center", flexShrink: 0 }}>☰</button>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: "rgba(255,255,255,.16)", border: "1px solid rgba(255,255,255,.25)", color: "#fff", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 16, letterSpacing: -0.5 }}>TT</div>
        <div style={{ marginRight: "auto" }}>
          <div style={{ fontSize: 16.5, fontWeight: 800, letterSpacing: -0.3 }}>{cfg.school}</div>
          {!mobile && <div style={{ fontSize: 12, color: "rgba(255,255,255,.8)", marginTop: 1, fontWeight: 500 }}>Timetable Manager · {cfg.classes.length} classes · {cfg.singles.length} teachers · {cfg.days.length} days</div>}
        </div>
        <ClashBadge n={totalClashes} />
        <span style={{ fontSize: 12, color: "rgba(255,255,255,.85)", minWidth: 56, textAlign: "right", fontWeight: 500 }}>{saved}</span>
        <button className="tt-btn" onClick={() => ask("Reset — clear ALL class timetables to blank? Your B-Key, classes, teachers and rules are kept.", () => update((n) => { for (const c of n.classes) for (const d of n.days) n.grid[c][d] = emptyDay(); n.locked = {}; }))} style={headerBtn}>Reset</button>
      </header>

      {!mobile && <nav className="tt-noprint tt-scroll" style={{ display: "flex", gap: 4, padding: "11px 18px", background: C.surface, borderBottom: `1px solid ${C.line}`, overflowX: "auto" }}>
        {TABS.map(([k, label]) => (
          <div key={k} className="tt-tab" onClick={() => setView(k)} style={{
            padding: "8px 15px", fontSize: 13, fontWeight: 600, borderRadius: 9, whiteSpace: "nowrap",
            color: view === k ? "#fff" : C.sub, background: view === k ? TH.accent : "transparent",
          }}><span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Icon name={k} size={15} />{label}</span></div>
        ))}
      </nav>}

      {mobile && (
        <div className="tt-noprint" style={{ padding: "9px 14px", background: C.surface, borderBottom: `1px solid ${C.line}`, fontSize: 13.5, fontWeight: 700, color: TH.accent }}>
          <span style={{ color: C.sub, fontWeight: 600 }}>Section: </span>{(TABS.find((t) => t[0] === view) || ["", ""])[1]}
        </div>
      )}
      <NavDrawer open={menuOpen} onClose={() => setMenuOpen(false)} view={view} setView={setView} TH={TH} school={cfg.school} theme={theme} setTheme={persistTheme} onSignOut={handleSignOut} />
      <main style={{ display: "flex", alignItems: "flex-start", flexDirection: mobile ? "column" : "row" }}>
        {!mobile && (view === "classes" || view === "edit" || view === "bkey") && (
          <Sidebar title="Classes" items={cfg.classes} sel={safeCls} onSel={setCls} sub={(x) => "CT " + (cfg.classTeacher[x] || "—")} />
        )}
        {!mobile && view === "teachers" && <Sidebar title="Teachers" items={cfg.singles} sel={safeTch} onSel={setTch} />}
        <section key={view} className="tt-fade" style={{ flex: 1, padding: mobile ? 12 : 22, minWidth: 0, width: "100%" }}>
          {mobile && (view === "classes" || view === "edit" || view === "bkey") && <MobilePicker label="Class" items={cfg.classes} value={safeCls} onChange={setCls} />}
          {mobile && view === "teachers" && <MobilePicker label="Teacher" items={cfg.singles} value={safeTch} onChange={setTch} />}
          {view === "classes" && <ClassView {...ctx} cls={safeCls} />}
          {view === "teachers" && <TeacherView {...ctx} tch={safeTch} />}
          {view === "free" && <FreeView {...ctx} fday={safeFday} setFday={setFday} fper={fper} setFper={setFper} />}
          {view === "bkey" && <BKeyView {...ctx} cls={safeCls} />}
          {view === "edit" && <EditView {...ctx} cls={safeCls} />}
          {view === "rules" && <RulesView {...ctx} />}
          {view === "combined" && <CombinedView {...ctx} />}
          {view === "analysis" && <AnalysisView {...ctx} />}
          {view === "assistant" && <AssistantView {...ctx} />}
          {view === "setup" && <SetupView {...ctx} />}
        </section>
      </main>
      {confirmState && <ConfirmModal msg={confirmState.msg} onYes={() => { confirmState.onYes(); setConfirmState(null); }} onNo={() => setConfirmState(null)} />}
    </div>
  );
}

function ConfirmModal({ msg, onYes, onNo }) {
  return (
    <div onClick={onNo} style={{ position: "fixed", inset: 0, background: "rgba(20,25,33,.4)", display: "grid", placeItems: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, padding: 22, width: 380, maxWidth: "90vw", boxShadow: "0 12px 40px rgba(0,0,0,.25)" }}>
        <div style={{ fontSize: 14.5, lineHeight: 1.5, color: C.ink, marginBottom: 18 }}>{msg}</div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="tt-btn" onClick={onNo} style={ghostBtn}>Cancel</button>
          <button className="tt-btn" onClick={onYes} style={{ ...solidBtn, background: C.clash }}>Confirm</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- shared chrome ---------------- */
const ghostBtn = { border: `1px solid ${C.line}`, background: "#fff", color: "#16213a", padding: "7px 13px", borderRadius: 9, fontSize: 12.5, fontWeight: 600 };
const headerBtn = { border: "1px solid rgba(255,255,255,.28)", background: "rgba(255,255,255,.12)", color: "#fff", padding: "7px 13px", borderRadius: 9, fontSize: 12.5, fontWeight: 600 };
const solidBtn = { border: "none", background: C.primary, color: "#fff", padding: "8px 15px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", boxShadow: "0 2px 8px rgba(14,107,115,.28)" };

function ClashBadge({ n }) {
  const ok = n === 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 11px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, background: ok ? C.freeSoft : C.clashSoft, color: ok ? C.free : C.clash }}>
      <span style={{ width: 8, height: 8, borderRadius: 9, background: ok ? C.free : C.clash }} />
      {ok ? "No clashes" : `${n} clash${n > 1 ? "es" : ""}`}
    </div>
  );
}
function Sidebar({ title, items, sel, onSel, sub }) {
  return (
    <aside className="tt-noprint tt-list" style={{ width: 188, flexShrink: 0, borderRight: `1px solid ${C.line}`, background: C.surface, height: "calc(100vh - 110px)", overflowY: "auto", position: "sticky", top: 110 }}>
      <div style={{ padding: "12px 16px 8px", fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase", color: C.sub, fontWeight: 700 }}>{title}</div>
      {items.map((x) => (
        <div key={x} onClick={() => onSel(x)} style={{
          padding: "8px 16px", cursor: "pointer", fontSize: 13.5, display: "flex", justifyContent: "space-between", alignItems: "center",
          background: sel === x ? C.primarySoft : "transparent", color: sel === x ? C.primary : C.ink, fontWeight: sel === x ? 700 : 500,
          borderLeft: sel === x ? `3px solid ${C.primary}` : "3px solid transparent",
        }}>
          <span style={{ fontFamily: mono }}>{x}</span>
          {sub && <span style={{ fontSize: 10.5, color: sel === x ? C.primary : C.sub, fontFamily: mono }}>{sub(x)}</span>}
        </div>
      ))}
    </aside>
  );
}
function Icon({ name, size = 16 }) {
  const P = {
    classes: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
    teachers: "M12 11a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
    free: "M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z",
    bkey: "M14 8a4 4 0 10-3.9 4H11l-1.5 1.5L11 15l-1.5 1.5L11 18H8l-2-2v-2h2l2.1-2.1A4 4 0 0114 8z",
    edit: "M4 5h16M4 12h16M4 19h16M9 5v14",
    rules: "M4 7h16M4 17h16M9 4v6M17 14v6",
    combined: "M8 12a3 3 0 100-6 3 3 0 000 6zM17 12a3 3 0 100-6 3 3 0 000 6zM2 20a5 5 0 0110 0M13 20a5 5 0 019 0",
    analysis: "M4 20V10M10 20V4M16 20v-8M20 20H3",
    assistant: "M21 14a2 2 0 01-2 2H9l-5 4V6a2 2 0 012-2h12a2 2 0 012 2z",
    setup: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 13a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 11-4 0v-.2A1.7 1.7 0 006 19.5l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 003 13H2.8a2 2 0 110-4H3a1.7 1.7 0 001.5-2.9l-.1-.1a2 2 0 112.8-2.8l.1.1A1.7 1.7 0 0010 3.4V3a2 2 0 114 0v.2a1.7 1.7 0 002.9 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1A1.7 1.7 0 0021 10.6h.2a2 2 0 110 4H21z",
  }[name];
  if (!P) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d={P} /></svg>
  );
}

function ViewHeader({ title, note, right }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", marginBottom: 14, gap: 14, flexWrap: "wrap" }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: -0.4 }}>{title}</h1>
        {note && <div style={{ fontSize: 13, color: C.sub, marginTop: 3 }}>{note}</div>}
      </div>
      <div className="tt-noprint" style={{ marginLeft: "auto", display: "flex", gap: 8 }}>{right}</div>
    </div>
  );
}
function Panelhead({ text, count, tone }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px", borderBottom: `1px solid ${C.line}` }}>
      <span style={{ fontSize: 13, fontWeight: 700 }}>{text}</span>
      {count != null && <span style={{ fontSize: 12, fontWeight: 700, padding: "2px 9px", borderRadius: 20, background: tone === "free" ? C.freeSoft : C.primarySoft, color: tone === "free" ? C.free : C.primary }}>{count}</span>}
    </div>
  );
}
function Seg({ label, options, val, onChange }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.sub, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 9, padding: 4 }}>
        {options.map(([v, lbl]) => (
          <button key={v} className="tt-btn" onClick={() => onChange(v)} style={{ border: "none", padding: "6px 11px", borderRadius: 6, fontSize: 12.5, fontWeight: 600, background: String(val) === String(v) ? C.primary : "transparent", color: String(val) === String(v) ? "#fff" : C.sub }}>{lbl}</button>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Class timetable ---------------- */
function ClassView({ cfg, cls, expand, clashTokens }) {
  const ct = cfg.classTeacher[cls];
  return (
    <div>
      <ViewHeader title={`Class ${cls}`} note={`Class teacher: ${ct || "—"}`} right={<button className="tt-btn" onClick={printNow} style={ghostBtn}>Print / PDF</button>} />
      <div className="tt-printarea" style={card}>
        <div className="tt-printtitle" style={{ display: "none", fontWeight: 700, fontSize: 15, padding: "10px 12px" }}>{cfg.school} · Class {cls} · Class teacher {ct || "—"}</div>
        <GridTable cfg={cfg} render={(d, pi) => {
          const [t, s] = cfg.grid[cls][d][pi];
          const clash = expand(t).some((x) => clashTokens(d, pi).has(x));
          return { t, s, bg: t ? (SUBJECT_TINT[s] || "#fff") : "#fafafa", clash, sub: s };
        }} />
      </div>
    </div>
  );
}

/* ---------------- Teacher timetable ---------------- */
function TeacherView({ cfg, tch, occupancy, teacherLoad, combinedByBase }) {
  const ld = teacherLoad[tch] || { target: 0, placed: 0 };
  const lookup = (d, pi) => {
    const e = occupancy[d]?.[pi]?.tok?.get(tch); if (!e) return null;
    if (e.norm.size) { const cn = [...e.norm][0]; const slot = cfg.grid[cn][d][pi]; return { cn, subj: slot[1], code: slot[0] }; }
    const base = [...e.comb][0]; const divs = [...(occupancy[d][pi].sessions.get(base) || [])];
    const sess = combinedByBase[base];
    return { cn: divs.join(" "), subj: sess?.sub, code: base, combined: true };
  };
  let placed = 0; cfg.days.forEach((d) => cfg.periods.forEach((p, pi) => { if (lookup(d, pi)) placed++; }));
  const freeCount = cfg.days.length * cfg.periods.length - placed;
  return (
    <div>
      <ViewHeader title={`Teacher ${tch}`} note={`${placed} periods placed · ${freeCount} free · B-Key target ${ld.target}`} right={<button className="tt-btn" onClick={printNow} style={ghostBtn}>Print / PDF</button>} />
      <div className="tt-printarea" style={card}>
        <div className="tt-printtitle" style={{ display: "none", fontWeight: 700, fontSize: 15, padding: "10px 12px" }}>{cfg.school} · Teacher {tch}</div>
        <GridTable cfg={cfg} render={(d, pi) => {
          const r = lookup(d, pi);
          if (!r) return { free: true, bg: C.freeSoft };
          return { t: r.cn, s: `${r.subj || ""}${r.combined ? " · language" : r.code !== tch ? " · " + r.code : ""}`, bg: r.combined ? C.accentSoft : SUBJECT_TINT[r.subj] || "#fff", sub: r.subj };
        }} />
      </div>
    </div>
  );
}

/* generic weekly grid renderer */
function MobilePicker({ label, items, value, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 10, padding: "8px 10px" }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
      <select className="tt-sel" style={{ flex: 1, fontSize: 14, padding: "9px 10px", fontFamily: mono, fontWeight: 700 }} value={value} onChange={(e) => onChange(e.target.value)}>
        {items.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
    </div>
  );
}

function NavDrawer({ open, onClose, view, setView, TH, school, theme, setTheme, onSignOut }) {
  if (!open) return null;
  return (
    <div onClick={onClose} className="tt-noprint" style={{ position: "fixed", inset: 0, background: "rgba(16,25,40,.45)", zIndex: 90 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: 280, maxWidth: "84%", background: "#fff", boxShadow: "2px 0 24px rgba(0,0,0,.25)", display: "flex", flexDirection: "column", animation: "ttslide .2s ease" }}>
        <div style={{ background: `linear-gradient(115deg, ${TH.g2}, ${TH.g1})`, color: "#fff", padding: "18px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15 }}>{school}</div>
            <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.8)" }}>Timetable Manager</div>
          </div>
          <button className="tt-btn" onClick={onClose} aria-label="Close" style={{ border: "none", background: "transparent", color: "#fff", fontSize: 24, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ overflowY: "auto", padding: "8px 0", flex: 1 }}>
          {TABS.map(([k, label]) => (
            <div key={k} onClick={() => { setView(k); onClose(); }} style={{ padding: "13px 20px", fontSize: 14.5, fontWeight: view === k ? 700 : 500, color: view === k ? TH.accent : C.ink, background: view === k ? `${TH.accent}14` : "transparent", borderLeft: view === k ? `4px solid ${TH.accent}` : "4px solid transparent", cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}><Icon name={k} size={18} />{label}</div>
          ))}
        </div>
        {onSignOut && (
          <div style={{ borderTop: `1px solid ${C.line}`, padding: "12px 18px" }}>
            <button className="tt-btn" onClick={() => { onSignOut(); onClose(); }} style={{ width: "100%", border: `1px solid ${C.line}`, background: "#fff", color: C.clash, padding: "10px", borderRadius: 9, fontSize: 13.5, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
              Sign out
            </button>
          </div>
        )}
        <div style={{ borderTop: `1px solid ${C.line}`, padding: "14px 18px" }}>
          <div style={{ fontSize: 11, color: C.sub, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>Theme</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {Object.entries(THEMES).map(([key, t]) => (
              <button key={key} className="tt-btn" onClick={() => setTheme(key)} title={t.name} aria-label={t.name} style={{ width: 30, height: 30, borderRadius: 30, cursor: "pointer", background: `linear-gradient(135deg, ${t.g1}, ${t.g2})`, border: theme === key ? `3px solid ${C.ink}` : "2px solid #fff", boxShadow: "0 1px 4px rgba(0,0,0,.2)" }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function GridTable({ cfg, render }) {
  return (
    <div className="tt-scroll" style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
    <table style={{ ...tbl, minWidth: (cfg.days.length + 1) * 78 }}>
      <thead>
        <tr><th style={{ ...th, width: 54 }}>Period</th>{cfg.days.map((d) => <th key={d} style={th}>{DAY_FULL[d]}</th>)}</tr>
      </thead>
      <tbody>
        {cfg.periods.map((p, pi) => (
          <tr key={p}>
            <td style={perTd}>{p}</td>
            {cfg.days.map((d) => {
              const r = render(d, pi);
              const bar = r.sub ? SUBJECT_BAR[r.sub] : null;
              return (
                <td key={d} className="tt-cellhover" style={{ ...cellTd, background: r.bg, boxShadow: r.clash ? `inset 0 0 0 2px ${C.clash}` : bar ? `inset 3px 0 0 ${bar}` : "none" }}>
                  {r.free ? <span style={{ color: C.free, fontSize: 11, fontWeight: 600 }}>free</span>
                    : r.t ? (<><div style={{ fontFamily: mono, fontWeight: 700, fontSize: 12.5, color: C.ink }}>{r.t}</div><div style={{ fontSize: 10.5, color: bar || C.sub, marginTop: 2, fontWeight: 600, letterSpacing: 0.2 }}>{r.s}</div></>)
                    : <span style={{ color: "#c4ccd6", fontSize: 12 }}>—</span>}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

/* ---------------- Free & substitution ---------------- */
function FreeView({ cfg, occupancy, fday, setFday, fper, setFper, mobile }) {
  const pi = fper - 1;
  const occ = occupancy[fday]?.[pi]?.tok || new Map();
  const freeTeachers = cfg.singles.filter((t) => !occ.has(t));
  const running = cfg.classes.map((cn) => ({ cn, slot: cfg.grid[cn][fday][pi] })).filter((x) => x.slot[0]);
  return (
    <div>
      <ViewHeader title="Free teachers & substitution" note="Pick a slot to see who can cover it" />
      <div className="tt-noprint" style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <Seg label="Day" options={cfg.days.map((d) => [d, DAY_FULL[d].slice(0, 3)])} val={fday} onChange={setFday} />
        <Seg label="Period" options={cfg.periods.map((p) => [p, "P" + p])} val={fper} onChange={(v) => setFper(+v)} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 16, alignItems: "start" }}>
        <div style={card}>
          <Panelhead text={`Free at ${DAY_FULL[fday]} · P${fper}`} count={freeTeachers.length} tone="free" />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7, padding: 14 }}>
            {freeTeachers.length ? freeTeachers.map((t) => (<span key={t} style={{ fontFamily: mono, fontSize: 12.5, fontWeight: 600, padding: "5px 10px", background: C.freeSoft, color: C.free, borderRadius: 7 }}>{t}</span>)) : <span style={{ color: C.sub, fontSize: 13 }}>Every teacher is engaged this period.</span>}
          </div>
        </div>
        <div style={card}>
          <Panelhead text={`Running at ${DAY_FULL[fday]} · P${fper}`} count={running.length} tone="primary" />
          <div style={{ maxHeight: 340, overflowY: "auto" }}>
            <table style={tbl}><tbody>
              {running.map(({ cn, slot }) => (
                <tr key={cn}>
                  <td style={{ ...cellTd, textAlign: "left", fontFamily: mono, fontWeight: 700, width: 60, height: 36 }}>{cn}</td>
                  <td style={{ ...cellTd, textAlign: "left", fontFamily: mono, height: 36 }}>{slot[0]}</td>
                  <td style={{ ...cellTd, textAlign: "left", color: C.sub, width: 64, height: 36 }}>{slot[1]}</td>
                </tr>
              ))}
            </tbody></table>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- B-Key & teacher load ---------------- */
function parseBKeyRows(arr) {
  const clean = (arr || []).filter((r) => r && r.some((x) => String(x == null ? "" : x).trim() !== ""));
  if (!clean.length) return [];
  const hdr = clean[0].map((x) => String(x == null ? "" : x).trim().toLowerCase());
  let ci = hdr.indexOf("class"), si = hdr.indexOf("subject"), ti = hdr.indexOf("teacher"), start = 0;
  if (ci >= 0 && si >= 0) start = 1; else { ci = 0; si = 1; ti = 2; }
  const out = [];
  for (let i = start; i < clean.length; i++) {
    const r = clean[i];
    const cls = String(r[ci] == null ? "" : r[ci]).trim();
    const sub = String(r[si] == null ? "" : r[si]).trim().toUpperCase();
    const teacher = String((ti >= 0 ? r[ti] : "") == null ? "" : r[ti]).trim();
    if (cls && sub) out.push({ cls, sub, teacher });
  }
  return out;
}

function BKeyView({ cfg, cls, update, expand, teacherLoad, mobile }) {
  const rows = cfg.bkey[cls] || [];
  const fileRef = useRef(null);
  const [imp, setImp] = useState("");
  const onImport = async (file) => {
    if (!file) return;
    setImp("");
    try {
      let data;
      if (/\.xlsx?$/i.test(file.name)) { const XLSX = await import("xlsx"); const wb = XLSX.read(await file.arrayBuffer(), { type: "array" }); data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }); }
      else { data = (await file.text()).split(/\r?\n/).map((l) => l.split(",")); }
      const parsed = parseBKeyRows(data);
      if (!parsed.length) { setImp("No rows found. Use columns: Class, Subject, Teacher."); return; }
      update((n) => {
        const byClass = {};
        for (const r of parsed) {
          const teacher = r.teacher || (n.singles[0] || "");
          (byClass[r.cls] ||= []).push({ sub: r.sub, teacher });
          if (!n.classes.includes(r.cls)) { n.classes.push(r.cls); n.classTeacher[r.cls] = null; n.grid[r.cls] = {}; n.days.forEach((d) => (n.grid[r.cls][d] = emptyDay())); }
          const st = stdOf(r.cls); if (!n.stdPeriods[st]) n.stdPeriods[st] = {};
          if (r.sub && !n.subjects.includes(r.sub)) n.subjects.push(r.sub);
          if (teacher && teacher.indexOf(" ") < 0 && !n.singles.includes(teacher)) n.singles.push(teacher);
        }
        for (const c in byClass) n.bkey[c] = byClass[c];
        n.singles.sort();
      });
      setImp(`Imported ${parsed.length} B-Key row(s) across ${new Set(parsed.map((r) => r.cls)).size} class(es). Set each standard's periods in the table above.`);
    } catch (e) {
      setImp("Couldn't read that file. A CSV with columns Class, Subject, Teacher always works. (Excel .xlsx works on the deployed app.)");
    }
  };
  const std = stdOf(cls);
  const totalKeyed = rows.reduce((a, r) => a + periodsFor(cfg, cls, r.sub), 0);
  const weekSlots = cfg.days.length * cfg.periods.length;
  const combinedNames = (cfg.combined || []).map((s) => s.name);

  const setRow = (i, field, val) => update((n) => { n.bkey[cls][i][field] = val; });
  const addRow = () => update((n) => { (n.bkey[cls] ||= []).push({ sub: cfg.subjects[0], teacher: cfg.singles[0] }); });
  const delRow = (i) => update((n) => { n.bkey[cls].splice(i, 1); });
  const setCT = (v) => update((n) => { n.classTeacher[cls] = v; });

  return (
    <div>
      <ViewHeader title={`B-Key · Class ${cls}`} note={`Periods come from Standard ${std}. Here you just assign the teacher for each subject.`} right={<>
        <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={(e) => onImport(e.target.files && e.target.files[0])} style={{ display: "none" }} />
        <button className="tt-btn" onClick={() => fileRef.current && fileRef.current.click()} style={solidBtn}>Import CSV / Excel</button>
      </>} />
      {imp && <Banner tone="primary">{imp}</Banner>}

      <StandardPeriods cfg={cfg} update={update} highlightStd={std} />

      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "minmax(0,1.3fr) minmax(0,1fr)", gap: 16, alignItems: "start", marginTop: 16 }}>
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderBottom: `1px solid ${C.line}`, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Subject → teacher · {cls}</span>
            <label style={{ fontSize: 12, color: C.sub, marginLeft: "auto" }}>Class teacher:&nbsp;
              <select className="tt-sel" style={{ width: 120, display: "inline-block" }} value={cfg.classTeacher[cls] || ""} onChange={(e) => setCT(e.target.value)}>
                <option value="">—</option>{cfg.singles.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
          </div>
          <table style={tbl}>
            <thead><tr><th style={{ ...th, textAlign: "left", paddingLeft: 12 }}>Subject</th><th style={{ ...th, textAlign: "left" }}>Teacher</th><th style={{ ...th, width: 62 }}>Periods</th><th style={{ ...th, width: 40 }}></th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td style={{ ...cellTd, height: 40, padding: 5 }}>
                    <select className="tt-sel" value={r.sub} onChange={(e) => setRow(i, "sub", e.target.value)}>{cfg.subjects.map((s) => <option key={s}>{s}</option>)}</select>
                  </td>
                  <td style={{ ...cellTd, height: 40, padding: 5 }}>
                    <select className="tt-sel" value={r.teacher} onChange={(e) => setRow(i, "teacher", e.target.value)}>
                      <optgroup label="Teachers">{cfg.singles.map((t) => <option key={t}>{t}</option>)}</optgroup>
                      {combinedNames.length > 0 && <optgroup label="Language sessions">{combinedNames.map((t) => <option key={t}>{t}</option>)}</optgroup>}
                    </select>
                  </td>
                  <td style={{ ...cellTd, height: 40 }}>
                    <span style={{ fontFamily: mono, fontWeight: 700, fontSize: 13, color: periodsFor(cfg, cls, r.sub) ? C.primary : C.clash }} title="Set in the Standard periods table above">{periodsFor(cfg, cls, r.sub)}</span>
                  </td>
                  <td style={{ ...cellTd, height: 40, padding: 5 }}>
                    <button className="tt-btn" onClick={() => delRow(i)} title="Remove" style={{ border: "none", background: "transparent", color: C.clash, fontSize: 16, cursor: "pointer" }}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", gap: 12 }}>
            <button className="tt-btn" onClick={addRow} style={ghostBtn}>+ Add subject</button>
            <span style={{ fontSize: 12.5, color: totalKeyed > weekSlots ? C.clash : C.sub, marginLeft: "auto" }}>
              {totalKeyed} periods keyed of {weekSlots} weekly slots{totalKeyed > weekSlots ? " · over capacity" : ""}
            </span>
          </div>
        </div>

        <TeacherLoad cfg={cfg} teacherLoad={teacherLoad} />
      </div>
    </div>
  );
}

function NumInput({ value, onCommit }) {
  const [v, setV] = useState(String(value));
  const focused = React.useRef(false);
  useEffect(() => { if (!focused.current) setV(String(value)); }, [value]);
  const commit = (raw) => { const n = Math.max(0, parseInt(raw, 10) || 0); onCommit(n); };
  return (
    <input className="tt-in" type="number" min={0} inputMode="numeric" style={{ textAlign: "center", width: 52 }}
      value={v}
      onFocus={(e) => { focused.current = true; e.target.select(); }}
      onChange={(e) => { setV(e.target.value); commit(e.target.value); }}
      onBlur={() => { focused.current = false; setV(String(Math.max(0, parseInt(v, 10) || 0))); }} />
  );
}

function StandardPeriods({ cfg, update, highlightStd }) {
  const stds = standardsOf(cfg);
  const set = (s, sub, val) => update((n) => { (n.stdPeriods[s] ||= {})[sub] = Math.max(0, +val || 0); });
  const colTotal = (s) => cfg.subjects.reduce((a, sub) => a + (Number(cfg.stdPeriods?.[s]?.[sub]) || 0), 0);
  return (
    <div style={{ ...card }}>
      <Panelhead text="Standard periods — set once, every division inherits" />
      <div style={{ overflowX: "auto" }}>
        <table style={{ ...tbl, minWidth: 420 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", paddingLeft: 12, width: 90 }}>Subject</th>
              {stds.map((s) => <th key={s} style={{ ...th, background: s === highlightStd ? C.primarySoft : "#fbfbf9", color: s === highlightStd ? C.primary : C.sub }}>Std {s}</th>)}
            </tr>
          </thead>
          <tbody>
            {cfg.subjects.map((sub) => (
              <tr key={sub}>
                <td style={{ ...cellTd, textAlign: "left", paddingLeft: 12, fontFamily: mono, fontWeight: 700, height: 36, background: SUBJECT_TINT[sub] || "#fff" }}>{sub}</td>
                {stds.map((s) => (
                  <td key={s} style={{ ...cellTd, height: 36, padding: 4, background: s === highlightStd ? "#f4fafa" : "#fff" }}>
                    <NumInput value={cfg.stdPeriods?.[s]?.[sub] ?? 0} onCommit={(v) => set(s, sub, v)} />
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td style={{ ...cellTd, textAlign: "left", paddingLeft: 12, fontWeight: 700, fontSize: 12, color: C.sub, height: 32 }}>Total / week</td>
              {stds.map((s) => { const t = colTotal(s); const cap = cfg.days.length * cfg.periods.length; return <td key={s} style={{ ...cellTd, height: 32, fontFamily: mono, fontWeight: 700, color: t > cap ? C.clash : C.sub }}>{t}/{cap}</td>; })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TeacherLoad({ cfg, teacherLoad }) {
  const [sort, setSort] = useState("code");
  let list = cfg.singles.map((t) => ({ t, ...teacherLoad[t] }));
  if (sort === "remaining") list.sort((a, b) => (b.target - b.placed) - (a.target - a.placed));
  else if (sort === "target") list.sort((a, b) => b.target - a.target);
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", padding: "11px 14px", borderBottom: `1px solid ${C.line}`, gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Teacher load</span>
        <select className="tt-sel" style={{ width: 130, marginLeft: "auto" }} value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="code">Sort: code</option><option value="remaining">Sort: remaining</option><option value="target">Sort: target</option>
        </select>
      </div>
      <div style={{ maxHeight: 520, overflowY: "auto" }}>
        <table style={tbl}>
          <thead><tr>
            <th style={{ ...th, textAlign: "left", paddingLeft: 12 }}>Teacher</th>
            <th style={{ ...th, width: 60 }}>Placed</th><th style={{ ...th, width: 60 }}>Target</th><th style={{ ...th, width: 90 }}>Status</th>
          </tr></thead>
          <tbody>
            {list.map(({ t, placed = 0, target = 0 }) => {
              const rem = target - placed;
              const tone = placed > target ? C.clash : rem === 0 ? C.free : C.warn;
              const bg = placed > target ? C.clashSoft : rem === 0 ? C.freeSoft : C.warnSoft;
              const label = placed > target ? `over ${placed - target}` : rem === 0 ? "complete" : `${rem} left`;
              return (
                <tr key={t}>
                  <td style={{ ...cellTd, textAlign: "left", paddingLeft: 12, fontFamily: mono, fontWeight: 700, height: 34 }}>{t}</td>
                  <td style={{ ...cellTd, height: 34, fontFamily: mono }}>{placed}</td>
                  <td style={{ ...cellTd, height: 34, fontFamily: mono }}>{target}</td>
                  <td style={{ ...cellTd, height: 34 }}><span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: bg, color: tone }}>{label}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- Assign timetable (B-Key constrained) ---------------- */
function EditView({ cfg, cls, update, expand, clashTokens, occupancy, ask }) {
  const keys = cfg.bkey[cls] || [];
  const [report, setReport] = useState("");
  const [fzDay, setFzDay] = useState(cfg.days[0]);
  const [fzPer, setFzPer] = useState(1);
  const freezeAll = (on) => update((n) => { const pi = fzPer - 1; for (const c of n.classes) { const k = `${c}|${fzDay}|${pi}`; if (on) n.locked[k] = true; else delete n.locked[k]; } });
  const [caSub, setCaSub] = useState(cfg.subjects[0]);
  const [caLock, setCaLock] = useState(true);
  const assignAll = () => {
    const pi = fzPer - 1;
    update((n) => {
      for (const c of n.classes) {
        const row = (n.bkey[c] || []).find((r) => r.sub === caSub);
        const teacher = row ? row.teacher : caSub;
        n.grid[c][fzDay][pi] = [teacher, caSub];
        if (caLock) n.locked[`${c}|${fzDay}|${pi}`] = true;
      }
    });
    setReport(`Assigned ${caSub} to ${DAY_FULL[fzDay]} P${fzPer} for all ${cfg.classes.length} classes${caLock ? " and locked it" : ""}.`);
  };
  const clearSlotAll = () => update((n) => { const pi = fzPer - 1; for (const c of n.classes) { n.grid[c][fzDay][pi] = [null, null]; delete n.locked[`${c}|${fzDay}|${pi}`]; } });
  const optKey = (r) => `${r.teacher}||${r.sub}`;

  const genAll = () => ask("Auto-generate a fresh, clash-free timetable for the whole school from the B-Key? This replaces every current assignment.", () => {
    const res = autoSchedule(cfg, "all");
    update((n) => { n.grid = res.grid; });
    setReport(res.unplaced === 0 ? "Generated a complete clash-free timetable for all classes." : `Generated with ${res.unplaced} lesson(s) that couldn't be placed — check teacher load vs. available slots.`);
  });
  const fillClass = () => {
    const res = autoSchedule(cfg, "class", cls);
    update((n) => { n.grid = res.grid; });
    setReport(`Filled empty slots for ${cls} around the existing timetable.`);
  };
  const clearClass = () => ask(`Clear the entire timetable for ${cls}?`, () => { update((n) => { for (const d of n.days) n.grid[cls][d] = emptyDay(); }); setReport(`Cleared ${cls}.`); });
  const clearAllTT = () => ask("Clear EVERY class's timetable and start completely blank? All locks are also removed.", () => { update((n) => { for (const c of n.classes) for (const d of n.days) n.grid[c][d] = emptyDay(); n.locked = {}; }); setReport("All timetables cleared — everything is blank."); });
  const toggleLock = (d, pi) => update((n) => { const k = `${cls}|${d}|${pi}`; if (n.locked[k]) delete n.locked[k]; else n.locked[k] = true; });

  const placedCount = (r) => {
    let n = 0;
    for (const d of cfg.days) cfg.grid[cls][d].forEach((s) => { if (s[0] === r.teacher && s[1] === r.sub) n++; });
    return n;
  };
  const setSlot = (d, pi, val) => update((n) => {
    if (!val) { n.grid[cls][d][pi] = [null, null]; return; }
    const [teacher, sub] = val.split("||");
    n.grid[cls][d][pi] = [teacher, sub];
  });

  return (
    <div>
      <ViewHeader title={`Assign timetable · Class ${cls}`} note="Each slot offers only this class's B-Key subjects. Picking one sets the teacher automatically." right={<>
        <button className="tt-btn" onClick={fillClass} style={ghostBtn}>Auto-fill {cls}</button>
        <button className="tt-btn" onClick={clearClass} style={ghostBtn}>Clear {cls}</button>
        <button className="tt-btn" onClick={clearAllTT} style={{ ...ghostBtn, color: C.clash }}>Clear all</button>
        <button className="tt-btn" onClick={genAll} style={solidBtn}>Auto-generate all</button>
      </>} />
      {report && <Banner tone="primary">{report}</Banner>}
      <Banner tone="warn">Tap the 🔓 on any slot to lock it. Locked slots (filled or empty) are kept exactly as they are when you Auto-generate — an empty locked slot stays blank (frozen for assembly, activities, etc.). Use “Clear all” to start blank.</Banner>
      <div style={{ ...card, marginBottom: 14, padding: 12, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.sub }}>Freeze a slot for ALL classes:</span>
        <select className="tt-sel" style={{ width: 130 }} value={fzDay} onChange={(e) => setFzDay(e.target.value)}>{cfg.days.map((d) => <option key={d} value={d}>{DAY_FULL[d]}</option>)}</select>
        <select className="tt-sel" style={{ width: 80 }} value={fzPer} onChange={(e) => setFzPer(+e.target.value)}>{cfg.periods.map((p) => <option key={p} value={p}>P{p}</option>)}</select>
        <button className="tt-btn" onClick={() => freezeAll(true)} style={solidBtn}>Freeze</button>
        <button className="tt-btn" onClick={() => freezeAll(false)} style={ghostBtn}>Unfreeze</button>
      </div>
      <div style={{ ...card, marginBottom: 14, padding: 12, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.sub }}>Assign a subject to ALL classes at</span>
        <select className="tt-sel" style={{ width: 130 }} value={fzDay} onChange={(e) => setFzDay(e.target.value)}>{cfg.days.map((d) => <option key={d} value={d}>{DAY_FULL[d]}</option>)}</select>
        <select className="tt-sel" style={{ width: 80 }} value={fzPer} onChange={(e) => setFzPer(+e.target.value)}>{cfg.periods.map((p) => <option key={p} value={p}>P{p}</option>)}</select>
        <span style={{ fontSize: 12.5, color: C.sub }}>subject</span>
        <select className="tt-sel" style={{ width: 110 }} value={caSub} onChange={(e) => setCaSub(e.target.value)}>{cfg.subjects.map((su) => <option key={su}>{su}</option>)}</select>
        <label style={{ fontSize: 12, color: C.sub, display: "inline-flex", alignItems: "center", gap: 5 }}><input type="checkbox" checked={caLock} onChange={(e) => setCaLock(e.target.checked)} /> lock it</label>
        <button className="tt-btn" onClick={assignAll} style={solidBtn}>Assign to all</button>
        <button className="tt-btn" onClick={clearSlotAll} style={{ ...ghostBtn, color: C.clash }}>Clear this slot (all)</button>
      </div>
      {keys.length === 0 && <Banner tone="warn">No B-Key set for {cls} yet. Add subjects in the “B-Key & teacher load” tab first.</Banner>}

      <div style={{ ...card, overflowX: "auto" }}>
        <table style={{ ...tbl, minWidth: 820 }}>
          <thead><tr><th style={{ ...th, width: 46 }}>P</th>{cfg.days.map((d) => <th key={d} style={th}>{DAY_FULL[d]}</th>)}</tr></thead>
          <tbody>
            {cfg.periods.map((p, pi) => (
              <tr key={p}>
                <td style={perTd}>{p}</td>
                {cfg.days.map((d) => {
                  const [t, s] = cfg.grid[cls][d][pi];
                  const cur = t ? `${t}||${s}` : "";
                  const locked = !!cfg.locked?.[`${cls}|${d}|${pi}`];
                  const inKey = keys.some((r) => optKey(r) === cur);
                  const clashedTok = expand(t).filter((x) => clashTokens(d, pi).has(x));
                  const clash = clashedTok.length > 0;
                  let where = [];
                  if (clash) {
                    const e = occupancy[d][pi].tok.get(clashedTok[0]);
                    if (e) where = [...new Set([...[...e.norm].filter((c) => c !== cls), ...[...e.comb]])];
                  }
                  return (
                    <td key={d} style={{ ...editTd, background: clash ? C.clashSoft : locked ? "#fff7e6" : "#fff", boxShadow: locked ? `inset 0 0 0 2px ${C.accent}` : "none" }}>
                      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 3 }}>
                        <button className="tt-btn" onClick={() => toggleLock(d, pi)} title={locked ? "Locked — auto-generate keeps this period" : "Lock this period"} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0, color: locked ? C.accent : "#c4ccd6" }}>{locked ? "🔒" : "🔓"}</button>
                      </div>
                      <select className="tt-sel" value={inKey || !t ? cur : "__off"} onChange={(e) => setSlot(d, pi, e.target.value === "__off" ? "" : e.target.value)}>
                        <option value="">— free —</option>
                        {keys.map((r, i) => <option key={i} value={optKey(r)}>{r.sub} — {r.teacher}</option>)}
                        {t && !inKey && <option value="__off">{s} — {t} (off-key)</option>}
                      </select>
                      {clash && <div style={{ fontSize: 10, color: C.clash, fontWeight: 700, marginTop: 3 }}>clash: {where.join(", ")}</div>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ ...card, marginTop: 16 }}>
        <Panelhead text={`${cls} · subject fulfilment`} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: 14 }}>
          {keys.map((r, i) => {
            const pl = placedCount(r); const need = periodsFor(cfg, cls, r.sub); const rem = need - pl;
            const tone = pl > need ? C.clash : rem === 0 ? C.free : C.warn;
            const bg = pl > need ? C.clashSoft : rem === 0 ? C.freeSoft : C.warnSoft;
            return (
              <span key={i} style={{ fontSize: 12, padding: "5px 10px", borderRadius: 8, background: bg, color: tone, fontWeight: 600 }}>
                <span style={{ fontFamily: mono }}>{r.sub}/{r.teacher}</span> {pl}/{need}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Scheduling rules ---------------- */
function RulesView({ cfg, update }) {
  const r = (sub) => cfg.rules?.[sub] || {};
  const setRule = (sub, field, val) => update((n) => { (n.rules[sub] ||= {}); if (val === null || val === "" || (Array.isArray(val) && !val.length)) delete n.rules[sub][field]; else n.rules[sub][field] = val; });
  const toggleForbid = (sub, p) => { const cur = new Set(r(sub).forbid || []); cur.has(p) ? cur.delete(p) : cur.add(p); setRule(sub, "forbid", [...cur].sort((a, b) => a - b)); };

  return (
    <div>
      <ViewHeader title="Scheduling rules" note="Conditions the auto-generator must respect. Set them, then press Auto-generate on the Assign tab." />
      <Banner tone="primary">Rules are applied when you Auto-generate. Each is per subject and applies to every class. If a rule is impossible (e.g. a subject taught by one teacher pinned to the same period for all classes), the generator will leave those lessons unplaced and tell you.</Banner>
      <div style={{ ...card, overflowX: "auto" }}>
        <table style={{ ...tbl, minWidth: 920, tableLayout: "auto" }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", paddingLeft: 14 }}>Subject</th>
              <th style={th}>Time of day</th>
              <th style={th}>Pin to period</th>
              <th style={{ ...th, textAlign: "left" }}>Never at periods</th>
              <th style={th}>Different period each day</th>
            </tr>
          </thead>
          <tbody>
            {cfg.subjects.map((sub) => {
              const ru = r(sub);
              return (
                <tr key={sub}>
                  <td style={{ ...cellTd, textAlign: "left", paddingLeft: 14, height: 46 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: SUBJECT_BAR[sub] || C.sub }} />
                      <span style={{ fontFamily: mono, fontWeight: 700 }}>{sub}</span>
                    </span>
                  </td>
                  <td style={{ ...cellTd, height: 46 }}>
                    <select className="tt-sel" style={{ width: 130, margin: "0 auto" }} value={ru.band || "any"} onChange={(e) => setRule(sub, "band", e.target.value === "any" ? null : e.target.value)}>
                      <option value="any">Any time</option><option value="early">Prefer morning</option><option value="late">Prefer afternoon</option>
                    </select>
                  </td>
                  <td style={{ ...cellTd, height: 46 }}>
                    <select className="tt-sel" style={{ width: 90, margin: "0 auto" }} value={ru.pin || ""} onChange={(e) => setRule(sub, "pin", e.target.value ? +e.target.value : null)}>
                      <option value="">—</option>{cfg.periods.map((p) => <option key={p} value={p}>P{p}</option>)}
                    </select>
                  </td>
                  <td style={{ ...cellTd, textAlign: "left", height: 46 }}>
                    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                      {cfg.periods.map((p) => { const on = (ru.forbid || []).includes(p); return (
                        <button key={p} className="tt-btn" onClick={() => toggleForbid(sub, p)} style={{ width: 28, height: 26, borderRadius: 6, fontSize: 11.5, fontWeight: 700, border: `1px solid ${on ? C.clash : C.line}`, background: on ? C.clash : "#fff", color: on ? "#fff" : C.sub }}>{p}</button>
                      ); })}
                    </span>
                  </td>
                  <td style={{ ...cellTd, height: 46 }}>
                    <Toggle on={!!ru.distinct} onClick={() => setRule(sub, "distinct", ru.distinct ? null : true)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ClassRulesPanel cfg={cfg} update={update} />
      <TwicePanel cfg={cfg} update={update} />
      <p style={{ fontSize: 12.5, color: C.sub, marginTop: 12, lineHeight: 1.6 }}>
        “Once per day” (no subject twice in a day for a class) is always enforced. Language sessions follow the same rules via their subject. After changing rules, go to Assign timetable → Auto-generate all to rebuild.
      </p>
    </div>
  );
}

function TwicePanel({ cfg, update }) {
  const stds = standardsOf(cfg);
  const on = (s, sub) => !!(cfg.twice?.[s]?.[sub]);
  const toggle = (s, sub) => update((n) => { (n.twice[s] ||= {}); if (n.twice[s][sub]) delete n.twice[s][sub]; else n.twice[s][sub] = true; if (Object.keys(n.twice[s]).length === 0) delete n.twice[s]; });
  return (
    <div style={{ ...card, marginTop: 16 }}>
      <Panelhead text="Allow a subject twice a day — set per standard" />
      <div className="tt-scroll" style={{ overflowX: "auto" }}>
        <table style={{ ...tbl, minWidth: 420 }}>
          <thead><tr><th style={{ ...th, textAlign: "left", paddingLeft: 12, width: 100 }}>Subject</th>{stds.map((s) => <th key={s} style={th}>Std {s}</th>)}</tr></thead>
          <tbody>
            {cfg.subjects.map((sub) => (
              <tr key={sub}>
                <td style={{ ...cellTd, textAlign: "left", paddingLeft: 12, fontFamily: mono, fontWeight: 700, height: 40, background: SUBJECT_TINT[sub] || "#fff" }}>{sub}</td>
                {stds.map((s) => (
                  <td key={s} style={{ ...cellTd, height: 40 }}><div style={{ display: "flex", justifyContent: "center" }}><Toggle on={on(s, sub)} onClick={() => toggle(s, sub)} /></div></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ padding: "9px 14px", fontSize: 12, color: C.sub, lineHeight: 1.6 }}>
        Turn on for a subject in a standard when it has more weekly periods than working days (e.g. English 6 periods across 5 days). The generator may then place it twice on one weekday for classes in that standard, spread as evenly as possible. Off means at most once per day.
      </div>
    </div>
  );
}

function ClassRulesPanel({ cfg, update }) {
  const [c, setC] = useState(cfg.classes[0]);
  const cls = cfg.classes.includes(c) ? c : cfg.classes[0];
  const ct = cfg.classTeacher[cls];
  const ctRow = (cfg.bkey[cls] || []).find((r) => r.teacher === ct);
  const pairs = (cfg.bkey[cls] || []).filter((r) => !(cfg.combined || []).some((s) => s.name === r.teacher));
  const ruleAt = (p) => cfg.classRules?.[cls]?.[p];
  const encode = (r) => !r ? "" : r.kind === "ct" ? "ct" : `pair|${r.sub}|${r.teacher}`;
  const setRule = (p, val) => update((n) => {
    (n.classRules[cls] ||= {});
    if (!val) delete n.classRules[cls][p];
    else if (val === "ct") n.classRules[cls][p] = { kind: "ct" };
    else { const [, sub, teacher] = val.split("|"); n.classRules[cls][p] = { kind: "pair", sub, teacher }; }
    if (Object.keys(n.classRules[cls]).length === 0) delete n.classRules[cls];
  });
  const applyCTAll = () => update((n) => { for (const c of n.classes) { (n.classRules[c] ||= {}); n.classRules[c][1] = { kind: "ct" }; } });
  const clearCTAll = () => update((n) => { for (const c of n.classes) if (n.classRules[c]) { delete n.classRules[c][1]; if (Object.keys(n.classRules[c]).length === 0) delete n.classRules[c]; } });

  return (
    <div style={{ ...card, marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderBottom: `1px solid ${C.line}`, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Class-specific period rules</span>
        <label style={{ fontSize: 12, color: C.sub, marginLeft: "auto" }}>Class&nbsp;
          <select className="tt-sel" style={{ width: 100, display: "inline-block" }} value={cls} onChange={(e) => setC(e.target.value)}>{cfg.classes.map((x) => <option key={x}>{x}</option>)}</select>
        </label>
        <span style={{ fontSize: 12, color: C.sub }}>Class teacher: <b style={{ fontFamily: mono, color: C.ink }}>{ct || "—"}</b>{ctRow ? ` (${ctRow.sub})` : ""}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "10px 14px", borderBottom: `1px solid ${C.line}` }}>
        <button className="tt-btn" onClick={applyCTAll} style={solidBtn}>Set P1 = class teacher for ALL classes</button>
        <button className="tt-btn" onClick={clearCTAll} style={ghostBtn}>Clear P1 rule (all)</button>
      </div>
      <div style={{ padding: 14, display: "grid", gap: 8 }}>
        {cfg.periods.map((p) => (
          <div key={p} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: mono, fontWeight: 800, color: C.primary, width: 34 }}>P{p}</span>
            <select className="tt-sel" style={{ maxWidth: 320 }} value={encode(ruleAt(p))} onChange={(e) => setRule(p, e.target.value)}>
              <option value="">No rule — scheduler decides</option>
              {ct && <option value="ct">Class teacher{ctRow ? ` — ${ct} (${ctRow.sub})` : ` — ${ct}`}</option>}
              {pairs.map((r, i) => <option key={i} value={`pair|${r.sub}|${r.teacher}`}>{r.sub} — {r.teacher}</option>)}
            </select>
          </div>
        ))}
      </div>
      <div style={{ padding: "0 14px 14px", fontSize: 12, color: C.sub, lineHeight: 1.6 }}>
        A ruled period is filled on every working day — up to that subject’s weekly period count, then any remaining days are filled normally. “Class teacher” resolves to whatever subject the class teacher takes in {cls}. These override the global subject rules for this class.
      </div>
    </div>
  );
}

function Toggle({ on, onClick }) {
  return (
    <button className="tt-btn" onClick={onClick} style={{ width: 44, height: 24, borderRadius: 20, border: "none", background: on ? C.primary : "#cfd4d6", position: "relative", cursor: "pointer", transition: "background .15s" }}>
      <span style={{ position: "absolute", top: 3, left: on ? 23 : 3, width: 18, height: 18, borderRadius: 20, background: "#fff", transition: "left .15s", boxShadow: "0 1px 2px rgba(0,0,0,.2)" }} />
    </button>
  );
}

/* ---------------- AI assistant ---------------- */
function buildContext(cfg, teacherLoad) {
  const L = [];
  L.push(`School: ${cfg.school}. Working days (codes): ${cfg.days.join(", ")}. Periods: 1-${cfg.periods.length}.`);
  L.push(`Classes: ${cfg.classes.join(", ")}.`);
  L.push(`Subjects: ${cfg.subjects.join(", ")}.`);
  L.push(`Standard periods/week: ` + standardsOf(cfg).map((s) => `Std ${s} {` + cfg.subjects.filter((su) => cfg.stdPeriods?.[s]?.[su]).map((su) => `${su}:${cfg.stdPeriods[s][su]}`).join(",") + `}`).join("; "));
  if ((cfg.combined || []).length) L.push(`Language (parallel) sessions: ` + cfg.combined.map((s) => `${s.name} [teachers ${s.teachers.join("/")}; divisions ${s.divisions.join("/")}]`).join("; "));
  const rl = Object.entries(cfg.rules || {}).filter(([, v]) => v && Object.keys(v).length);
  if (rl.length) L.push(`Scheduling rules: ` + rl.map(([s, v]) => `${s}{${[v.pin ? "pin P" + v.pin : "", v.forbid?.length ? "never P" + v.forbid.join("/P") : "", v.band ? v.band : "", v.distinct ? "distinct-periods" : ""].filter(Boolean).join(",")}}`).join("; "));
  const crl = Object.entries(cfg.classRules || {}).filter(([, v]) => v && Object.keys(v).length);
  if (crl.length) L.push(`Class period rules: ` + crl.map(([c, m]) => `${c}{` + Object.entries(m).map(([p, r]) => `P${+p + 1}=${r.kind === "ct" ? "classteacher(" + (cfg.classTeacher[c] || "?") + ")" : r.sub + "/" + r.teacher}`).join(",") + `}`).join("; "));
  L.push(`Teacher load placed/target: ` + cfg.singles.map((t) => `${t} ${teacherLoad[t]?.placed || 0}/${teacherLoad[t]?.target || 0}`).join(", "));
  L.push(`Class teachers: ` + cfg.classes.map((c) => `${c}:${cfg.classTeacher[c] || "-"}`).join(", "));
  L.push(`TIMETABLE (class | DAY: p1..p${cfg.periods.length} as subject/teacher, '-' empty):`);
  for (const c of cfg.classes) {
    const days = cfg.days.map((d) => `${d}: ` + cfg.grid[c][d].map((s) => (s[0] ? `${s[1]}/${s[0]}` : "-")).join(" ")).join(" | ");
    L.push(`${c} || ${days}`);
  }
  return L.join("\n");
}

function AssistantView({ cfg, update, teacherLoad }) {
  const [msgs, setMsgs] = useState([{ role: "assistant", text: "Ask me anything about the timetable — who's free Tuesday P3, who can cover for an absent teacher, which classes a teacher has — or tell me to make a change, like “move 5 A's maths to Monday morning” or “swap PET and BS on Wednesday for 6 B”." }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const apply = (actions) => {
    if (!actions?.length) return 0;
    let n = 0;
    update((cur) => {
      for (const a of actions) {
        const c = a.class, d = a.day, p = (a.period | 0) - 1;
        if (!cur.grid[c] || !cur.grid[c][d] || p < 0 || p >= cur.periods.length) continue;
        if (a.op === "clear") { cur.grid[c][d][p] = [null, null]; n++; }
        else if (a.op === "set") { cur.grid[c][d][p] = [a.teacher || null, a.sub || null]; n++; }
      }
    });
    return n;
  };

  const send = async () => {
    const q = input.trim(); if (!q || busy) return;
    setErr(""); setInput(""); const history = [...msgs, { role: "user", text: q }]; setMsgs(history); setBusy(true);
    const system = `You are the scheduling assistant embedded in a school timetable app. Use ONLY the data below to answer. Be concise and concrete (name teachers, classes, days, periods). When the user asks to change the timetable, return edit actions; otherwise return an empty actions array.
Rules you must respect when proposing changes: a teacher cannot be in two regular classes in the same day+period; language sessions run in parallel and are shared across their divisions; use exact class names, day codes and teacher/subject codes from the data.
ALWAYS reply with STRICT JSON only, no markdown, in this shape:
{"reply":"<short text for the user>","actions":[{"op":"set","class":"5 A","day":"MON","period":3,"teacher":"KPM","sub":"MAT"},{"op":"clear","class":"5 A","day":"MON","period":3}]}

DATA:
${buildContext(cfg, teacherLoad)}`;
    try {
      const res = await fetch("/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ system, messages: history.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text })) }) });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const text = data.text || "";
      let parsed; try { parsed = JSON.parse(text.replace(/```json|```/g, "").trim()); } catch { parsed = { reply: text || "(no response)", actions: [] }; }
      const applied = apply(parsed.actions);
      setMsgs((m) => [...m, { role: "assistant", text: parsed.reply + (applied ? `\n\n✓ Applied ${applied} change${applied > 1 ? "s" : ""}.` : ""), actions: parsed.actions }]);
    } catch (e) {
      setErr("Couldn't reach the AI service. The assistant runs inside the Claude.ai preview; when you self-host this app you'll need to route it through your own Anthropic API key.");
    } finally { setBusy(false); }
  };

  return (
    <div>
      <ViewHeader title="AI assistant" note="Natural-language questions and edits over your live timetable" />
      <div style={{ ...card, display: "flex", flexDirection: "column", height: "calc(100vh - 220px)" }}>
        <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {msgs.map((m, i) => (
            <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "82%", background: m.role === "user" ? C.primary : "#f3f2ee", color: m.role === "user" ? "#fff" : C.ink, padding: "10px 13px", borderRadius: 12, fontSize: 13.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{m.text}</div>
          ))}
          {busy && <div style={{ alignSelf: "flex-start", color: C.sub, fontSize: 13, padding: "4px 6px" }}>thinking…</div>}
          {err && <div style={{ alignSelf: "stretch", color: C.clash, fontSize: 12.5, background: C.clashSoft, padding: "10px 12px", borderRadius: 10 }}>{err}</div>}
        </div>
        <div style={{ borderTop: `1px solid ${C.line}`, padding: 12, display: "flex", gap: 8 }}>
          <input className="tt-in" style={{ flex: 1, fontFamily: sans, fontSize: 14, padding: "10px 12px" }} placeholder="Ask or instruct…" value={input}
            onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} disabled={busy} />
          <button className="tt-btn" onClick={send} disabled={busy} style={{ ...solidBtn, opacity: busy ? 0.6 : 1 }}>Send</button>
        </div>
      </div>
      <p style={{ fontSize: 12, color: C.sub, marginTop: 10 }}>The assistant can read the whole timetable and make edits on request. Review changes in the Class or Assign views — use Reset if an edit isn't what you wanted.</p>
    </div>
  );
}

/* ---------------- Language (combined) sessions ---------------- */
function CombinedView({ cfg, update, ask, mobile, occupancy }) {
  const sessions = cfg.combined || [];
  const [sel, setSel] = useState(0);
  const i = Math.min(sel, Math.max(0, sessions.length - 1));
  const s = sessions[i];

  const editS = (fn) => update((n) => { fn(n.combined[i]); });
  const addSession = () => { update((n) => { (n.combined ||= []).push({ name: `LANG ${n.combined.length + 1}`, sub: "LAN", teachers: [], divisions: [] }); }); setSel(sessions.length); };
  const delSession = () => ask(`Remove language session “${s.name}”? It will be cleared from any timetable slots that use it.`, () => update((n) => {
    const nm = n.combined[i].name;
    for (const c of n.classes) for (const d of n.days) n.grid[c][d].forEach((slot) => { if (slot[0] === nm) { slot[0] = null; slot[1] = null; } });
    for (const c of n.classes) n.bkey[c] = (n.bkey[c] || []).filter((r) => r.teacher !== nm);
    n.combined.splice(i, 1);
  }));
  const rename = (nm) => editS((x) => { /* live typing */ x.name = nm; });
  const propagateName = (oldName, newName) => update((n) => {
    if (!newName || oldName === newName) return;
    for (const c of n.classes) for (const d of n.days) n.grid[c][d].forEach((slot) => { if (slot[0] === oldName) slot[0] = newName; });
    for (const c of n.classes) (n.bkey[c] || []).forEach((r) => { if (r.teacher === oldName) r.teacher = newName; });
  });
  const toggleArr = (field, val) => editS((x) => { const a = x[field]; const k = a.indexOf(val); k < 0 ? a.push(val) : a.splice(k, 1); });
  const setArr = (field, arr) => editS((x) => { x[field] = arr.slice(); });

  // scheduling: a session is "at" (d,p) if every member division has it there
  const scheduledAt = (d, p) => s && s.divisions.length > 0 && s.divisions.every((c) => cfg.grid[c]?.[d]?.[p]?.[0] === s.name);
  const toggleSlot = (d, p) => update((n) => {
    const ses = n.combined[i]; const on = ses.divisions.every((c) => n.grid[c]?.[d]?.[p]?.[0] === ses.name);
    for (const c of ses.divisions) { if (!n.grid[c]) continue; n.grid[c][d][p] = on ? [null, null] : [ses.name, ses.sub]; }
  });
  // detection: a member teacher already teaching a REGULAR class in this slot = real clash
  const teacherClashAt = (d, p) => {
    if (!s) return null;
    for (const t of s.teachers) { const e = occupancy?.[d]?.[p]?.tok?.get(t); if (e && e.norm && e.norm.size > 0) return t; }
    return null;
  };
  // a member division already has a different subject in this slot (would be overwritten)
  const overwriteAt = (d, p) => s ? s.divisions.filter((c) => { const cell = cfg.grid[c]?.[d]?.[p]; return cell && cell[0] && cell[0] !== s.name; }) : [];

  return (
    <div>
      <ViewHeader title="Language sessions" note="Define a parallel session once — its teachers and the divisions that merge for it. Placing it fills every division at once, and those teachers never clash with each other during it." />
      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "210px minmax(0,1fr)", gap: 16, alignItems: "start" }}>
        <div style={card}>
          <Panelhead text="Sessions" count={sessions.length} />
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {sessions.map((x, k) => (
              <div key={k} onClick={() => setSel(k)} style={{ padding: "9px 14px", cursor: "pointer", fontFamily: mono, fontSize: 12.5, fontWeight: k === i ? 700 : 500, color: k === i ? C.primary : C.ink, background: k === i ? C.primarySoft : "transparent", borderLeft: k === i ? `3px solid ${C.primary}` : "3px solid transparent" }}>
                {x.name}<div style={{ fontSize: 10.5, color: C.sub, fontWeight: 500 }}>{x.sub} · {x.teachers.length} teachers · {x.divisions.length} div</div>
              </div>
            ))}
          </div>
          <div style={{ padding: 12, borderTop: `1px solid ${C.line}` }}><button className="tt-btn" onClick={addSession} style={{ ...solidBtn, width: "100%" }}>+ New session</button></div>
        </div>

        {s ? (
          <div style={{ display: "grid", gap: 16 }}>
            <div style={card}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "11px 14px", borderBottom: `1px solid ${C.line}`, flexWrap: "wrap" }}>
                <input className="tt-in" style={{ width: 200, fontWeight: 700 }} value={s.name} onChange={(e) => rename(e.target.value)} onBlur={(e) => propagateName(s.name, e.target.value.trim())} />
                <label style={{ fontSize: 12, color: C.sub }}>Subject&nbsp;
                  <select className="tt-sel" style={{ width: 90, display: "inline-block" }} value={s.sub} onChange={(e) => editS((x) => (x.sub = e.target.value))}>{cfg.subjects.map((su) => <option key={su}>{su}</option>)}</select>
                </label>
                <button className="tt-btn" onClick={delSession} style={{ ...ghostBtn, marginLeft: "auto", color: C.clash }}>Remove session</button>
              </div>
              <div style={{ padding: 14, display: "grid", gap: 14 }}>
                <ChipPicker label="Teachers in this session" all={cfg.singles} selected={s.teachers} onToggle={(v) => toggleArr("teachers", v)} onSetAll={(a) => setArr("teachers", a)} />
                <ChipPicker label="Divisions that merge for it" all={cfg.classes} selected={s.divisions} onToggle={(v) => toggleArr("divisions", v)} onSetAll={(a) => setArr("divisions", a)} />
              </div>
            </div>

            <div style={card}>
              <Panelhead text="When does it run? Click a slot to place it in every division at once" />
              <div style={{ overflowX: "auto", padding: 12 }}>
                <table style={{ ...tbl, minWidth: 520 }}>
                  <thead><tr><th style={{ ...th, width: 50 }}>P</th>{cfg.days.map((d) => <th key={d} style={th}>{DAY_FULL[d].slice(0, 3)}</th>)}</tr></thead>
                  <tbody>
                    {cfg.periods.map((p, pi) => (
                      <tr key={p}><td style={perTd}>{p}</td>
                        {cfg.days.map((d) => {
                          const on = scheduledAt(d, pi);
                          const clashT = teacherClashAt(d, pi);
                          const ow = overwriteAt(d, pi);
                          const border = clashT ? C.clash : on ? C.accent : ow.length ? C.warn : null;
                          const bg = clashT ? C.clashSoft : on ? C.accentSoft : ow.length ? C.warnSoft : "#fff";
                          const title = clashT ? `Clash: ${clashT} is already teaching a class this period` : ow.length ? `Would overwrite ${ow.join(", ")}` : on ? "Running — click to remove" : "Click to place the block here";
                          return <td key={d} onClick={() => toggleSlot(d, pi)} title={title} style={{ ...cellTd, height: 40, cursor: "pointer", background: bg, boxShadow: border ? `inset 0 0 0 2px ${border}` : "none" }}>
                            {clashT ? <span style={{ color: C.clash, fontWeight: 700, fontSize: 11 }}>⚠ {clashT}</span>
                              : on ? <span style={{ color: C.accent, fontWeight: 700, fontSize: 11 }}>running</span>
                              : ow.length ? <span style={{ color: C.warn, fontWeight: 700, fontSize: 13 }}>+</span>
                              : <span style={{ color: "#cfcdc6", fontSize: 16 }}>+</span>}
                          </td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: "0 14px 12px", fontSize: 12, color: C.sub, lineHeight: 1.6 }}>“running” = placed for all {s.divisions.length} member division{s.divisions.length === 1 ? "" : "s"}. A <b style={{ color: C.clash }}>⚠ red</b> slot means one of this session’s teachers is already taking a regular class that period (a real clash) — avoid it. An <b style={{ color: C.warn }}>amber +</b> means placing will overwrite another subject in some division.</div>
            </div>
          </div>
        ) : <div style={{ ...card, padding: 24, color: C.sub }}>No language sessions yet. Create one to merge divisions for a parallel language period.</div>}
      </div>
    </div>
  );
}

function ChipPicker({ label, all, selected, onToggle, onSetAll }) {
  const set = new Set(selected);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>{label} · {selected.length}</span>
        {onSetAll && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button className="tt-btn" onClick={() => onSetAll(all)} style={{ border: "none", background: "transparent", color: C.primary, fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0 }}>Select all</button>
            <span style={{ color: C.line }}>|</span>
            <button className="tt-btn" onClick={() => onSetAll([])} style={{ border: "none", background: "transparent", color: C.clash, fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0 }}>Clear</button>
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {all.map((x) => { const on = set.has(x); return (
          <button key={x} className="tt-btn" onClick={() => onToggle(x)} style={{ fontFamily: mono, fontSize: 12.5, fontWeight: 600, padding: "7px 11px", borderRadius: 7, border: `1px solid ${on ? C.primary : C.line}`, background: on ? C.primary : "#fff", color: on ? "#fff" : C.sub }}>{x}</button>
        ); })}
      </div>
    </div>
  );
}

/* ---------------- Analysis & pre-generation checks ---------------- */
function AnalysisView({ cfg, teacherLoad, mobile }) {
  const cap = cfg.days.length * cfg.periods.length;
  const R = (sub) => cfg.rules?.[sub] || {};

  // teacher -> subjects taught
  const singles = new Set(cfg.singles);
  const tSubs = {};
  const addSub = (tk, sub) => { (tSubs[tk] ||= new Set()).add(sub); };
  for (const c of cfg.classes) for (const row of cfg.bkey[c] || []) {
    const combined = (cfg.combined || []).find((s) => s.name === row.teacher);
    if (combined) combined.teachers.forEach((tk) => singles.has(tk) && addSub(tk, combined.sub));
    else if (singles.has(row.teacher)) addSub(row.teacher, row.sub);
  }

  const frozen = Object.keys(cfg.locked || {}).length;

  // validation per teacher: required vs available (capacity minus forbidden slots for subjects they teach)
  const tRows = cfg.singles.map((t) => {
    const req = teacherLoad[t]?.target || 0;
    const forb = new Set();
    (tSubs[t] ? [...tSubs[t]] : []).forEach((sub) => (R(sub).forbid || []).forEach((p) => forb.add(p)));
    const avail = cap - forb.size * cfg.days.length;
    return { t, subs: tSubs[t] ? [...tSubs[t]].join(", ") : "—", req, avail, diff: avail - req, forb: forb.size };
  }).sort((a, b) => a.diff - b.diff);

  const shortages = tRows.filter((r) => r.diff < 0);

  const classRows = cfg.classes.map((c) => {
    const req = (cfg.bkey[c] || []).reduce((a, r) => a + periodsFor(cfg, c, r.sub), 0);
    const lk = Object.keys(cfg.locked || {}).filter((k) => k.startsWith(c + "|")).length;
    return { c, req, cap, lk, free: cap - req };
  });

  const subjRows = cfg.subjects.map((sub) => {
    let req = 0; for (const c of cfg.classes) for (const r of cfg.bkey[c] || []) if (r.sub === sub) req += periodsFor(cfg, c, sub);
    const tw = standardsOf(cfg).filter((st) => cfg.twice?.[st]?.[sub]).map((st) => "Std " + st).join(" ") || "—";
    return { sub, req, forbid: (R(sub).forbid || []).map((p) => "P" + p).join(" ") || "—", twice: tw };
  });

  const Cell = { ...cellTd, height: 34, fontFamily: mono };
  return (
    <div>
      <ViewHeader title="Analysis & pre-generation checks" note="Calculations and feasibility checks. Run these before Auto-generate." right={<button className="tt-btn" onClick={printNow} style={ghostBtn}>Print / PDF</button>} />

      <div style={{ ...card, marginBottom: 16, padding: 14, display: "flex", flexWrap: "wrap", gap: 10 }}>
        <button className="tt-btn" onClick={() => exportClassesPDF(cfg)} style={solidBtn}>Export all class timetables (A4 PDF)</button>
        <button className="tt-btn" onClick={() => exportTeachersPDF(cfg)} style={solidBtn}>Export all teacher timetables (A4 PDF)</button>
        <button className="tt-btn" onClick={() => exportFreeReportPDF(cfg)} style={ghostBtn}>Export teacher leisure report (A4 PDF)</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr 1fr" : "repeat(4,1fr)", gap: 12, marginBottom: 16 }}>
        <Stat label="Classes" value={cfg.classes.length} />
        <Stat label="Slots / class / week" value={cap} />
        <Stat label="Teachers" value={cfg.singles.length} />
        <Stat label="Frozen (locked) slots" value={frozen} tone={frozen ? "accent" : "sub"} />
      </div>

      <div className="tt-printarea" style={{ ...card, marginBottom: 16 }}>
        <Panelhead text="Feasibility check — teacher capacity" count={shortages.length ? `${shortages.length} shortage${shortages.length > 1 ? "s" : ""}` : "all OK"} tone={shortages.length ? undefined : "free"} />
        <div className="tt-scroll" style={{ overflowX: "auto" }}>
          <table style={{ ...tbl, minWidth: 620 }}>
            <thead><tr>
              <th style={{ ...th, textAlign: "left", paddingLeft: 12 }}>Teacher</th><th style={{ ...th, textAlign: "left" }}>Subjects</th>
              <th style={th}>Required</th><th style={th}>Available</th><th style={th}>Difference</th><th style={th}>Status</th>
            </tr></thead>
            <tbody>
              {tRows.map((r) => (
                <tr key={r.t}>
                  <td style={{ ...Cell, textAlign: "left", paddingLeft: 12, fontWeight: 700 }}>{r.t}</td>
                  <td style={{ ...cellTd, height: 34, textAlign: "left", fontSize: 11, color: C.sub }}>{r.subs}</td>
                  <td style={Cell}>{r.req}</td>
                  <td style={Cell}>{r.avail}</td>
                  <td style={{ ...Cell, color: r.diff < 0 ? C.clash : C.ink, fontWeight: 700 }}>{r.diff}</td>
                  <td style={{ ...cellTd, height: 34 }}><span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: r.diff < 0 ? C.clashSoft : C.freeSoft, color: r.diff < 0 ? C.clash : C.free }}>{r.diff < 0 ? `short ${-r.diff}` : "OK"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "10px 14px", fontSize: 12, color: C.sub, lineHeight: 1.6 }}>
          “Available” = weekly slots ({cap}) minus the periods that subject is forbidden from (e.g. PET not in P1 removes {cfg.days.length} slots per forbidden period). A negative difference means that teacher can’t fit all their periods under the current rules — reduce restrictions, or combine classes for that subject to cut the requirement.
        </div>
      </div>

      {shortages.length > 0 && (
        <Banner tone="warn">
          {shortages.map((r) => `${r.t} is short ${-r.diff} period(s) — roughly ${Math.ceil(-r.diff)} class(es) would need combining for their subject(s).`).join("  ")}
        </Banner>
      )}

      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 16 }}>
        <div style={card}>
          <Panelhead text="Per-subject totals" />
          <div className="tt-scroll" style={{ overflowX: "auto", maxHeight: 360, overflowY: "auto" }}>
            <table style={tbl}>
              <thead><tr><th style={{ ...th, textAlign: "left", paddingLeft: 12 }}>Subject</th><th style={th}>Total periods</th><th style={th}>Forbidden</th><th style={th}>Twice/day</th></tr></thead>
              <tbody>{subjRows.map((r) => (
                <tr key={r.sub}><td style={{ ...Cell, textAlign: "left", paddingLeft: 12, fontWeight: 700 }}>{r.sub}</td><td style={Cell}>{r.req}</td><td style={{ ...cellTd, height: 34, fontSize: 11, color: C.sub }}>{r.forbid}</td><td style={{ ...cellTd, height: 34, fontSize: 11 }}>{r.twice}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
        <div style={card}>
          <Panelhead text="Per-class load" />
          <div className="tt-scroll" style={{ overflowX: "auto", maxHeight: 360, overflowY: "auto" }}>
            <table style={tbl}>
              <thead><tr><th style={{ ...th, textAlign: "left", paddingLeft: 12 }}>Class</th><th style={th}>Required</th><th style={th}>Capacity</th><th style={th}>Free</th><th style={th}>Locked</th></tr></thead>
              <tbody>{classRows.map((r) => (
                <tr key={r.c}><td style={{ ...Cell, textAlign: "left", paddingLeft: 12, fontWeight: 700 }}>{r.c}</td><td style={Cell}>{r.req}</td><td style={Cell}>{r.cap}</td><td style={{ ...Cell, color: r.free < 0 ? C.clash : C.free }}>{r.free}</td><td style={Cell}>{r.lk || ""}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      </div>

      <TeacherFreeReport cfg={cfg} teacherLoad={teacherLoad} />
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div style={{ ...card, padding: "14px 16px" }}>
      <div style={{ fontSize: 26, fontWeight: 800, color: tone === "accent" ? C.accent : C.primary, letterSpacing: -0.5 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: C.sub, fontWeight: 600, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function TeacherFreeReport({ cfg, teacherLoad }) {
  const cap = cfg.days.length * cfg.periods.length;
  return (
    <div className="tt-printarea" style={{ ...card, marginTop: 16 }}>
      <Panelhead text="Teacher free-period report — free periods per day" />
      <div className="tt-scroll" style={{ overflowX: "auto" }}>
        <table style={{ ...tbl, minWidth: 120 + cfg.days.length * 70 }}>
          <thead><tr>
            <th style={{ ...th, textAlign: "left", paddingLeft: 12 }}>Teacher</th>
            {cfg.days.map((d) => <th key={d} style={th}>{DAY_FULL[d].slice(0, 3)}</th>)}
            <th style={th}>Total free</th>
          </tr></thead>
          <tbody>
            {cfg.singles.map((t) => {
              const placed = teacherLoad[t]?.placed || 0;
              const perDay = cfg.days.map((d) => {
                let busy = 0;
                for (const c of cfg.classes) { const slot = cfg.grid[c]?.[d]; if (!slot) continue; for (let p = 0; p < cfg.periods.length; p++) { const code = slot[p]?.[0]; if (code && (code === t || (code.includes(" ") && code.split(" ").includes(t)))) { busy++; break; } } }
                return cfg.periods.length; // placeholder replaced below
              });
              // compute free per day precisely
              const freeDay = cfg.days.map((d) => {
                let busy = 0;
                for (let p = 0; p < cfg.periods.length; p++) {
                  let on = false;
                  for (const c of cfg.classes) { const code = cfg.grid[c]?.[d]?.[p]?.[0]; if (code && (code === t || (code.includes(" ") && code.split(" ").includes(t)))) { on = true; break; } }
                  if (!on) busy++;
                }
                return busy;
              });
              const totalFree = cap - placed;
              return (
                <tr key={t}>
                  <td style={{ ...cellTd, height: 32, textAlign: "left", paddingLeft: 12, fontFamily: mono, fontWeight: 700 }}>{t}</td>
                  {freeDay.map((f, i) => <td key={i} style={{ ...cellTd, height: 32, fontFamily: mono, color: f === 0 ? C.clash : C.ink }}>{f}</td>)}
                  <td style={{ ...cellTd, height: 32, fontFamily: mono, fontWeight: 700, color: C.free }}>{totalFree}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: "8px 14px", fontSize: 12, color: C.sub }}>Numbers are free (leisure) periods available that day. Use Print / PDF above to export this report.</div>
    </div>
  );
}

/* ---------------- Classes & setup ---------------- */
function SetupView({ cfg, update, ask, mobile }) {
  const [name, setName] = useState("");
  const [ct, setCt] = useState("");
  const [clonefrom, setClonefrom] = useState(cfg.classes[0]);
  const [newSub, setNewSub] = useState("");
  const [newTch, setNewTch] = useState("");
  const [err, setErr] = useState("");

  const toggleDay = (d) => update((n) => {
    if (n.days.includes(d)) {
      n.days = n.days.filter((x) => x !== d);
      for (const c of n.classes) delete n.grid[c][d];
    } else {
      n.days = WEEK_ORDER.filter((x) => n.days.includes(x) || x === d);
      for (const c of n.classes) n.grid[c][d] = emptyDay();
    }
  });

  const addClass = () => {
    const nm = name.trim(); if (!nm) return;
    if (cfg.classes.includes(nm)) { setErr(`Class ${nm} already exists.`); return; }
    setErr("");
    update((n) => {
      n.classes.push(nm);
      n.classTeacher[nm] = ct || null;
      n.grid[nm] = {}; n.days.forEach((d) => (n.grid[nm][d] = emptyDay()));
      n.bkey[nm] = clonefrom && n.bkey[clonefrom] ? clone(n.bkey[clonefrom]) : [];
      const s = stdOf(nm);
      if (!n.stdPeriods[s]) {
        const prior = Object.keys(n.stdPeriods).sort();
        n.stdPeriods[s] = prior.length ? clone(n.stdPeriods[prior[prior.length - 1]]) : {};
      }
    });
    setName(""); setCt("");
  };
  const delClass = (c) => ask(`Remove class ${c}, along with its timetable and B-Key?`, () => update((n) => {
    n.classes = n.classes.filter((x) => x !== c); delete n.grid[c]; delete n.bkey[c]; delete n.classTeacher[c];
  }));
  const addSubject = () => { const s = newSub.trim().toUpperCase(); if (!s || cfg.subjects.includes(s)) return; update((n) => n.subjects.push(s)); setNewSub(""); };
  const delSubject = (s) => ask(`Remove subject ${s} from the list? Existing B-Key rows using it stay until you change them.`, () => update((n) => { n.subjects = n.subjects.filter((x) => x !== s); }));
  const addTeacher = () => { const t = newTch.trim().toUpperCase(); if (!t || cfg.singles.includes(t)) return; update((n) => { n.singles.push(t); n.singles.sort(); }); setNewTch(""); };
  const delTeacher = (t) => ask(`Remove teacher ${t}? They’ll be cleared as class teacher where set; B-Key/timetable entries using them stay until you change them.`, () => update((n) => {
    n.singles = n.singles.filter((x) => x !== t);
    for (const c of n.classes) if (n.classTeacher[c] === t) n.classTeacher[c] = null;
  }));

  return (
    <div>
      <ViewHeader title="Classes & setup" note="Add or remove classes each academic year, choose the working days, and maintain the subject and teacher lists." />

      <div style={{ ...card, marginBottom: 16 }}>
        <Panelhead text="Working days" />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: 14 }}>
          {WEEK_ORDER.map((d) => {
            const on = cfg.days.includes(d);
            return <button key={d} className="tt-btn" onClick={() => toggleDay(d)} style={{ border: `1px solid ${on ? C.primary : C.line}`, background: on ? C.primary : "#fff", color: on ? "#fff" : C.sub, padding: "7px 13px", borderRadius: 8, fontSize: 13, fontWeight: 600 }}>{DAY_FULL[d]}</button>;
          })}
        </div>
        <div style={{ padding: "0 14px 12px", fontSize: 12, color: C.sub }}>Turning a day off deletes that day’s columns from every class. Turning it on adds empty columns.</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "minmax(0,1.2fr) minmax(0,1fr)", gap: 16, alignItems: "start" }}>
        <div style={card}>
          <Panelhead text="Classes & divisions" count={cfg.classes.length} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7, padding: 14, maxHeight: 260, overflowY: "auto" }}>
            {cfg.classes.map((c) => (
              <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: mono, fontSize: 12.5, fontWeight: 600, padding: "5px 6px 5px 11px", background: C.primarySoft, color: C.primary, borderRadius: 8 }}>
                {c}<button className="tt-btn" onClick={() => delClass(c)} style={{ border: "none", background: "transparent", color: C.clash, fontSize: 15, cursor: "pointer", lineHeight: 1 }}>×</button>
              </span>
            ))}
          </div>
          <div style={{ borderTop: `1px solid ${C.line}`, padding: 14, display: "grid", gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.sub }}>Add a class</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input className="tt-in" style={{ width: 110 }} placeholder="e.g. 8 A" value={name} onChange={(e) => setName(e.target.value)} />
              <select className="tt-sel" style={{ width: 130 }} value={ct} onChange={(e) => setCt(e.target.value)}>
                <option value="">class teacher…</option>{cfg.singles.map((t) => <option key={t}>{t}</option>)}
              </select>
              <select className="tt-sel" style={{ width: 150 }} value={clonefrom} onChange={(e) => setClonefrom(e.target.value)}>
                <option value="">blank B-Key</option>{cfg.classes.map((c) => <option key={c} value={c}>copy B-Key from {c}</option>)}
              </select>
              <button className="tt-btn" onClick={addClass} style={solidBtn}>Add class</button>
            </div>
            {err && <div style={{ fontSize: 12, color: C.clash, fontWeight: 600 }}>{err}</div>}
          </div>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div style={card}>
            <Panelhead text="Subjects" count={cfg.subjects.length} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: 14 }}>
              {cfg.subjects.map((s) => <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: mono, fontSize: 12, padding: "4px 5px 4px 9px", background: SUBJECT_TINT[s] || "#eee", borderRadius: 7 }}>{s}<button className="tt-btn" onClick={() => delSubject(s)} style={{ border: "none", background: "transparent", color: C.clash, fontSize: 14, cursor: "pointer", lineHeight: 1 }}>×</button></span>)}
            </div>
            <div style={{ borderTop: `1px solid ${C.line}`, padding: 14, display: "flex", gap: 8 }}>
              <input className="tt-in" placeholder="new subject" value={newSub} onChange={(e) => setNewSub(e.target.value)} />
              <button className="tt-btn" onClick={addSubject} style={ghostBtn}>Add</button>
            </div>
          </div>
          <div style={card}>
            <Panelhead text="Teachers" count={cfg.singles.length} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: 14, maxHeight: 180, overflowY: "auto" }}>
              {cfg.singles.map((t) => <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: mono, fontSize: 12, padding: "4px 5px 4px 9px", background: "#eef0f2", borderRadius: 7 }}>{t}<button className="tt-btn" onClick={() => delTeacher(t)} style={{ border: "none", background: "transparent", color: C.clash, fontSize: 14, cursor: "pointer", lineHeight: 1 }}>×</button></span>)}
            </div>
            <div style={{ borderTop: `1px solid ${C.line}`, padding: 14, display: "flex", gap: 8 }}>
              <input className="tt-in" placeholder="new teacher code" value={newTch} onChange={(e) => setNewTch(e.target.value)} />
              <button className="tt-btn" onClick={addTeacher} style={ghostBtn}>Add</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Banner({ tone, children }) {
  const col = tone === "warn" ? C.warn : C.primary, bg = tone === "warn" ? C.warnSoft : C.primarySoft;
  return <div style={{ background: bg, color: col, border: `1px solid ${col}33`, borderRadius: 10, padding: "10px 14px", fontSize: 13, marginBottom: 14, fontWeight: 500 }}>{children}</div>;
}

/* ---------------- styles ---------------- */
const card = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, overflow: "hidden", boxShadow: C.shadow };
const tbl = { borderCollapse: "collapse", width: "100%", tableLayout: "fixed" };
const th = { fontSize: 11, fontWeight: 700, color: C.sub, padding: "10px 6px", textAlign: "center", borderBottom: `1px solid ${C.line}`, background: "#f7f9fb", textTransform: "uppercase", letterSpacing: 0.5 };
const cellTd = { borderBottom: `1px solid ${C.line}`, borderLeft: `1px solid ${C.line}`, padding: "8px 6px", textAlign: "center", verticalAlign: "middle", height: 50 };
const editTd = { borderBottom: `1px solid ${C.line}`, borderLeft: `1px solid ${C.line}`, padding: 6, verticalAlign: "top", width: "16%" };
const perTd = { borderBottom: `1px solid ${C.line}`, padding: "8px 6px", textAlign: "center", fontWeight: 800, fontFamily: mono, fontSize: 13, color: "#fff", background: `linear-gradient(180deg, ${C.primary}, ${C.primaryDeep})` };

/* ---------------- actions ---------------- */
function printNow() { setTimeout(() => window.print(), 30); }
function exportJSON(cfg) {
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "timetable_config.json"; a.click();
}

function esc(x) { return String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function openPrint(title, css, bodyHtml) {
  var w = window.open("", "_blank");
  if (!w) { alert("Please allow pop-ups for this site so the PDF can open, then choose 'Save as PDF' and paper size A4."); return; }
  w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title><style>' + css + '</style></head><body>' + bodyHtml + '<scr' + 'ipt>window.onload=function(){setTimeout(function(){window.print();},350);};<\/scr' + 'ipt></body></html>');
  w.document.close();
}

var GRID_CSS = "@page{size:A4 landscape;margin:10mm} body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0} .page{page-break-after:always;padding:6px} .page:last-child{page-break-after:auto} h2{font-size:16px;margin:0 0 2px} .sub{font-size:11px;color:#555;margin:0 0 8px} table{border-collapse:collapse;width:100%} th,td{border:1px solid #444;padding:6px 4px;text-align:center;font-size:11px} th{background:#e8e8e8} .t{font-weight:bold} .s{color:#555;font-size:10px}";

function gridHead(cfg) {
  var head = "<tr><th>Day / Period</th>";
  for (var pi = 0; pi < cfg.periods.length; pi++) head += "<th>P" + cfg.periods[pi] + "</th>";
  return head + "</tr>";
}

function teacherAt(cfg, t, d, p) {
  for (var ci = 0; ci < cfg.classes.length; ci++) {
    var c = cfg.classes[ci];
    var slot = cfg.grid[c] && cfg.grid[c][d] && cfg.grid[c][d][p];
    var code = slot && slot[0];
    if (code && (code === t || (code.indexOf(" ") >= 0 && code.split(" ").indexOf(t) >= 0))) return { c: c, sub: slot[1] };
  }
  return null;
}

function exportClassesPDF(cfg) {
  var head = gridHead(cfg), pages = "";
  for (var ci = 0; ci < cfg.classes.length; ci++) {
    var c = cfg.classes[ci], body = "";
    for (var di = 0; di < cfg.days.length; di++) {
      var d = cfg.days[di], row = "<tr><th>" + esc(DAY_FULL[d]) + "</th>";
      for (var p = 0; p < cfg.periods.length; p++) {
        var slot = (cfg.grid[c] && cfg.grid[c][d] && cfg.grid[c][d][p]) || [null, null];
        row += "<td>" + (slot[0] ? '<span class="t">' + esc(slot[1]) + '</span><br><span class="s">' + esc(slot[0]) + '</span>' : "") + "</td>";
      }
      body += row + "</tr>";
    }
    pages += '<div class="page"><h2>' + esc(cfg.school) + " &mdash; Class " + esc(c) + '</h2><p class="sub">Class teacher: ' + esc(cfg.classTeacher[c] || "-") + '</p><table><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }
  openPrint(esc(cfg.school) + " - Class timetables", GRID_CSS, pages);
}

function exportTeachersPDF(cfg) {
  var head = gridHead(cfg), pages = "";
  for (var ti = 0; ti < cfg.singles.length; ti++) {
    var t = cfg.singles[ti], body = "";
    for (var di = 0; di < cfg.days.length; di++) {
      var d = cfg.days[di], row = "<tr><th>" + esc(DAY_FULL[d]) + "</th>";
      for (var p = 0; p < cfg.periods.length; p++) {
        var r = teacherAt(cfg, t, d, p);
        row += "<td>" + (r ? '<span class="t">' + esc(r.c) + '</span><br><span class="s">' + esc(r.sub) + '</span>' : "") + "</td>";
      }
      body += row + "</tr>";
    }
    pages += '<div class="page"><h2>' + esc(cfg.school) + " &mdash; Teacher " + esc(t) + '</h2><table><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }
  openPrint(esc(cfg.school) + " - Teacher timetables", GRID_CSS, pages);
}

function exportFreeReportPDF(cfg) {
  var css = "@page{size:A4 portrait;margin:12mm} body{font-family:Arial,Helvetica,sans-serif;color:#111} h2{font-size:16px;margin:0 0 10px} table{border-collapse:collapse;width:100%} th,td{border:1px solid #444;padding:5px 6px;text-align:center;font-size:11px} th{background:#e8e8e8}";
  var head = "<tr><th style='text-align:left'>Teacher</th>";
  for (var di = 0; di < cfg.days.length; di++) head += "<th>" + esc(DAY_FULL[cfg.days[di]].slice(0, 3)) + "</th>";
  head += "<th>Total free</th></tr>";
  var rows = "";
  for (var ti = 0; ti < cfg.singles.length; ti++) {
    var t = cfg.singles[ti], total = 0, cells = "";
    for (var di2 = 0; di2 < cfg.days.length; di2++) {
      var d = cfg.days[di2], free = 0;
      for (var p = 0; p < cfg.periods.length; p++) if (!teacherAt(cfg, t, d, p)) free++;
      total += free; cells += "<td>" + free + "</td>";
    }
    rows += "<tr><td style='text-align:left'><b>" + esc(t) + "</b></td>" + cells + "<td><b>" + total + "</b></td></tr>";
  }
  openPrint(esc(cfg.school) + " - Teacher leisure report", css, "<h2>" + esc(cfg.school) + " &mdash; Teacher free (leisure) periods per day</h2><table><thead>" + head + "</thead><tbody>" + rows + "</tbody></table>");
}
