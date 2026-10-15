import React, { useState, useEffect, useMemo, useRef } from "react";
import { SEED } from "./seed";
import { loadConfig, saveConfig, subscribeConfig, acceptRemote, publishTeacherPages } from "./storage";
import { supabase } from "./supabaseClient";

/* ============================================================
   AMUPS Pallikkal — Timetable Manager  (v2)
   The mapping is the source of truth: it sets which teacher takes
   which subject in each class, and how many periods per week.
   The master grid can only place what the mapping allows, and every
   teacher's load is tracked against their mapping target.
   ============================================================ */

const STORE_KEY = "tt_cfg_v2";
const APP_VERSION = "2026-10-15 e";

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
var CUR_TH = null, CUR_VIEW = "classes", SCHOOL_NAME = "";

const TABS = [
  ["classes", "Class timetables"], ["teachers", "Teacher timetables"], ["free", "Free & substitution"], ["subs", "Daily substitution"],
  ["bkey", "Mapping"], ["edit", "Assign timetable"], ["rules", "Scheduling rules"],
  ["combined", "Combined subjects"], ["analysis", "Analysis & checks"], ["export", "Import / Export"], ["assistant", "AI assistant"], ["setup", "Classes & setup"],
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

const emptyDay = (p) => Array.from({ length: p || 8 }, () => [null, null]);
const clone = (o) => JSON.parse(JSON.stringify(o));
const stdOf = (cls) => String(cls).split(" ")[0];
const baseName = (code) => (code ? code.replace(/ \d+$/, "") : code);
const combName = (map, code) => (!code ? code : map[code] ? code : baseName(code));
const periodsFor = (cfg, cls, sub) => Number(cfg.stdPeriods?.[stdOf(cls)]?.[sub]) || 0;
const standardsOf = (cfg) => [...new Set(cfg.classes.map(stdOf))].sort((a, b) => (isNaN(a) || isNaN(b) ? String(a).localeCompare(b) : a - b));

// ---- automated scheduler (deterministic CSP, randomized restarts) ----
function makeRng(seed) { return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; }
function shuf(a, r) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// default block for "together with the other X sessions": same subject AND same standard
function stdBlockName(s) {
  const stds = [...new Set((s.divisions || []).map(stdOf))];
  return stds.length === 1 ? `${s.sub} · Std ${stds[0]}` : s.sub;
}
function combGroupOf(s) { return ((s && s.group) || "").trim() || (s && s.name) || ""; }
// periods of a class's subject that come from a combined session (the rest is taught normally)
function combCover(cfg) {
  const cov = {};
  for (const g of Object.values(combGroups(cfg))) for (const x of g.sessions) for (const c of (x.divisions || [])) { const k = c + "|" + x.sub; cov[k] = Math.max(cov[k] || 0, g.need); }
  return cov;
}
function combGroups(cfg) {
  const g = {};
  for (const s of (cfg.combined || [])) {
    if (!s || !s.name) continue;
    const k = combGroupOf(s);
    const e = g[k] || (g[k] = { name: k, sub: s.sub, sessions: [], teachers: new Set(), divisions: new Set(), need: 0 });
    e.sessions.push(s); (s.teachers || []).forEach((t) => e.teachers.add(t)); (s.divisions || []).forEach((c) => e.divisions.add(c));
    e.need = Math.max(e.need, Number(s.perWeek) || periodsFor(cfg, s.divisions[0] || cfg.classes[0], s.sub));
  }
  return g;
}
function classPeriods(cfg, c) { const v = Number(cfg.classMaxP?.[c]); const P = cfg.periods.length; return v > 0 && v < P ? v : P; }
async function hashPw(s) {
  const t = "ttmgr:" + String(s || "");
  try { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
  catch { let h = 5381; for (const ch of t) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0; return "h" + h.toString(16); }
}
function teacherWorkDays(cfg, t) { const a = (cfg.teacherDays || {})[t]; return a && a.length ? cfg.days.filter((d) => a.includes(d)) : cfg.days; }
function teacherCap(cfg, t) { return teacherWorkDays(cfg, t).length * cfg.periods.length - extraCount(cfg, t); }

function autoSchedule(cfg, mode = "all", onlyClass = null, opts = {}) {
  const res = autoScheduleCore(cfg, mode, onlyClass, opts);
  const pr = qualityPrefs(cfg);
  if (res && pr.on && !opts.noPolish) {
    try { const pol = polishGrid(cfg, res.grid, polishMovable(cfg, mode, onlyClass), opts.polishMs || 900); res.grid = pol.grid; res.polished = pol.moves; } catch (e) { /* keep the unpolished timetable */ }
  }
  return res;
}
function autoScheduleCore(cfg, mode = "all", onlyClass = null, opts = {}) {
  const singles = new Set(cfg.singles);
  const combined = (cfg.combined || []).filter((s) => s && s.name);
  const cByBase = {}; combined.forEach((s) => (cByBase[s.name] = s));
  const isC = (code) => !!(code && cByBase[combName(cByBase, code)]);
  const tOf = (code) => { if (!code) return []; const s = cByBase[combName(cByBase, code)]; if (s) return s.teachers.filter((t) => singles.has(t)); if (singles.has(code)) return [code]; return String(code).split(" ").filter((t) => singles.has(t)); };
  const pf = (c, sub) => Number(cfg.stdPeriods?.[stdOf(c)]?.[sub]) || 0;
  const DAYS = cfg.days, D = DAYS.length, P = cfg.periods.length;
  const RULES = cfg.rules || {};
  const R = (sub) => RULES[sub] || {};
  const twiceOK = (c, sub) => !!(cfg.twice && cfg.twice[stdOf(c)] && cfg.twice[stdOf(c)][sub]);
  const allowed = (sub, p) => { const r = R(sub); if (r.pin && r.pin !== p + 1) return false; if (r.forbid && r.forbid.includes(p + 1)) return false; return true; };
  const TD = cfg.teacherDays || {};
  const availT = (t, d) => { const a = TD[t]; return !a || !a.length || a.includes(DAYS[d]); };
  const writable = new Set(mode === "class" ? [onlyClass] : cfg.classes);
  const groupOf = (sx) => ((sx.group || "").trim() || sx.name);
  const covPer = {};
  { const gs = {}; for (const sx of combined) (gs[groupOf(sx)] || (gs[groupOf(sx)] = [])).push(sx);
    for (const list of Object.values(gs)) { const need = Math.max(...list.map((sx) => Number(sx.perWeek) || pf(sx.divisions[0] || cfg.classes[0], sx.sub))); for (const sx of list) for (const c of sx.divisions) { const k = c + "|" + sx.sub; covPer[k] = Math.max(covPer[k] || 0, need); } } }
  const autoLim = {}; const autoNotes = {}; const autoNotesDays = {};
  for (const c of cfg.classes) for (const row of (cfg.bkey[c] || [])) {
    if (!row.sub) continue;
    const toks = row.teacher && !isC(row.teacher) ? tOf(row.teacher) : [];
    const days = toks.length ? Math.min(...toks.map((t) => DAYS.filter((_, d) => availT(t, d)).length)) : D;
    const need = Math.ceil(pf(c, row.sub) / Math.max(1, days));
    autoNotesDays[c + "|" + row.sub] = days;
    if (need > (twiceOK(c, row.sub) ? 2 : 1)) { autoLim[c + "|" + row.sub] = need; const k = row.sub + "|" + stdOf(c); (autoNotes[k] || (autoNotes[k] = { sub: row.sub, st: stdOf(c), per: pf(c, row.sub), days, classes: [] })).classes.push(c); }
  }
  const limOf = (c, sub) => Math.max(twiceOK(c, sub) ? 2 : 1, autoLim[c + "|" + sub] || 0);
  const extraOK = {};  // c|sub -> how many extra same-day periods are unavoidable (periods - days)
  for (const k in autoLim) { const [c, sub] = k.split("|"); const n = autoNotesDays[k]; extraOK[k] = Math.max(0, pf(c, sub) - n); }
  const mappedTeacher = (c, sub) => { const row = (cfg.bkey[c] || []).find((r) => r.sub === sub && r.teacher && !isC(r.teacher)); return row ? row.teacher : null; };
  const ROOMS = roomsOf(cfg), ROOMCAP = {}; ROOMS.forEach((rm) => (ROOMCAP["#room:" + rm.name] = rm.cap));
  const roomTok = (sub) => ROOMS.filter((rm) => rm.subjects.includes(sub)).map((rm) => "#room:" + rm.name);
  const tOfL = (l) => tOf(l.teacher).concat(roomTok(l.sub));
  const QP = qualityPrefs(cfg), CORE = new Set(QP.on ? QP.core : []), HALF = fnCount(cfg);
  const mkBusy = () => { const m = new Map(); return { has: (t) => (m.get(t) || 0) >= (ROOMCAP[t] || 1), add: (t) => m.set(t, (m.get(t) || 0) + 1), delete: (t) => { const n = (m.get(t) || 0) - 1; if (n > 0) m.set(t, n); else m.delete(t); } }; };

  const gen = (seed) => {
    const r = makeRng(seed);
    const issues = [];
    const grid = {}; cfg.classes.forEach((c) => (grid[c] = Array.from({ length: D }, () => Array.from({ length: P }, () => [null, null]))));
    const tbusy = Array.from({ length: D }, () => Array.from({ length: P }, () => mkBusy()));
    // teacher tokens + room tokens of a cell (a combined session takes its room once, however many divisions)
    const cellToks = (c, d, p, code, sub) => { const base = tOf(code), rt = roomTok(sub); if (!rt.length) return base; if (isC(code) && cfg.classes.some((c2) => c2 !== c && grid[c2] && grid[c2][d][p][0] === code)) return base; return base.concat(rt); };
    const subDay = {}, subPer = {};
    const fixed = new Set();           // cells placed by a rule or kept from before - never moved by repair
    const key = (c, d, p) => c + "|" + d + "|" + p;
    const extraUsed = {};
    const mark = (c, sub, d, p, k) => { const kd = `${c}|${sub}|${d}`, before = subDay[kd] || 0; if (k > 0 && before >= 1) extraUsed[c + "|" + sub] = (extraUsed[c + "|" + sub] || 0) + 1; if (k < 0 && before >= 2) extraUsed[c + "|" + sub] = (extraUsed[c + "|" + sub] || 0) - 1; subDay[kd] = before + k; subPer[`${c}|${sub}|${p}`] = (subPer[`${c}|${sub}|${p}`] || 0) + k; };
    const tcls = Array.from({ length: D }, () => Array.from({ length: P }, () => new Map()));
    for (const x of cfg.extraDuties || []) { if (!singles.has(x.t)) continue; for (const sl of x.slots || []) { const d = DAYS.indexOf(sl[0]), p = +sl[1]; if (d >= 0 && p < P) tbusy[d][p].add(x.t); } }   // busy outside this timetable
    const put = (c, d, p, code, sub) => { const tk = cellToks(c, d, p, code, sub); grid[c][d][p] = [code, sub]; const comb = isC(code); tk.forEach((t) => { tbusy[d][p].add(t); if (!comb) tcls[d][p].set(t, c); }); mark(c, sub, d, p, 1); };

    // 1. keep what must stay: locked cells always; in fill modes, everything already placed
    const frozen = new Set();
    const cmax = {}; for (const c of cfg.classes) cmax[c] = classPeriods(cfg, c);
    for (const c of cfg.classes) for (let d = 0; d < D; d++) for (let p = cmax[c]; p < P; p++) frozen.add(key(c, d, p));
    for (const k in (cfg.locked || {})) {
      if (!cfg.locked[k]) continue;
      const parts = k.split("|"); const c = parts[0], di = DAYS.indexOf(parts[1]), p = +parts[2];
      if (di < 0 || !grid[c] || p >= P) continue;
      frozen.add(key(c, di, p));
    }
    for (const c of cfg.classes) for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) {
      const slot = cfg.grid[c]?.[DAYS[d]]?.[p]; if (!slot || !slot[0] || p >= cmax[c]) continue;
      const keep = mode !== "all" || frozen.has(key(c, d, p));
      if (keep) { put(c, d, p, slot[0], slot[1]); if (!opts.softKeep || isC(slot[0]) || frozen.has(key(c, d, p))) fixed.add(key(c, d, p)); }
    }

    const free = (c, d, p) => writable.has(c) && !!grid[c] && !grid[c][d][p][0] && !frozen.has(key(c, d, p));
    // repair mode: a class/subject that now comes from a combined session (or has fewer periods) loses its surplus separate periods
    if (opts.softKeep) for (const c of cfg.classes) {
      if (!writable.has(c)) continue;
      for (const row of cfg.bkey[c] || []) {
        if (!row.teacher || !row.sub || isC(row.teacher)) continue;
        let extra = -Math.max(0, pf(c, row.sub) - (covPer[c + "|" + row.sub] || 0));
        for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) if (grid[c][d][p][0] === row.teacher && grid[c][d][p][1] === row.sub) extra++;
        for (let d = D - 1; d >= 0 && extra > 0; d--) for (let p = P - 1; p >= 0 && extra > 0; p--) {
          const k = key(c, d, p);
          if (grid[c][d][p][0] === row.teacher && grid[c][d][p][1] === row.sub && !frozen.has(k)) { const [code, sub] = grid[c][d][p]; cellToks(c, d, p, code, sub).forEach((t) => { tbusy[d][p].delete(t); if (tcls[d][p].get(t) === c) tcls[d][p].delete(t); }); mark(c, sub, d, p, -1); grid[c][d][p] = [null, null]; fixed.delete(k); extra--; }
        }
      }
    }
    const tOK = (toks, d, p) => toks.every((t) => !tbusy[d][p].has(t) && availT(t, d));
    const book = (c, d, p, code, sub, isFixed) => { put(c, d, p, code, sub); if (isFixed) fixed.add(key(c, d, p)); };
    const unbook = (c, d, p) => { const [code, sub] = grid[c][d][p]; if (!code) return; cellToks(c, d, p, code, sub).forEach((t) => { tbusy[d][p].delete(t); if (tcls[d][p].get(t) === c) tcls[d][p].delete(t); }); mark(c, sub, d, p, -1); grid[c][d][p] = [null, null]; };
    const okSoft = (c, sub, d, p) => { if (!dayOK(c, sub, d)) return false; if (R(sub).distinct && subPer[`${c}|${sub}|${p}`]) return false; return true; };
    const extraLeft = (c, sub) => twiceOK(c, sub) || extraOK[c + "|" + sub] === undefined || (extraUsed[c + "|" + sub] || 0) < extraOK[c + "|" + sub];
    const dayOK = (c, sub, d) => { const n = subDay[`${c}|${sub}|${d}`] || 0; if (n >= limOf(c, sub)) return false; if (n >= 1 && !twiceOK(c, sub) && !extraLeft(c, sub)) return false; return true; };
    const countOf = (c, code, sub) => { let n = 0; for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) if (grid[c][d][p][0] === code && grid[c][d][p][1] === sub) n++; return n; };
    const slots = () => { const s = []; for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) s.push([d, p]); return s; };

    // 2. common periods: one subject at the same day/period for every selected class
    for (const cp of (cfg.commonPeriods || [])) {
      if (!cp || !cp.sub) continue;
      for (const [dayCode, pn] of (cp.slots || [])) {
        const d = DAYS.indexOf(dayCode), p = (+pn) - 1; if (d < 0 || p < 0 || p >= P) continue;
        for (const c of (cp.classes || [])) {
          if (!grid[c] || !writable.has(c)) continue;
          if (grid[c][d][p][1] === cp.sub) { fixed.add(key(c, d, p)); continue; }
          if (!free(c, d, p)) { issues.push(`Common ${cp.sub}: ${c} ${dayCode} P${pn} is already taken`); continue; }
          const t = mappedTeacher(c, cp.sub);
          if (t && !tOK(tOf(t).concat(roomTok(cp.sub)), d, p)) { issues.push(`Common ${cp.sub}: ${t} (${c}) is busy or off on ${dayCode} P${pn}`); continue; }
          book(c, d, p, t || cp.sub, cp.sub, true);
        }
      }
    }

    // 3. class-specific period rules (e.g. class teacher in P1) on a chosen number of days
    const CR = cfg.classRules || {};
    const avoid = new Set();
    const av = (c, sub, teacher, p) => avoid.has(`${c}|${sub}|${p}`) || avoid.has(`${c}|T:${teacher}|${p}`);                 // c|sub|p : keep this subject out of the ruled period on other days
    // options for a rule: for "class teacher" every subject that teacher has in the class that is allowed in the period (biggest first)
    const ruleOptions = (c, rule, p) => {
      if (!rule) return [];
      if (rule.kind === "ct") {
        const ct = cfg.classTeacher[c]; if (!ct) return [];
        const rows = (cfg.bkey[c] || []).filter((x) => x.teacher === ct && !isC(x.teacher) && x.sub);
        const ok = rows.filter((x) => allowed(x.sub, p)).sort((x, y) => pf(c, y.sub) - pf(c, x.sub));
        if (!ok.length && rows.length) issues.push(`${c}: class teacher ${ct} has no subject allowed in P${p + 1} (${rows.map((x) => x.sub).join("/")} blocked by a subject rule)`);
        return ok.map((x) => ({ sub: x.sub, teacher: ct }));
      }
      if (rule.kind === "pair") {
        if (isC(rule.teacher)) return [];
        if (!allowed(rule.sub, p)) { issues.push(`${c}: P${p + 1} rule (${rule.sub}) is blocked by the ${rule.sub} subject rule`); return []; }
        return [{ sub: rule.sub, teacher: rule.teacher }];
      }
      return [];
    };
    for (const c of cfg.classes) {
      if (!writable.has(c)) continue;
      const cr = CR[c]; if (!cr) continue;
      for (const pStr of Object.keys(cr)) {
        const rule = cr[pStr]; const p = (+pStr) - 1; if (p < 0 || p >= P) continue;
        const opts = ruleOptions(c, rule, p); if (!opts.length) continue;
        const teacher = opts[0].teacher; const toks = tOf(teacher);
        const fixedDays = (rule.days || []).map((x) => DAYS.indexOf(x)).filter((x) => x >= 0);
        const want = fixedDays.length ? fixedDays.length : Math.min(D, rule.count ? +rule.count : D);
        for (const o of opts) avoid.add(`${c}|${o.sub}|${p}`);
        avoid.add(`${c}|T:${teacher}|${p}`);
        let have = 0; for (let d = 0; d < D; d++) if (grid[c][d][p][0] === teacher && opts.some((o) => o.sub === grid[c][d][p][1])) { have++; fixed.add(key(c, d, p)); }
        const budget = (o) => pf(c, o.sub) - countOf(c, o.teacher, o.sub);
        let order;
        if (fixedDays.length) order = fixedDays;
        else { order = shuf([...Array(D).keys()], r); order.sort((x, y) => (availT(teacher, x) ? 0 : 1) - (availT(teacher, y) ? 0 : 1)); }
        for (const d of order) {
          if (have >= want) break;
          if (grid[c][d][p][0] === teacher) continue;
          if (!free(c, d, p) || !tOK(toks, d, p)) continue;
          const o = opts.find((x) => budget(x) > 0 && dayOK(c, x.sub, d));
          if (o) { book(c, d, p, o.teacher, o.sub, true); have++; }
        }
        const left = opts.reduce((a2, o) => a2 + Math.max(0, budget(o)), 0);
        if (have < want) issues.push(`${c}: P${pStr} rule (class teacher ${teacher}) placed on ${have} of ${want} day(s)${left ? "" : " — the class teacher has only " + have + " period(s) in this class that may go in P" + pStr}`);
      }
    }

    // 4. combined sections: sessions in the same group run at the same slots; different groups never clash
    const groups = {};
    for (const sx of combined) { const g = groupOf(sx); (groups[g] || (groups[g] = [])).push(sx); }
    for (const g of Object.keys(groups)) {
      const sessions = groups[g].filter((sx) => sx.divisions.some((c) => grid[c]));
      if (!sessions.length) continue;
      const divs = [...new Set(sessions.flatMap((sx) => sx.divisions.filter((c) => grid[c])))];
      if (!divs.some((c) => writable.has(c))) continue;
      const need = Math.max(...sessions.map((sx) => Number(sx.perWeek) || pf(sx.divisions[0] || cfg.classes[0], sx.sub)));
      const teach = [...new Set(sessions.flatMap((sx) => sx.teachers.filter((t) => singles.has(t)).concat(roomTok(sx.sub))))];
      const isRunning = (d, p) => divs.every((c) => sessions.some((sx) => grid[c][d][p][0] === sx.name));
      let placed = 0; const usedD = new Set();
      for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) if (isRunning(d, p)) { placed++; usedD.add(d); }
      const canRun = (d, p) => sessions.every((sx) => allowed(sx.sub, p)) && tOK(teach, d, p) && divs.every((c) => free(c, d, p));
      const run = (d, p) => { for (const sx of sessions) for (const c of sx.divisions) if (grid[c] && free(c, d, p)) book(c, d, p, sx.name, sx.sub, true); placed++; usedD.add(d); };
      // slots marked by hand in the Combined tab come first
      const pinned = []; for (const sx of sessions) for (const [dc, pn] of (sx.slots || [])) { const d = DAYS.indexOf(dc), p = (+pn) - 1; if (d >= 0 && p >= 0 && p < P) pinned.push([d, p]); }
      for (const [d, p] of pinned) { if (placed >= need) break; if (isRunning(d, p)) continue; if (canRun(d, p)) run(d, p); else issues.push(`Combined "${g}": ${DAYS[d]} P${p + 1} is blocked (a class or teacher is busy/off)`); }
      // then spread the rest over different days
      for (const pass of [0, 1]) {
        for (const d of shuf([...Array(D).keys()], r)) {
          if (placed >= need) break;
          if (pass === 0 && usedD.has(d)) continue;
          for (const p of shuf([...Array(P).keys()], r)) {
            if (canRun(d, p) && sessions.every((sx) => sx.divisions.every((c) => !grid[c] || !writable.has(c) || okSoft(c, sx.sub, d, p)))) { run(d, p); break; }
          }
        }
      }
      // 3rd: move ordinary lessons out of the way (they are placed again in step 5); locked, rule and combined cells never move
      if (placed < need) {
        const cands = [];
        for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) {
          if (isRunning(d, p) || !sessions.every((sx) => allowed(sx.sub, p)) || !teach.every((t) => availT(t, d))) continue;
          let ok = true; const bl = [];
          for (const c of divs) { if (!writable.has(c) || frozen.has(key(c, d, p))) { ok = false; break; } const code = grid[c][d][p][0]; if (code) { if (fixed.has(key(c, d, p)) || isC(code)) { ok = false; break; } bl.push([c, d, p]); } }
          if (ok) for (const t of teach) if (tbusy[d][p].has(t)) { const hc = tcls[d][p].get(t); if (!hc || !writable.has(hc) || fixed.has(key(hc, d, p)) || frozen.has(key(hc, d, p))) { ok = false; break; } if (!bl.some(([c]) => c === hc)) bl.push([hc, d, p]); }
          if (!ok) continue;
          cands.push({ d, p, bl, score: bl.length * 10 + (usedD.has(d) ? 6 : 0) + r() });
        }
        cands.sort((a, b) => a.score - b.score);
        for (const o of cands) {
          if (placed >= need) break;
          if (isRunning(o.d, o.p)) continue;
          if (!o.bl.every(([c, dd, pp]) => !grid[c][dd][pp][0] || (!fixed.has(key(c, dd, pp)) && !isC(grid[c][dd][pp][0])))) continue;
          const saved = o.bl.map(([c, dd, pp]) => [c, dd, pp, grid[c][dd][pp][0], grid[c][dd][pp][1]]).filter((x) => x[3]);
          for (const [c, dd, pp] of saved) unbook(c, dd, pp);
          if (canRun(o.d, o.p) && sessions.every((sx) => sx.divisions.every((c) => !grid[c] || !writable.has(c) || dayOK(c, sx.sub, o.d)))) run(o.d, o.p);
          else for (const [c, dd, pp, code, sub] of saved) put(c, dd, pp, code, sub);
        }
      }
      if (placed < need) issues.push(`Combined "${g}": placed ${placed} of ${need} period(s) - its classes or teachers have no common free slot`);
    }

    // 5. everything else from the mapping
    let lessons = [];
    for (const c of cfg.classes) {
      if (!writable.has(c)) continue;
      for (const row of cfg.bkey[c] || []) {
        if (!row.teacher || !row.sub || isC(row.teacher)) continue;
        const left = Math.max(0, pf(c, row.sub) - (covPer[c + "|" + row.sub] || 0)) - countOf(c, row.teacher, row.sub);
        for (let k = 0; k < left; k++) lessons.push({ c, sub: row.sub, teacher: row.teacher });
      }
    }
    const load = {}; lessons.forEach((l) => tOf(l.teacher).forEach((t) => (load[t] = (load[t] || 0) + 1)));
    const tight = (l) => Math.max(0, ...tOf(l.teacher).map((t) => (load[t] || 0) / Math.max(1, teacherCap(cfg, t))));
    lessons = shuf(lessons, r);
    lessons.sort((a, b) => { const pa = R(a.sub).pin ? 0 : 1, pb = R(b.sub).pin ? 0 : 1; if (pa !== pb) return pa - pb; return tight(b) - tight(a); });
    const unplacedList = [];
    for (const l of lessons) {
      const toks = tOfL(l); const band = R(l.sub).band;
      const cand = shuf(slots(), r).filter(([d, p]) => allowed(l.sub, p));
      if (band === "early") cand.sort((a, b) => a[1] - b[1]); else if (band === "late") cand.sort((a, b) => b[1] - a[1]); else if (CORE.has(l.sub)) cand.sort((a, b) => (a[1] >= HALF ? 1 : 0) - (b[1] >= HALF ? 1 : 0));
      const tries = [
        ([d, p]) => !av(l.c, l.sub, l.teacher, p) && okSoft(l.c, l.sub, d, p),
        ([d, p]) => !av(l.c, l.sub, l.teacher, p) && dayOK(l.c, l.sub, d),
      ];
      let done = false;
      for (const ok of tries) { for (const s of cand) { const [d, p] = s; if (free(l.c, d, p) && tOK(toks, d, p) && ok(s)) { book(l.c, d, p, l.teacher, l.sub, false); done = true; break; } } if (done) break; }
      if (!done) unplacedList.push(l);
    }

    // 6. repair: free a slot by moving an ordinary (non-rule) lesson elsewhere - never a locked/rule/kept cell
    let remaining = unplacedList;
    for (let pass = 0; pass < 3 && remaining.length; pass++) {
      const still = [];
      for (const l of remaining) {
        const toks = tOfL(l); let fixedIt = false;
        const cand = shuf(slots(), r).filter(([d, p]) => allowed(l.sub, p) && tOK(toks, d, p) && dayOK(l.c, l.sub, d) && !av(l.c, l.sub, l.teacher, p));
        cand.sort((a, b) => a[1] - b[1]);
        for (const [d, p] of cand) {
          if (free(l.c, d, p)) { book(l.c, d, p, l.teacher, l.sub, false); fixedIt = true; break; }
          if (!writable.has(l.c) || frozen.has(key(l.c, d, p)) || fixed.has(key(l.c, d, p))) continue;
          const [oc, os] = grid[l.c][d][p]; if (!oc || isC(oc)) continue;
          const otoks = tOf(oc).concat(roomTok(os));
          unbook(l.c, d, p);
          let moved = null;
          const rel = [];
          for (let pp = p + 1; pp < P; pp++) rel.push([d, pp]);
          for (let pp = 0; pp < p; pp++) rel.push([d, pp]);
          for (const dd of shuf([...Array(D).keys()], r)) if (dd !== d) for (let pp = 0; pp < P; pp++) rel.push([dd, pp]);
          for (const [d2, p2] of rel) if (allowed(os, p2) && free(l.c, d2, p2) && tOK(otoks, d2, p2) && dayOK(l.c, os, d2) && !av(l.c, os, oc, p2)) { book(l.c, d2, p2, oc, os, false); moved = [d2, p2]; break; }
          if (moved && tOK(toks, d, p) && dayOK(l.c, l.sub, d)) { book(l.c, d, p, l.teacher, l.sub, false); fixedIt = true; break; }
          if (moved) unbook(l.c, moved[0], moved[1]);
          book(l.c, d, p, oc, os, false);
        }
        if (!fixedIt) still.push(l);
      }
      remaining = still;
    }

    // 7. move chains: to place a stuck lesson, move the lessons in its way (in this class and in the
    //    teacher's other class) to other slots, up to 3 moves deep. Rule-placed, locked and combined cells never move.
    const log = [];
    const B = (c, d, p, code, sub) => { put(c, d, p, code, sub); log.push(["b", c, d, p]); };
    const U = (c, d, p) => { const [code, sub] = grid[c][d][p]; unbook(c, d, p); log.push(["u", c, d, p, code, sub]); };
    const rollback = (mark) => { while (log.length > mark) { const e = log.pop(); if (e[0] === "b") unbook(e[1], e[2], e[3]); else put(e[1], e[2], e[3], e[4], e[5]); } };
    const movable = (c, d, p) => writable.has(c) && !frozen.has(key(c, d, p)) && !fixed.has(key(c, d, p)) && !!grid[c][d][p][0] && !isC(grid[c][d][p][0]);
    const holderOf = (t, d, p) => tcls[d][p].get(t) || null;
    let budget = 0;
    const place = (l, depth, tabu) => {
      if (--budget < 0) return false;
      const toks = tOfL(l);
      const cand = [];
      for (let d = 0; d < D; d++) {
        if (!toks.every((t) => availT(t, d))) continue;
        for (let p = 0; p < P; p++) {
          if (!allowed(l.sub, p) || av(l.c, l.sub, l.teacher, p) || tabu.has(key(l.c, d, p)) || frozen.has(key(l.c, d, p))) continue;
          const bl = []; let ok = true;
          if (grid[l.c][d][p][0]) { if (!movable(l.c, d, p)) continue; bl.push([l.c, d, p]); }
          for (const t of toks) if (tbusy[d][p].has(t)) { const hc = holderOf(t, d, p); if (!hc || !movable(hc, d, p)) { ok = false; break; } if (!bl.some(([c]) => c === hc)) bl.push([hc, d, p]); }
          if (!ok || bl.length > 2) continue;
          if (bl.length && depth <= 0) continue;
          cand.push({ d, p, bl, score: bl.length * 10 + r() });
        }
      }
      cand.sort((a, b) => a.score - b.score);
      for (const { d, p, bl } of cand.slice(0, depth >= 2 ? 14 : 8)) {
        const mark = log.length;
        const moved = bl.map(([c, dd, pp]) => { const [code, sub] = grid[c][dd][pp]; U(c, dd, pp); return { c, sub, teacher: code }; });
        if (!free(l.c, d, p) || !tOK(toks, d, p) || !dayOK(l.c, l.sub, d)) { rollback(mark); continue; }
        B(l.c, d, p, l.teacher, l.sub);
        const t2 = new Set(tabu); t2.add(key(l.c, d, p)); for (const [c, dd, pp] of bl) t2.add(key(c, dd, pp));
        let all = true; for (const m of moved) if (!place(m, depth - 1, t2)) { all = false; break; }
        if (all) return true;
        rollback(mark);
      }
      return false;
    };
    const still2 = [];
    let chainLeft = 25000;
    for (const l of remaining) { if (chainLeft <= 0 || Date.now() > deadline) { still2.push(l); continue; } budget = Math.min(2500, chainLeft); const b0 = budget; const mark = log.length; const okP = place(l, 3, new Set()); chainLeft -= b0 - Math.max(0, budget); if (!okP) { rollback(mark); still2.push(l); } }
    remaining = still2;
    // 8. tight timetables (no free periods): keep placing the stuck lessons, pushing out whatever is in the way
    //    and re-placing that in turn, until everything fits or time runs out. Rule-placed, locked and combined cells never move.
    if (remaining.length && !opts.noWalk) {
      const wEnd = Math.min(deadline, Date.now() + (opts.walkMs || 2500));
      let pool = remaining.slice();
      const snap = () => { const s = {}; for (const c of writable) if (grid[c]) s[c] = grid[c].map((row) => row.map((x) => [x[0], x[1]])); return { s, pool: pool.slice() }; };
      const restore = (b) => { for (const c of Object.keys(b.s)) for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) if (grid[c][d][p][0] && !fixed.has(key(c, d, p)) && !frozen.has(key(c, d, p))) unbook(c, d, p);
        for (const c of Object.keys(b.s)) for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) { const [code, sub] = b.s[c][d][p]; if (code && !grid[c][d][p][0]) put(c, d, p, code, sub); }
        pool = b.pool.slice(); };
      let best = snap(); const tabu = new Map(); let it = 0, fails = 0;
      while (pool.length && Date.now() < wEnd && fails < (opts.walkFails || 4000)) {
        it++;
        const li = Math.floor(r() * pool.length); const l = pool[li]; const toks = tOfL(l);
        const cands = [];
        for (let d = 0; d < D; d++) {
          if (!toks.every((t) => availT(t, d))) continue;
          for (let p = 0; p < P; p++) {
            const k = key(l.c, d, p);
            if (frozen.has(k) || !allowed(l.sub, p) || av(l.c, l.sub, l.teacher, p)) continue;
            const ej = []; let ok = true;
            if (grid[l.c][d][p][0]) { if (!movable(l.c, d, p)) continue; ej.push([l.c, d, p]); }
            for (const t of toks) if (tbusy[d][p].has(t)) { const hc = tcls[d][p].get(t); if (!hc || !movable(hc, d, p)) { ok = false; break; } if (!ej.some(([c]) => c === hc)) ej.push([hc, d, p]); }
            if (!ok) continue;
            let pen = 0; for (const [c, dd, pp] of ej) if ((tabu.get(c + "|" + dd + "|" + pp + "|" + grid[c][dd][pp][0]) || 0) > it) pen += 6;
            cands.push({ d, p, ej, cost: ej.length * 2 + pen + r() * 1.5 });
          }
        }
        cands.sort((a, b) => a.cost - b.cost);
        let done = false;
        for (const o of cands.slice(0, 6)) {
          const out = o.ej.map(([c, dd, pp]) => ({ c, d: dd, p: pp, teacher: grid[c][dd][pp][0], sub: grid[c][dd][pp][1] }));
          for (const x of out) unbook(x.c, x.d, x.p);
          if (free(l.c, o.d, o.p) && tOK(toks, o.d, o.p) && dayOK(l.c, l.sub, o.d)) {
            put(l.c, o.d, o.p, l.teacher, l.sub);
            pool.splice(li, 1);
            tabu.set(l.c + "|" + o.d + "|" + o.p + "|" + l.teacher, it + 8);
            for (const x of out) { pool.push({ c: x.c, sub: x.sub, teacher: x.teacher }); tabu.set(x.c + "|" + x.d + "|" + x.p + "|" + x.teacher, it + 12); }
            done = true; break;
          }
          for (const x of out) put(x.c, x.d, x.p, x.teacher, x.sub);
        }
        if (!done) { fails++; continue; }
        if (pool.length < best.pool.length) best = snap();
      }
      if (pool.length > best.pool.length) restore(best);
      remaining = pool;
    }
    const notesOut = Object.values(autoNotes).map((x) => `${x.sub} in Std ${x.st} needs ${x.per} periods but has ${x.days} day(s) — placed twice on a day where needed (${x.classes.length} class${x.classes.length > 1 ? "es" : ""})`);

    const missing = {};
    const why = (l) => {
      const toks = tOfL(l); let tFree = 0, both = 0;
      for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) { if (!allowed(l.sub, p) || !toks.every((t) => availT(t, d))) continue; if (toks.every((t) => !tbusy[d][p].has(t))) { tFree++; if (!grid[l.c][d][p][0]) both++; } }
      if (!tFree) return "teacher has no free allowed slot";
      if (!both) return "class and teacher are never free together";
      return "only free together on days it already has";
    };
    for (const l of remaining) { const k = `${l.c} ${l.sub} (${l.teacher}: ${why(l)})`; missing[k] = (missing[k] || 0) + 1; }
    const out = {}; for (const c of cfg.classes) { out[c] = {}; DAYS.forEach((day, d) => (out[c][day] = grid[c][d])); }
    return { grid: out, unplacedList: remaining.map((l) => ({ c: l.c, sub: l.sub, teacher: l.teacher })), unplaced: remaining.length, issues: [...notesOut, ...issues], notes: notesOut.length, missing: Object.entries(missing).map(([k, n]) => n > 1 ? `${k} ×${n}` : k) };
  };

  let best = null;
  const maxMs = opts.maxMs || 4500;
  const t0 = Date.now(), deadline = t0 + maxMs + 2500;
  for (let s = 1; s <= 30; s++) {
    if (best && Date.now() - t0 > maxMs) break;
    const res = gen((opts.seedBase || 0) + s * 7 + 1);
    const score = res.unplaced * 10 + res.issues.length - (res.notes || 0);
    if (!best || score < best.score) { best = res; best.score = score; }
    if (best.score === 0) break;
  }
  return best;
}

// One auto-balance step: generate with the given class-teacher P1 days, then lower the days
// only in the classes whose lessons didn't fit (or, failing that, where those teachers teach).
function ctBalanceStep(cfg, counts, minD) {
  const trial = clone(cfg);
  for (const c of Object.keys(counts)) { trial.classRules[c] = { ...(trial.classRules[c] || {}) }; const prev = trial.classRules[c][1] || {}; trial.classRules[c][1] = { ...prev, kind: prev.kind || "ct", count: counts[c] }; delete trial.classRules[c][1].days; }
  const res = autoSchedule(trial, "all", null, { maxMs: 1500 });
  // only lessons that could use P1 are helped by giving P1 back
  const canP1 = (sub) => { const r = cfg.rules?.[sub] || {}; return !(r.pin && r.pin !== 1) && !(r.forbid || []).includes(1); };
  const stuck = res.unplacedList.filter((l) => canP1(l.sub));
  const next = { ...counts }; let changed = false;
  for (const c of new Set(stuck.map((l) => l.c))) if (next[c] !== undefined && next[c] > minD) { next[c]--; changed = true; }
  if (!changed && stuck.length) {
    const ts = new Set(stuck.map((l) => l.teacher));
    for (const c of Object.keys(next)) if (next[c] > minD && (cfg.bkey[c] || []).some((r) => ts.has(r.teacher))) { next[c]--; changed = true; }
  }
  return { res, next, changed, notP1: res.unplaced - stuck.length };
}

// Remove whatever collides at each clashing slot, then put the removed periods back without clashes.
// Keeps: locked cells, the biggest combined block at a slot, and everything that doesn't clash.
function fixAllClashes(cfg) {
  const n = clone(cfg);
  const cm = {}; (n.combined || []).forEach((x) => (cm[x.name] = x));
  const key = (code) => (!code ? null : cm[code] ? code : cm[baseName(code)] ? baseName(code) : null);
  const singles = new Set(n.singles);
  const toks = (code) => { const k = key(code); if (k) return cm[k].teachers.filter((t) => singles.has(t)); if (singles.has(code)) return [code]; return String(code).split(" ").filter((t) => singles.has(t)); };
  const locked = (c, d, p) => !!(n.locked && n.locked[`${c}|${d}|${p}`]);
  const removed = [];
  const clear = (c, d, p, why) => { const [code, sub] = n.grid[c][d][p]; removed.push(`${c} ${d} P${p + 1} ${sub || ""} (${code}) — ${why}`); n.grid[c][d][p] = [null, null]; };
  for (const d of n.days) for (let p = 0; p < n.periods.length; p++) {
    const cells = [];
    for (const c of n.classes) { const code = n.grid[c]?.[d]?.[p]?.[0]; if (code) cells.push({ c, code, k: key(code), lk: locked(c, d, p) }); }
    const claimed = new Set();
    // 1) locked ordinary lessons always stay
    for (const x of cells) if (!x.k && x.lk) toks(x.code).forEach((t) => claimed.add(t));
    // 2) combined blocks: keep the biggest first, drop a block if its teachers are already taken
    const blocks = {};
    for (const x of cells) if (x.k) { const g = combGroupOf(cm[x.k]); (blocks[g] || (blocks[g] = { cells: [], teachers: new Set() })).cells.push(x); toks(x.code).forEach((t) => blocks[g].teachers.add(t)); }
    for (const g of Object.keys(blocks).sort((a, b) => blocks[b].cells.length - blocks[a].cells.length)) {
      const bl = blocks[g];
      const hit = [...bl.teachers].filter((t) => claimed.has(t));
      if (hit.length && !bl.cells.some((x) => x.lk)) {
        for (const x of bl.cells) clear(x.c, d, p, `${hit.join(", ")} busy in another block`);
        for (const s of Object.values(cm)) if (combGroupOf(s) === g && s.slots) { s.slots = s.slots.filter(([dd, pp]) => !(dd === d && pp === p + 1)); if (!s.slots.length) delete s.slots; }
      } else bl.teachers.forEach((t) => claimed.add(t));
    }
    // 3) ordinary lessons: first one keeps the teacher, later ones that collide are taken out
    for (const x of cells) if (!x.k && !x.lk) {
      const ts = toks(x.code);
      if (ts.some((t) => claimed.has(t))) clear(x.c, d, p, `${ts.filter((t) => claimed.has(t)).join(", ")} already teaching`);
      else ts.forEach((t) => claimed.add(t));
    }
  }
  const res = autoSchedule(n, "gaps", null, { softKeep: true });
  return { grid: res.grid, combined: n.combined, removed, res };
}

function cmpClass(a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" }); }
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

function SaveReport({ r, onClose }) {
  const items = [
    [r.noStdSubs, "Standards with no subjects/periods"],
    [r.noMap, "Classes with no mapping"],
    [r.noTeacher, "Subjects without a teacher"],
    [r.noPer, "Mapped subjects with 0 periods in their standard"],
    [r.noCT, "Classes without a class teacher"],
  ].filter(([a]) => a.length);
  const ok = !items.length;
  const col = ok ? C.primary : C.warn;
  return (
    <div style={{ background: ok ? C.primarySoft : C.warnSoft, color: col, border: `1px solid ${col}33`, borderRadius: 10, padding: "10px 14px", fontSize: 13, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <b>{ok ? "Saved. The mapping is complete." : "Saved — but some of the mapping is still incomplete:"}</b>
        <button className="tt-btn" onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", color: "inherit", fontSize: 17, lineHeight: 1 }}>×</button>
      </div>
      {items.map(([a, lbl]) => (
        <div key={lbl} style={{ marginTop: 6, lineHeight: 1.55 }}><b>{lbl} ({a.length}):</b> <span style={{ fontFamily: mono, fontSize: 12 }}>{a.slice(0, 40).join(", ")}{a.length > 40 ? ` … +${a.length - 40} more` : ""}</span></div>
      ))}
    </div>
  );
}

export default function App() {
  const [cfg, setCfg] = useState(null);
  const [view, setView] = useState(() => lsGet("tt_view", "classes"));
  const [cls, setCls] = useState(() => lsGet("tt_cls", SEED.classes[0]));
  const [tch, setTch] = useState(() => lsGet("tt_tch", SEED.singles[0]));
  useEffect(() => { lsSet("tt_view", view); }, [view]);
  useEffect(() => { lsSet("tt_cls", cls); }, [cls]);
  useEffect(() => { lsSet("tt_tch", tch); }, [tch]);
  const [fday, setFday] = useState(SEED.days[0]);
  const [fper, setFper] = useState(1);
  const [saved, setSaved] = useState("loaded");
  const [confirmState, setConfirmState] = useState(null);
  const ask = (msg, onYes) => setConfirmState({ msg, onYes });
  const [pwState, setPwState] = useState(null);
  const askPw = (msg, onYes) => setPwState({ msg, onYes });
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
      const relinked = relinkCombined(next); if (relinked) wasEmpty = true;
      if (!next.combinedV3) { (next.combined || []).forEach((x) => { if (!x.group || x.group === x.sub) x.group = stdBlockName(x); }); next.combinedV2 = true; next.combinedV3 = true; }
      if (!alive) return;
      if (Array.isArray(next.classes)) next.classes.sort(cmpClass);
      setCfg(next);
      lastSaved.current = JSON.stringify(next);
      schedulePublish(next);
      if (wasEmpty) { try { await saveConfig(next); } catch {} }
    })();
    const ch = subscribeConfig((remote) => { if (!remote) return; const js = JSON.stringify(remote); if (js === lastSaved.current) return; lastSaved.current = js; if (Array.isArray(remote.classes)) remote.classes.sort(cmpClass); setCfg(remote); setSaved("synced"); });
    return () => { alive = false; if (ch) { try { supabase.removeChannel(ch); } catch {} } };
  }, []);

  const lastSaved = useRef("");
  const [pubState, setPubState] = useState(null);
  const [conflict, setConflict] = useState(null);
  const pubTimer = useRef(null);
  const publishRows = async (rows) => { try { const r = await publishTeacherPages(rows); setPubState({ ...r, at: Date.now() }); } catch (e) { setPubState({ ok: false, error: String((e && e.message) || e), at: Date.now() }); } };
  const schedulePublish = (c) => {
    if (!c || !c.teacherLinks || !c.teacherLinks.on) return;
    clearTimeout(pubTimer.current);
    pubTimer.current = setTimeout(() => { try { publishRows(buildTeacherPages(c)); } catch (e) { setPubState({ ok: false, error: String((e && e.message) || e), at: Date.now() }); } }, 3000);
  };
  const saveTimer = useRef(null);
  const persist = (next) => {
    setSaved("saving…");
    lastSaved.current = JSON.stringify(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try { await saveConfig(next); setSaved("saved"); schedulePublish(next); }
      catch (e) { if (e && e.conflict) { setConflict({ remote: e.remote, stamp: e.remoteStamp, mine: next }); setSaved("not saved"); } else setSaved("offline · saved on device"); }
    }, 600);
  };
  const histRef = useRef({ past: [], future: [], lastAt: 0 });
  const [histN, setHistN] = useState([0, 0]);
  const syncHist = () => setHistN([histRef.current.past.length, histRef.current.future.length]);
  const snapPending = useRef(false);
  const addAutoSnap = (prev, why) => {
    if (snapPending.current) return; snapPending.current = true;
    const hint = SNAP_HINT.text && Date.now() - SNAP_HINT.at < 90000 ? SNAP_HINT.text : "";
    SNAP_HINT = { text: "", at: 0 };
    makeSnapshot(prev, (hint ? `Before ${hint}` : "Before a big change") + ` — ${why}`, "auto").then((rec) => {
      setCfg((cur) => { if (!cur) return cur; const n = { ...cur, snapshots: pruneSnaps([...(cur.snapshots || []), rec]) }; persist(n); return n; });
    }).catch(() => {}).finally(() => { snapPending.current = false; });
  };
  const update = (fn) => setCfg((prev) => {
    const next = clone(prev); fn(next); if (Array.isArray(next.classes)) next.classes.sort(cmpClass);
    const why = bigChange(prev, next), h = histRef.current, now = Date.now();
    if (why || now - h.lastAt > 1200) { h.past.push(prev); if (h.past.length > 40) h.past.shift(); }
    h.lastAt = now; h.future = [];
    if (why) addAutoSnap(prev, why);
    setTimeout(syncHist, 0);
    persist(next); return next;
  });
  const keepLive = (target, cur) => { const n = { ...target }; if (cur.snapshots !== undefined) n.snapshots = cur.snapshots; else delete n.snapshots; return n; };
  const undo = () => setCfg((cur) => { const h = histRef.current; if (!cur || !h.past.length) return cur; const prev = h.past.pop(); h.future.push(cur); h.lastAt = 0; const n = keepLive(prev, cur); persist(n); setTimeout(syncHist, 0); return n; });
  const redo = () => setCfg((cur) => { const h = histRef.current; if (!cur || !h.future.length) return cur; const nx = h.future.pop(); h.past.push(cur); h.lastAt = 0; const n = keepLive(nx, cur); persist(n); setTimeout(syncHist, 0); return n; });
  useEffect(() => {
    const onKey = (e) => {
      const tg = e.target && e.target.tagName; if (tg === "INPUT" || tg === "TEXTAREA" || tg === "SELECT") return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, []);

  const singlesSet = useMemo(() => new Set(cfg?.singles || []), [cfg]);
  const combinedByBase = useMemo(() => {
    const m = {}; (cfg?.combined || []).forEach((s) => (m[s.name] = s)); return m;
  }, [cfg]);
  const isCombined = (code) => !!combinedByBase[combName(combinedByBase, code)];
  const teachersOf = (code) => {
    if (!code) return [];
    const s = combinedByBase[combName(combinedByBase, code)];
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
        (cfg.grid[cn]?.[day] || emptyDay(cfg.periods.length)).forEach((slot, p) => {
          const code = slot[0]; if (!code) return;
          const comb = isCombined(code); const base = combName(combinedByBase, code);
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
    if (m) for (const [t, e] of m) if (e.norm.size > 1 || (e.norm.size >= 1 && e.comb.size >= 1) || new Set([...e.comb].map((b) => combGroupOf(combinedByBase[b]))).size > 1) s.add(t);
    return s;
  };
  const totalClashes = useMemo(() => {
    let n = 0;
    for (const day of cfg?.days || []) for (let p = 0; p < cfg.periods.length; p++) {
      const m = occupancy[day]?.[p]?.tok;
      if (m) for (const [, e] of m) if (e.norm.size > 1 || (e.norm.size >= 1 && e.comb.size >= 1) || new Set([...e.comb].map((b) => combGroupOf(combinedByBase[b]))).size > 1) n++;
    }
    return n;
  }, [occupancy, cfg]);

  const clashList = useMemo(() => {
    const out = [];
    for (const day of cfg?.days || []) for (let p = 0; p < cfg.periods.length; p++) {
      const m = occupancy[day]?.[p]?.tok; if (!m) continue;
      for (const [t, e] of m) {
        const gs = new Set([...e.comb].map((b) => combGroupOf(combinedByBase[b])));
        if (!(e.norm.size > 1 || (e.norm.size >= 1 && e.comb.size >= 1) || gs.size > 1)) continue;
        const where = [...[...e.norm].sort(cmpClass).map((c) => `${c} ${cfg.grid[c]?.[day]?.[p]?.[1] || ""}`.trim()), ...[...e.comb].map((b) => `${b} (${combGroupOf(combinedByBase[b])})`)];
        out.push({ t, day, p, where, kind: e.norm.size > 1 && !e.comb.size ? "regular" : e.norm.size ? "mixed" : "blocks", cls: [...e.norm][0] || [...(occupancy[day][p].sessions.get([...e.comb][0]) || [])][0] });
      }
    }
    return out;
  }, [occupancy, cfg]);
  const [showClashes, setShowClashes] = useState(false);
  const [me, setMe] = useState(null);
  useEffect(() => { try { if (typeof supabase !== "undefined" && supabase && supabase.auth) supabase.auth.getSession().then(({ data }) => { const em = data && data.session && data.session.user && data.session.user.email; if (em) setMe(String(em).split("@")[0].toLowerCase()); }).catch(() => {}); } catch (e) { /* preview */ } }, []);
  const limited = !!(cfg && me && cfg.roles && cfg.roles[me] === "subs");
  useEffect(() => { if (limited && view !== "subs") setView("subs"); }, [limited, view]);
  useEffect(() => {
    const href = cfg && cfg.logoIcon; if (!href) return;
    try {
      const set = (rel, type) => { let l = document.querySelector(`link[rel='${rel}']`); if (!l) { l = document.createElement("link"); l.rel = rel; document.head.appendChild(l); } if (type) l.type = type; l.href = href; };
      set("icon", "image/png"); set("apple-touch-icon");
    } catch (e) { /* ignore */ }
  }, [cfg && cfg.logoIcon]);
  const [fixMsg, setFixMsg] = useState("");
  const doFixAll = () => ask("Fix all clashes? The periods that collide are taken out and placed again at free times. Locked slots, rules and everything else stay as they are.", () => {
    setFixMsg("Fixing…");
    setTimeout(() => {
      try {
        const f = fixAllClashes(cfg);
        update((n) => { n.grid = f.grid; n.combined = f.combined; });
        setFixMsg(`Took out ${f.removed.length} clashing period(s) and placed them again at free times.` + (f.res.unplaced ? ` ${f.res.unplaced} could not be placed without breaking a rule: ${f.res.missing.slice(0, 6).join(", ")}${f.res.missing.length > 6 ? " …" : ""}.` : " Everything fits."));
      } catch (e) { setFixMsg("Couldn't fix: " + ((e && e.message) || e)); }
    }, 50);
  });

  // teacher load: combined sessions count once (not per division)
  const teacherLoad = useMemo(() => {
    if (!cfg) return {};
    const t = {}; cfg.singles.forEach((x) => (t[x] = { target: 0, placed: 0 }));
    const cov = combCover(cfg);
    for (const cn of cfg.classes) for (const row of cfg.bkey[cn] || []) {
      if (isCombined(row.teacher)) continue;
      const own = Math.max(0, periodsFor(cfg, cn, row.sub) - (cov[cn + "|" + row.sub] || 0));
      for (const tk of teachersOf(row.teacher)) if (t[tk]) t[tk].target += own;
    }
    for (const g of Object.values(combGroups(cfg))) for (const tk of g.teachers) if (t[tk]) t[tk].target += g.need;
    for (const day of cfg.days) for (let p = 0; p < cfg.periods.length; p++) {
      const reg = {}, grp = {};
      for (const cn of cfg.classes) {
        const code = cfg.grid[cn]?.[day]?.[p]?.[0]; if (!code) continue;
        if (isCombined(code)) { const gk = combGroupOf(combinedByBase[combName(combinedByBase, code)]); for (const tk of teachersOf(code)) (grp[tk] || (grp[tk] = new Set())).add(gk); }
        else for (const tk of teachersOf(code)) reg[tk] = (reg[tk] || 0) + 1;
      }
      for (const tk of new Set([...Object.keys(reg), ...Object.keys(grp)])) if (t[tk]) t[tk].placed += (reg[tk] || 0) + (grp[tk] ? grp[tk].size : 0);
    }
    return t;
  }, [cfg, combinedByBase]);

  useEffect(() => {
    if (!cfg || !cfg.teacherLinks || !cfg.teacherLinks.on) return;
    const tk = cfg.teacherLinks.tokens || {}; const miss = cfg.singles.filter((t) => !tk[t]);
    if (miss.length) update((n) => { const nt = { ...((n.teacherLinks || {}).tokens || {}) }; miss.forEach((t) => { if (!nt[t]) nt[t] = newToken(); }); n.teacherLinks = { ...(n.teacherLinks || {}), tokens: nt }; });
  }, [cfg && cfg.singles, cfg && cfg.teacherLinks && cfg.teacherLinks.on]);
  const tabStatus = useMemo(() => {
    if (!cfg) return {};
    const cov = combCover(cfg);
    const mapped = cfg.classes.filter((c) => { const rows = cfg.bkey[c] || []; return rows.length > 0 && rows.every((r) => r.sub && (r.teacher || (cov[c + "|" + r.sub] || 0) >= periodsFor(cfg, c, r.sub))); }).length;
    let f = 0, tot = 0; for (const c of cfg.classes) { const lim = classPeriods(cfg, c); for (const d of cfg.days) for (let p = 0; p < lim; p++) { tot++; if (cfg.grid?.[c]?.[d]?.[p]?.[0]) f++; } }
    const pct = tot ? Math.floor((f * 100) / tot) : 0;
    let freeTot = 0; for (const t of cfg.singles) freeTot += Math.max(0, teacherCap(cfg, t) - ((teacherLoad[t] || {}).placed || 0));
    const nRules = Object.values(cfg.rules || {}).filter((r) => r && (r.pin || r.forbid || r.band || r.distinct)).length + Object.keys(cfg.classRules || {}).length + (cfg.commonPeriods || []).length + Object.keys(cfg.teacherDays || {}).filter((k) => (cfg.teacherDays[k] || []).length).length;
    const pl = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    return {
      classes: { text: pl(cfg.classes.length, "class").replace("classs", "classes"), tone: cfg.classes.length ? "info" : "warn" },
      teachers: { text: pl(cfg.singles.length, "teacher"), tone: cfg.singles.length ? "info" : "warn" },
      free: { text: `${freeTot} free / week`, tone: "info" },
      bkey: { text: `${mapped} / ${cfg.classes.length} mapped`, tone: cfg.classes.length && mapped === cfg.classes.length ? "ok" : "warn" },
      edit: { text: tot ? `${pct}% filled` : "empty", tone: tot && f === tot ? "ok" : "warn" },
      rules: { text: nRules ? pl(nRules, "rule") + " set" : "no rules", tone: "info" },
      combined: { text: pl((cfg.combined || []).length, "session"), tone: "info" },
      analysis: { text: totalClashes ? pl(totalClashes, "clash").replace("clashs", "clashes") : "no clashes", tone: totalClashes ? "bad" : "ok" },
      export: { text: "PDF · CSV · backup", tone: "info" },
      subs: (() => { const t = isoToday(), nd = subsNeeds(cfg, t), a = ((cfg.subs || {})[t] || {}).assign || {}, ab = Object.keys(((cfg.subs || {})[t] || {}).absent || {}).length, cv = nd.filter((x) => a[x.key]).length; return ab ? { text: `${ab} absent · ${cv}/${nd.length} covered`, tone: cv === nd.length ? "ok" : "warn" } : { text: "no absence today", tone: "info" }; })(),
      assistant: { text: "ask for help", tone: "info" },
      setup: { text: `${cfg.days.length} days · ${cfg.periods.length} periods`, tone: "info" },
    };
  }, [cfg, teacherLoad, totalClashes]);
  if (!cfg) return <div style={{ padding: 40, fontFamily: sans, color: C.sub }}>Loading timetable…</div>;
  // guard: selected items may have been removed
  const safeCls = cfg.classes.includes(cls) ? cls : cfg.classes[0];
  const safeTch = cfg.singles.includes(tch) ? tch : cfg.singles[0];
  const safeFday = cfg.days.includes(fday) ? fday : cfg.days[0];

  SCHOOL_LOGO = cfg.logo || ""; SCHOOL_WM = cfg.wmPdf !== false; SCHOOL_NAME = cfg.school || ""; CUR_TH = TH; CUR_VIEW = view;
  const publishNow = (rows) => { if (rows) publishRows(rows); else if (cfg.teacherLinks && cfg.teacherLinks.on) publishRows(buildTeacherPages(cfg)); };
  const ctx = { me, limited, pubState, publishNow, cfg, update, expand, occupancy, clashTokens, teacherLoad, ask, askPw, isCombined, combinedByBase, mobile };

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
        .tt-note{position:relative;padding:10px 16px 10px 42px!important;font-size:12.5px!important;line-height:1.6!important;color:#4b5870!important;background:linear-gradient(90deg, ${TH.accent}10, rgba(255,255,255,0) 75%);border-top:1px solid ${C.line}}
        .tt-note::before{content:"i";position:absolute;left:16px;top:11px;width:17px;height:17px;border-radius:50%;background:${TH.accent};color:#fff;font:italic 700 11px/17px Georgia,serif;text-align:center}
        .tt-callout{position:relative;margin:0;padding:10px 14px 10px 40px;font-size:12.5px;line-height:1.6;color:#44516a;background:linear-gradient(90deg, ${TH.accent}12, ${TH.accent}05);border:1px solid ${TH.accent}26;border-left:4px solid ${TH.accent};border-radius:10px}
        .tt-callout::before{content:"i";position:absolute;left:13px;top:11px;width:17px;height:17px;border-radius:50%;background:${TH.accent};color:#fff;font:italic 700 11px/17px Georgia,serif;text-align:center}
        .tt-callout b,.tt-note b{color:#16213a}
        @keyframes ttspin{to{transform:rotate(360deg)}}
        .tt-spin{width:14px;height:14px;border-radius:50%;border:2px solid ${TH.accent}33;border-top-color:${TH.accent};animation:ttspin .8s linear infinite;display:inline-block;flex-shrink:0}
        .tt-printbtn:hover{filter:brightness(1.06);box-shadow:0 6px 16px ${TH.accent}55!important}
        .tt-navcard{transition:transform .12s,box-shadow .14s,border-color .14s,background .14s}
        .tt-navcard:hover{transform:translateY(-1px);border-color:${TH.accent}88!important}
        .tt-list::-webkit-scrollbar,.tt-scroll::-webkit-scrollbar{width:9px;height:9px}
        .tt-list::-webkit-scrollbar-thumb,.tt-scroll::-webkit-scrollbar-thumb{background:#d3d9e2;border-radius:5px;border:2px solid transparent;background-clip:padding-box}
        .tt-row:hover td{background:#f8fafb}
        .tt-cellhover:hover{filter:brightness(.97)}
        @keyframes ttfade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
        .tt-fade{animation:ttfade .25s ease}
        @keyframes ttslide{from{transform:translateX(-100%)}to{transform:none}}
        @media print{.tt-noprint{display:none!important}.tt-printarea{box-shadow:none!important;border:none!important}body{background:#fff!important}.tt-printtitle{display:block!important}.tt-printhead{display:flex!important}.tt-vh{box-shadow:none!important;background:#fff!important}}
      `}</style>

      <header className="tt-noprint" style={{ background: `linear-gradient(115deg, ${TH.g2}, ${TH.g1})`, color: "#fff", padding: mobile ? "12px 14px" : "15px 22px", display: "flex", alignItems: "center", gap: mobile ? 10 : 16, position: "sticky", top: 0, zIndex: 30, flexWrap: "wrap", boxShadow: "0 2px 14px rgba(10,79,85,.25)" }}>
        <button className="tt-btn" onClick={() => setMenuOpen(true)} aria-label="Menu" style={{ border: "1px solid rgba(255,255,255,.28)", background: "rgba(255,255,255,.14)", color: "#fff", width: 40, height: 40, borderRadius: 10, fontSize: 20, lineHeight: 1, display: "grid", placeItems: "center", flexShrink: 0 }}>☰</button>
        {cfg.logo ? <div style={{ width: mobile ? 40 : 46, height: mobile ? 40 : 46, borderRadius: 12, background: "#fff", display: "grid", placeItems: "center", padding: 3, boxShadow: "0 2px 10px rgba(0,0,0,.22)", flexShrink: 0 }}><img src={cfg.logo} alt="School logo" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /></div> : <div style={{ width: 40, height: 40, borderRadius: 11, background: "rgba(255,255,255,.16)", border: "1px solid rgba(255,255,255,.25)", color: "#fff", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 16, letterSpacing: -0.5 }}>TT</div>}
        <div style={{ marginRight: "auto" }}>
          <div style={{ fontSize: 16.5, fontWeight: 800, letterSpacing: -0.3 }}>TIME TABLE</div>
          {!mobile && <div style={{ fontSize: 12, color: "rgba(255,255,255,.8)", marginTop: 1, fontWeight: 500 }}>{cfg.school} · {cfg.classes.length} classes · {cfg.singles.length} teachers · {cfg.days.length} days</div>}
        </div>
        <span style={{ display: "inline-flex", gap: 4 }}>
          <button className="tt-btn" onClick={undo} disabled={!histN[0]} title="Undo (Ctrl+Z)" aria-label="Undo" style={{ ...headerBtn, padding: "6px 10px", fontSize: 15, opacity: histN[0] ? 1 : 0.45 }}>↶</button>
          <button className="tt-btn" onClick={redo} disabled={!histN[1]} title="Redo (Ctrl+Y)" aria-label="Redo" style={{ ...headerBtn, padding: "6px 10px", fontSize: 15, opacity: histN[1] ? 1 : 0.45 }}>↷</button>
        </span>
        {!limited && <ClashBadge n={totalClashes} onClick={() => setShowClashes(true)} />}
        <span style={{ fontSize: 12, color: "rgba(255,255,255,.85)", minWidth: 56, textAlign: "right", fontWeight: 500 }}>{saved}</span>
        {!limited && <>
        <button className="tt-btn" onClick={() => askPw("Reset — clear ALL class timetables to blank? Your mapping, classes, teachers and rules are kept.", () => update((n) => { for (const c of n.classes) for (const d of n.days) n.grid[c][d] = emptyDay(n.periods.length); n.locked = {}; }))} style={headerBtn}>Reset</button>
        <button className="tt-btn" onClick={() => askPw("MASTER RESET  -  permanently delete EVERYTHING (all classes, teachers, subjects, mapping, combined subjects, rules, standard periods, and the whole timetable) and start from a blank app? This cannot be undone.", () => update((n) => { n.classes = []; n.singles = []; n.subjects = []; n.combined = []; n.bkey = {}; n.classTeacher = {}; n.grid = {}; n.stdPeriods = {}; n.rules = {}; n.twice = {}; n.classRules = {}; n.locked = {}; n.commonPeriods = []; n.teacherDays = {}; n.versions = []; n.classMaxP = {}; }))} style={{ ...headerBtn, border: "1px solid rgba(255,255,255,.5)", background: "rgba(214,69,69,.35)" }}>Master reset</button>
        </>}
      </header>

      <NavTabs view={view} setView={setView} status={tabStatus} TH={TH} mobile={mobile} only={limited ? ["subs"] : null} />
      <NavDrawer open={menuOpen} onClose={() => setMenuOpen(false)} view={view} setView={setView} TH={TH} school={cfg.school} logo={cfg.logo} status={tabStatus} only={limited ? ["subs"] : null} me={me} theme={theme} setTheme={persistTheme} onSignOut={handleSignOut} />
      <div className="tt-printhead" style={{ display: "none", alignItems: "center", gap: 12, borderBottom: `3px solid ${TH.g1}`, padding: "0 0 8px", margin: "0 0 10px" }}>
        {cfg.logo && <img src={cfg.logo} alt="" style={{ height: 52, width: 52, objectFit: "contain" }} />}
        <div><div style={{ fontSize: 19, fontWeight: 800, color: TH.g2, textTransform: "uppercase", letterSpacing: 0.6 }}>{cfg.school}</div><div style={{ fontSize: 11, fontWeight: 800, color: C.accent, letterSpacing: 2.2, textTransform: "uppercase" }}>{(TABS.find((t) => t[0] === view) || ["", ""])[1]}</div></div>
        <div style={{ marginLeft: "auto", fontSize: 11, color: C.sub }}>Printed {new Date().toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}</div>
      </div>
      <main style={{ display: "flex", alignItems: "flex-start", flexDirection: mobile ? "column" : "row" }}>
        {!mobile && (view === "classes" || view === "edit" || view === "bkey") && (
          <Sidebar title="Classes" items={cfg.classes} sel={safeCls} onSel={setCls} sub={(x) => "CT " + (cfg.classTeacher[x] || "—")} />
        )}
        {!mobile && view === "teachers" && <Sidebar title="Teachers" items={cfg.singles} sel={safeTch} onSel={setTch} />}
        <section key={view} className="tt-fade" style={{ flex: 1, padding: mobile ? 12 : 22, minWidth: 0, width: "100%" }}>
          {mobile && cfg.classes.length > 0 && (view === "classes" || view === "edit" || view === "bkey") && <MobilePicker label="Class" items={cfg.classes} value={safeCls} onChange={setCls} />}
          {mobile && cfg.singles.length > 0 && view === "teachers" && <MobilePicker label="Teacher" items={cfg.singles} value={safeTch} onChange={setTch} />}
          {view === "classes" && (cfg.classes.length ? <ClassView {...ctx} cls={safeCls} /> : <EmptyState msg="No classes yet. Add classes in Classes & setup, then set up your Mapping." onGo={() => setView("setup")} />)}
          {view === "teachers" && (cfg.singles.length ? <TeacherView {...ctx} tch={safeTch} /> : <EmptyState msg="No teachers yet. Add teachers in Classes & setup (or import them with a mapping CSV)." onGo={() => setView("setup")} />)}
          {view === "subs" && <SubsView {...ctx} />}
          {view === "free" && <FreeView {...ctx} fday={safeFday} setFday={setFday} fper={fper} setFper={setFper} />}
          {view === "bkey" && (cfg.classes.length ? <BKeyView {...ctx} cls={safeCls} setCls={setCls} /> : <EmptyState msg="No classes yet. Add classes in Classes & setup first, then map subjects and teachers here." onGo={() => setView("setup")} />)}
          {view === "edit" && (cfg.classes.length ? <EditView {...ctx} cls={safeCls} /> : <EmptyState msg="No classes yet. Add classes and set up the Mapping before generating a timetable." onGo={() => setView("setup")} />)}
          {view === "rules" && <RulesView {...ctx} />}
          {view === "combined" && <CombinedView {...ctx} />}
          {view === "analysis" && <AnalysisView {...ctx} />}
          {view === "export" && <ExportView {...ctx} />}
          {view === "assistant" && <AssistantView {...ctx} />}
          {view === "setup" && <SetupView {...ctx} />}
        </section>
      </main>
      {conflict && (
        <div className="tt-noprint" style={{ position: "fixed", left: 12, right: 12, bottom: 12, zIndex: 95, maxWidth: 720, margin: "0 auto", background: "#fff", border: `2px solid ${C.warn}`, borderRadius: 14, boxShadow: "0 12px 34px rgba(0,0,0,.25)", padding: 14, display: "grid", gap: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#7a5310" }}>⚠ Someone else changed the timetable at the same time</div>
          <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.5 }}>Your last change was <b>not saved</b> yet, so nobody's work is lost. Choose which version to keep. (Whichever you don't choose is kept as a safety copy.)</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="tt-btn" onClick={() => { const c = conflict; setConflict(null); if (c.remote) { makeSnapshot(c.mine, "My unsaved change (before loading the other version)", "auto").then((rec) => { setCfg((cur) => { const n = { ...cur, snapshots: pruneSnaps([...(cur.snapshots || []), rec]) }; persist(n); return n; }); }).catch(() => {}); acceptRemote(c.stamp); lastSaved.current = JSON.stringify(c.remote); setCfg(c.remote); setSaved("loaded the other version"); } }} style={solidBtn}>Load their version</button>
            <button className="tt-btn" onClick={async () => { const c = conflict; setConflict(null); try { if (c.remote) { const rec = await makeSnapshot(c.remote, "The other person's version (overwritten)", "auto"); c.mine = { ...c.mine, snapshots: pruneSnaps([...(c.mine.snapshots || []), rec]) }; setCfg(c.mine); } await saveConfig(c.mine, { force: true }); setSaved("saved"); schedulePublish(c.mine); } catch (e) { setSaved("offline · saved on device"); } }} style={ghostBtn}>Keep mine</button>
          </div>
        </div>
      )}
      {cfg.logo && cfg.wmApp !== false && <div aria-hidden="true" className="tt-noprint" style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 5, backgroundImage: `url(${cfg.logo})`, backgroundRepeat: "no-repeat", backgroundPosition: "center 60%", backgroundSize: mobile ? "72vw" : "min(40vw, 440px)", opacity: 0.05 }} />}
      {showClashes && <ClashListModal list={clashList} onFix={doFixAll} fixMsg={fixMsg} onClose={() => { setShowClashes(false); setFixMsg(""); }} onOpen={(x) => { setShowClashes(false); if (x.kind === "blocks") setView("combined"); else { if (x.cls) setCls(x.cls); setView("edit"); } }} />}
      {pwState && <PwModal msg={pwState.msg} pwHash={cfg.adminPw} onSetPw={(h) => update((n) => { n.adminPw = h; })} onCancel={() => setPwState(null)} onDone={() => { const f = pwState.onYes; setSnapHint(pwState.msg); setPwState(null); f(); }} />}
      {confirmState && <ConfirmModal msg={confirmState.msg} onYes={() => { setSnapHint(confirmState.msg); confirmState.onYes(); setConfirmState(null); }} onNo={() => setConfirmState(null)} />}
    </div>
  );
}

function EmptyState({ title, msg, onGo }) {
  return (
    <div style={{ ...card, padding: 30, textAlign: "center", maxWidth: 520, margin: "0 auto" }}>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6, color: C.ink }}>{title || "Nothing here yet"}</div>
      <div style={{ fontSize: 13.5, color: C.sub, marginBottom: 16, lineHeight: 1.6 }}>{msg}</div>
      {onGo && <button className="tt-btn" onClick={onGo} style={solidBtn}>Go to Classes & setup</button>}
    </div>
  );
}

function ClashListModal({ list, onClose, onOpen, onFix, fixMsg }) {
  const combOnly = list.length > 0 && list.every((x) => x.kind === "blocks");
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,25,33,.45)", display: "grid", placeItems: "center", zIndex: 100, padding: 12 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, width: 640, maxWidth: "96vw", maxHeight: "86vh", display: "flex", flexDirection: "column", boxShadow: "0 12px 40px rgba(0,0,0,.25)" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "14px 16px", borderBottom: `1px solid ${C.line}` }}>
          <b style={{ fontSize: 15, color: list.length ? C.clash : C.free }}>{list.length ? `${list.length} clash${list.length > 1 ? "es" : ""}` : "No clashes"}</b>
          {list.length > 0 && onFix && <button className="tt-btn" onClick={onFix} style={{ ...solidBtn, marginLeft: 12, padding: "6px 12px" }}>Fix all clashes</button>}
          <button className="tt-btn" onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "transparent", fontSize: 22, cursor: "pointer", lineHeight: 1, color: C.sub }}>×</button>
        </div>
        {fixMsg && <div style={{ margin: "12px 16px 0", padding: "9px 12px", borderRadius: 9, background: C.primarySoft, color: C.primary, fontSize: 12.5, lineHeight: 1.55 }}>{fixMsg}</div>}
        {combOnly && <div style={{ margin: "12px 16px 0", padding: "9px 12px", borderRadius: 9, background: C.warnSoft, color: C.warn, fontSize: 12.5, lineHeight: 1.55 }}>All of these are teachers placed in two combined blocks at the same time (for example two standards' language periods together). Press “Fix all clashes”: one block keeps each slot and the others move to free times.</div>}
        <div style={{ overflowY: "auto", padding: "8px 16px 14px" }}>
          {list.length === 0 && <div style={{ color: C.sub, fontSize: 13, padding: 10 }}>Every teacher is in only one place at a time.</div>}
          {list.map((x, k) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `1px solid ${C.line}`, fontSize: 12.5, lineHeight: 1.5 }}>
              <div style={{ minWidth: 70 }}><b style={{ fontFamily: mono }}>{x.t}</b><div style={{ color: C.sub, fontSize: 11.5 }}>{x.day} P{x.p + 1}</div></div>
              <div style={{ flex: 1 }}>
                <div>{x.where.join("  +  ")}</div>
                <div style={{ color: C.clash, fontSize: 11.5 }}>{x.kind === "regular" ? "in two classes at once" : x.kind === "mixed" ? "in a class and a combined session at once" : "in two combined blocks at once"}</div>
              </div>
              <button className="tt-btn" onClick={() => onOpen(x)} style={{ ...ghostBtn, padding: "5px 10px" }}>Open</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PwModal({ msg, pwHash, onSetPw, onDone, onCancel }) {
  const [a, setA] = useState(""); const [b, setB] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const setting = !pwHash;
  const go = async () => {
    setErr("");
    if (setting) {
      if (a.length < 4) { setErr("Use at least 4 characters."); return; }
      if (a !== b) { setErr("The two passwords don't match."); return; }
      setBusy(true); const h = await hashPw(a); onSetPw(h); setBusy(false); onDone(); return;
    }
    setBusy(true); const h = await hashPw(a); setBusy(false);
    if (h !== pwHash) { setErr("Wrong password."); setA(""); return; }
    onDone();
  };
  const inp = { width: "100%", boxSizing: "border-box", marginTop: 8, fontSize: 14, padding: "9px 11px" };
  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(20,25,33,.45)", display: "grid", placeItems: "center", zIndex: 110 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, padding: 22, width: 380, maxWidth: "90vw", boxShadow: "0 12px 40px rgba(0,0,0,.25)" }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: C.clash, marginBottom: 6 }}>🔒 Password required</div>
        <div style={{ fontSize: 14, lineHeight: 1.5, color: C.ink, marginBottom: 10 }}>{msg}</div>
        {setting && <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.5 }}>No admin password has been set yet. Choose one now — it will be needed for Reset, Clear all, Clear all mapping and Master reset. You can change it in Classes &amp; setup.</div>}
        <input className="tt-in" type="password" autoFocus placeholder={setting ? "New password" : "Admin password"} value={a} onChange={(e) => setA(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !setting) go(); }} style={inp} />
        {setting && <input className="tt-in" type="password" placeholder="Repeat password" value={b} onChange={(e) => setB(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") go(); }} style={inp} />}
        {err && <div style={{ color: C.clash, fontSize: 12.5, marginTop: 8 }}>{err}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
          <button className="tt-btn" onClick={onCancel} style={ghostBtn}>Cancel</button>
          <button className="tt-btn" onClick={go} disabled={busy || !a} style={{ ...solidBtn, background: C.clash, opacity: busy || !a ? 0.6 : 1 }}>{setting ? "Set password & continue" : "Unlock & continue"}</button>
        </div>
      </div>
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

function ClashBadge({ n, onClick }) {
  const ok = n === 0;
  return (
    <div onClick={onClick} title={ok ? "" : "Show the list of clashes"} style={{ cursor: onClick && !ok ? "pointer" : "default", display: "flex", alignItems: "center", gap: 7, padding: "6px 11px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, background: ok ? C.freeSoft : C.clashSoft, color: ok ? C.free : C.clash }}>
      <span style={{ width: 8, height: 8, borderRadius: 9, background: ok ? C.free : C.clash }} />
      {ok ? "No clashes" : `${n} clash${n > 1 ? "es" : ""} — show`}
    </div>
  );
}
function Sidebar({ title, items, sel, onSel, sub }) {
  const [q, setQ] = useState("");
  const shown = items.filter((x) => !q.trim() || x.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <aside className="tt-noprint tt-list" style={{ width: 188, flexShrink: 0, borderRight: `1px solid ${C.line}`, background: C.surface, height: "calc(100vh - 110px)", overflowY: "auto", position: "sticky", top: 110 }}>
      <div style={{ padding: "12px 16px 8px", fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase", color: C.sub, fontWeight: 700 }}>{title}</div>
      <div style={{ padding: "0 10px 8px" }}><input className="tt-in" style={{ width: "100%", fontSize: 12.5, padding: "6px 8px" }} placeholder={`Search ${title.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {shown.length === 0 && <div style={{ padding: "6px 16px", fontSize: 12, color: C.sub }}>No match.</div>}
      {shown.map((x) => (
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
    subs: "M16 3l4 4-4 4M20 7H9M8 21l-4-4 4-4M4 17h11",
    bkey: "M14 8a4 4 0 10-3.9 4H11l-1.5 1.5L11 15l-1.5 1.5L11 18H8l-2-2v-2h2l2.1-2.1A4 4 0 0114 8z",
    edit: "M4 5h16M4 12h16M4 19h16M9 5v14",
    rules: "M4 7h16M4 17h16M9 4v6M17 14v6",
    combined: "M8 12a3 3 0 100-6 3 3 0 000 6zM17 12a3 3 0 100-6 3 3 0 000 6zM2 20a5 5 0 0110 0M13 20a5 5 0 019 0",
    analysis: "M4 20V10M10 20V4M16 20v-8M20 20H3",
    assistant: "M21 14a2 2 0 01-2 2H9l-5 4V6a2 2 0 012-2h12a2 2 0 012 2z",
    export: "M12 3v12M8 11l4 4 4-4M5 21h14",
    setup: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 13a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 11-4 0v-.2A1.7 1.7 0 006 19.5l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 003 13H2.8a2 2 0 110-4H3a1.7 1.7 0 001.5-2.9l-.1-.1a2 2 0 112.8-2.8l.1.1A1.7 1.7 0 0010 3.4V3a2 2 0 114 0v.2a1.7 1.7 0 002.9 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1A1.7 1.7 0 0021 10.6h.2a2 2 0 110 4H21z",
  }[name];
  if (!P) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d={P} /></svg>
  );
}

function ViewHeader({ title, note, right, meta, icon }) {
  const th = CUR_TH || THEMES.teal, ic = icon || CUR_VIEW;
  return (
    <div className="tt-vh" style={{ position: "relative", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 16, padding: "16px 18px 16px 22px", borderRadius: 16, background: `linear-gradient(118deg, #ffffff 52%, ${th.accent}14)`, border: `1px solid ${C.line}`, boxShadow: C.shadow, overflow: "hidden" }}>
      <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 5, background: `linear-gradient(180deg, ${th.g1}, ${th.g2})` }} />
      <span aria-hidden="true" className="tt-noprint" style={{ width: 48, height: 48, borderRadius: 14, display: "grid", placeItems: "center", background: `linear-gradient(135deg, ${th.g1}, ${th.g2})`, color: "#fff", boxShadow: `0 6px 14px ${th.accent}40`, flexShrink: 0 }}><Icon name={ic} size={22} /></span>
      <div style={{ minWidth: 0, flex: "1 1 260px" }}>
        {SCHOOL_NAME && <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1.6, textTransform: "uppercase", color: th.accent, marginBottom: 2 }}>{SCHOOL_NAME}</div>}
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: -0.4, color: C.ink, lineHeight: 1.2 }}>{title}</h1>
        {note && <div style={{ fontSize: 13, color: C.sub, marginTop: 5, lineHeight: 1.55, maxWidth: 860 }}>{note}</div>}
        {meta && meta.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 9 }}>
            {meta.map(([k, v, tone], i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, padding: "3px 10px", borderRadius: 20, background: tone === "ok" ? C.freeSoft : tone === "warn" ? C.warnSoft : "#fff", border: `1px solid ${tone === "ok" ? "#bfe6cf" : tone === "warn" ? "#f0dcae" : C.line}` }}>
                <span style={{ color: C.sub, fontWeight: 600 }}>{k}</span>
                <b style={{ color: tone === "ok" ? C.free : tone === "warn" ? C.warn : C.ink, fontFamily: mono }}>{v}</b>
              </span>
            ))}
          </div>
        )}
      </div>
      {right && <div className="tt-noprint" style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>{right}</div>}
    </div>
  );
}
const PB_ICON = {
  print: "M6 9V3h12v6M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v7H6z",
  pdf: "M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5M9 13h6M9 17h4",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
};
function PrintBtn({ onClick, label = "Print / PDF", sub, icon = "print", light }) {
  const th = CUR_TH || THEMES.teal;
  return (
    <button className="tt-btn tt-printbtn" onClick={onClick} style={{ display: "inline-flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "7px 15px 7px 8px", borderRadius: 12, textAlign: "left", fontSize: 13, fontWeight: 700,
      border: light ? `1.5px solid ${th.accent}55` : "none", color: light ? th.g2 : "#fff", background: light ? "#fff" : `linear-gradient(135deg, ${th.g1}, ${th.g2})`, boxShadow: light ? "0 1px 3px rgba(22,33,58,.08)" : `0 4px 12px ${th.accent}45` }}>
      <span style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0, display: "grid", placeItems: "center", background: light ? `${th.accent}14` : "rgba(255,255,255,.18)" }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={PB_ICON[icon] || PB_ICON.print} /></svg>
      </span>
      <span>
        <span style={{ display: "block", lineHeight: 1.2 }}>{label}</span>
        {sub && <span style={{ display: "block", fontSize: 10.5, fontWeight: 600, opacity: 0.8, marginTop: 1 }}>{sub}</span>}
      </span>
    </button>
  );
}
function Panelhead({ text, count, tone }) {
  const th = CUR_TH || THEMES.teal;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 16px", borderBottom: `1px solid ${C.line}`, background: "linear-gradient(180deg, #fbfcfd, #f4f6f9)" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 9, fontSize: 13.5, fontWeight: 800, color: C.ink, letterSpacing: -0.1 }}>
        <span aria-hidden="true" style={{ width: 4, height: 16, borderRadius: 3, background: `linear-gradient(180deg, ${th.g1}, ${th.g2})`, flexShrink: 0 }} />{text}
      </span>
      {count != null && <span style={{ fontSize: 11.5, fontWeight: 700, padding: "2px 10px", borderRadius: 20, whiteSpace: "nowrap", background: tone === "free" ? C.freeSoft : `${th.accent}14`, color: tone === "free" ? C.free : th.accent }}>{count}</span>}
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
function ClassView({ cfg, cls, expand, clashTokens, combinedByBase }) {
  const ct = cfg.classTeacher[cls];
  let nPer = 0; const subs = new Set();
  for (const d of cfg.days) for (const sl of cfg.grid[cls]?.[d] || []) if (sl && sl[0]) { nPer++; subs.add(sl[1]); }
  const nSub = subs.size;
  return (
    <div>
      <ViewHeader title={`Class ${cls}`} meta={[["Class teacher", ct || "—"], ["Periods / week", nPer], ["Subjects", nSub]]} right={<PrintBtn onClick={() => exportClassesPDF(cfg, "A4", [cls])} sub="A4 landscape · with letterhead" />} />
      <div className="tt-printarea" style={card}>
        <GridTable cfg={cfg} render={(d, pi) => {
          if (pi >= classPeriods(cfg, cls)) return { bg: "#eef0f3" };
          const [t, s] = cfg.grid[cls][d][pi];
          const clash = expand(t).some((x) => clashTokens(d, pi).has(x));
          const ses = t && combinedByBase ? combinedByBase[t] : null;
          return { t: ses ? ses.teachers.join(" ") : t, s: ses ? `${s} · combined` : s, bg: t ? (SUBJECT_TINT[s] || "#fff") : "#fafafa", clash, sub: s };
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
    const bases = [...e.comb]; const base = bases[0];
    const divs = [...new Set(bases.flatMap((b) => [...(occupancy[d][pi].sessions.get(b) || [])]))].sort(cmpClass);
    const sess = combinedByBase[base];
    return { cn: divs.join(" "), subj: sess?.sub, code: bases.length > 1 ? combGroupOf(sess) + " (combined)" : base, combined: true };
  };
  let placed = 0; cfg.days.forEach((d) => cfg.periods.forEach((p, pi) => { if (lookup(d, pi)) placed++; }));
  const freeCount = teacherCap(cfg, tch) - placed;
  return (
    <div>
      <ViewHeader title={`Teacher ${tch}`} meta={[["Placed", placed], ["Free", freeCount, "ok"], ["Mapping target", ld.target, ld.target > placed ? "warn" : undefined]]} right={<><ShareLinkButton cfg={cfg} t={tch} /><PrintBtn onClick={() => exportTeachersPDF(cfg, "A4", [tch])} sub="A4 landscape · with letterhead" /></>} />
      <div className="tt-printarea" style={card}>
        <GridTable cfg={cfg} render={(d, pi) => {
          const r = lookup(d, pi);
          if (!r) { const ex = extraAt(cfg, tch, d, pi); if (ex) return { t: ex.label, s: ex.kind === "class" ? "outside this timetable" : "non-teaching duty", bg: "#f1ecfa" }; return { free: true, bg: C.freeSoft }; }
          return { t: r.cn, s: `${r.subj || ""}${r.combined ? " · combined" : r.code !== tch ? " · " + r.code : ""}`, bg: r.combined ? C.accentSoft : SUBJECT_TINT[r.subj] || "#fff", sub: r.subj };
        }} />
      </div>
    </div>
  );
}

/* generic weekly grid renderer */
function MobilePicker({ label, items, value, onChange }) {
  const [q, setQ] = useState("");
  const list = items.filter((x) => !q.trim() || x === value || x.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 10, padding: "8px 10px" }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
      <input className="tt-in" style={{ width: 84, fontSize: 13, padding: "8px 8px" }} placeholder="Search" value={q} onChange={(e) => { const v = e.target.value; setQ(v); const m = items.filter((x) => x.toLowerCase().includes(v.trim().toLowerCase())); if (v.trim() && m.length === 1) onChange(m[0]); }} />
      <select className="tt-sel" style={{ flex: 1, fontSize: 14, padding: "9px 10px", fontFamily: mono, fontWeight: 700 }} value={value} onChange={(e) => onChange(e.target.value)}>
        {list.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
    </div>
  );
}

function tabTone(tone, TH) {
  if (tone === "ok") return { bg: C.freeSoft, fg: C.free };
  if (tone === "warn") return { bg: C.warnSoft, fg: C.warn };
  if (tone === "bad") return { bg: C.clashSoft, fg: C.clash };
  return { bg: `${TH.accent}14`, fg: TH.accent };
}
function NavTabs({ view, setView, status, TH, mobile, only }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!mobile || !ref.current) return;
    try { const el = ref.current.querySelector("[aria-selected='true']"); if (el) ref.current.scrollTo({ left: Math.max(0, el.offsetLeft - 14), behavior: "smooth" }); } catch (e) { /* ignore */ }
  }, [view, mobile]);
  return (
    <nav ref={ref} role="tablist" className="tt-noprint tt-scroll" style={mobile
      ? { display: "flex", gap: 8, padding: "10px 12px", background: C.surface, borderBottom: `1px solid ${C.line}`, overflowX: "auto", WebkitOverflowScrolling: "touch" }
      : { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(176px, 1fr))", gap: 10, padding: "14px 18px", background: C.surface, borderBottom: `1px solid ${C.line}` }}>
      {TABS.filter(([k]) => !only || only.includes(k)).map(([k, label]) => {
        const on = view === k, st = status[k] || {}, tn = tabTone(st.tone, TH);
        return (
          <button key={k} role="tab" aria-selected={on} className="tt-btn tt-navcard" onClick={() => setView(k)} title={label}
            style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 10, padding: mobile ? "7px 10px" : "9px 11px", borderRadius: 13, cursor: "pointer", minWidth: mobile ? 158 : 0, flexShrink: 0,
              border: `2px solid ${on ? TH.accent : C.line}`, background: on ? `${TH.accent}10` : "#fff", boxShadow: on ? `0 6px 16px ${TH.accent}2e` : "0 1px 2px rgba(22,33,58,.05)" }}>
            <span style={{ flexShrink: 0, width: mobile ? 32 : 38, height: mobile ? 32 : 38, borderRadius: 11, display: "grid", placeItems: "center", background: on ? `linear-gradient(135deg, ${TH.g1}, ${TH.g2})` : "#f1f4f7", color: on ? "#fff" : TH.accent, boxShadow: on ? `0 3px 8px ${TH.accent}44` : "none" }}><Icon name={k} size={mobile ? 16 : 18} /></span>
            <span style={{ minWidth: 0, display: "block" }}>
              <span style={{ display: "block", fontSize: mobile ? 12.5 : 13.2, fontWeight: 800, color: on ? TH.g2 : C.ink, lineHeight: 1.2, whiteSpace: mobile ? "nowrap" : "normal" }}>{label}</span>
              {st.text && <span style={{ display: "inline-block", marginTop: 4, fontSize: 10.5, fontWeight: 700, padding: "1px 8px", borderRadius: 20, background: tn.bg, color: tn.fg, whiteSpace: "nowrap", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>{st.text}</span>}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

/* ---------------- School logo ---------------- */
function logoBBox(img) {
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  const s = Math.min(1, 600 / Math.max(W, H)), w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const x = cv.getContext("2d"); x.drawImage(img, 0, 0, w, h);
  let d; try { d = x.getImageData(0, 0, w, h).data; } catch (e) { return { sx: 0, sy: 0, sw: W, sh: H }; }
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const i = (yy * w + xx) * 4;
    if (d[i + 3] > 12 && !(d[i] > 246 && d[i + 1] > 246 && d[i + 2] > 246)) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
  }
  if (x1 < 0) return { sx: 0, sy: 0, sw: W, sh: H };
  return { sx: x0 / s, sy: y0 / s, sw: (x1 - x0 + 1) / s, sh: (y1 - y0 + 1) / s };
}
function logoCanvas(img, box, size, square, pad) {
  const r = box.sw / box.sh;
  const cv = document.createElement("canvas");
  if (!square) {
    const w = r >= 1 ? size : Math.round(size * r), h = r >= 1 ? Math.round(size / r) : size;
    cv.width = w; cv.height = h;
    const x = cv.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(img, box.sx, box.sy, box.sw, box.sh, 0, 0, w, h);
    return cv;
  }
  cv.width = size; cv.height = size;
  const x = cv.getContext("2d"); x.fillStyle = "#ffffff"; x.fillRect(0, 0, size, size);
  const inner = size * (1 - 2 * pad), w = r >= 1 ? inner : inner * r, h = r >= 1 ? inner / r : inner;
  x.imageSmoothingQuality = "high"; x.drawImage(img, box.sx, box.sy, box.sw, box.sh, (size - w) / 2, (size - h) / 2, w, h);
  return cv;
}
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("This image could not be read.")); i.src = src; }); }
function downloadCanvas(cv, name) {
  try {
    const a = document.createElement("a"); a.href = cv.toDataURL("image/png"); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 200);
  } catch (e) { alert("Couldn't download: " + ((e && e.message) || e)); }
}
function processStamp(img, removeWhite, maxW) {
  const W0 = img.naturalWidth || img.width, H0 = img.naturalHeight || img.height;
  const k = Math.min(1, 1400 / Math.max(W0, H0)), w0 = Math.max(1, Math.round(W0 * k)), h0 = Math.max(1, Math.round(H0 * k));
  const cv = document.createElement("canvas"); cv.width = w0; cv.height = h0;
  const x = cv.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(img, 0, 0, w0, h0);
  let id; try { id = x.getImageData(0, 0, w0, h0); } catch (e) { return cv.toDataURL("image/png"); }
  const dt = id.data;
  if (removeWhite) {
    // paper level = bright end of the picture (handles grey-ish photos of white paper)
    const hist = new Array(256).fill(0); for (let i = 0; i < dt.length; i += 16) hist[Math.round(0.299 * dt[i] + 0.587 * dt[i + 1] + 0.114 * dt[i + 2])]++;
    let tot = 0, cnt = hist.reduce((a, b) => a + b, 0), paper = 255; for (let v = 255; v >= 0; v--) { tot += hist[v]; if (tot >= cnt * 0.5) { paper = v; break; } }
    const hi = Math.max(120, paper - 18), lo = Math.max(60, hi - 70);
    for (let i = 0; i < dt.length; i += 4) {
      const lum = 0.299 * dt[i] + 0.587 * dt[i + 1] + 0.114 * dt[i + 2];
      const sat = Math.max(dt[i], dt[i + 1], dt[i + 2]) - Math.min(dt[i], dt[i + 1], dt[i + 2]);
      let a = lum >= hi ? 0 : lum <= lo ? 1 : (hi - lum) / (hi - lo);
      if (sat > 70 && lum < hi) a = Math.max(a, 0.85);
      dt[i + 3] = Math.round(dt[i + 3] * a);
    }
    x.putImageData(id, 0, 0);
  }
  let x0 = w0, y0 = h0, x1 = -1, y1 = -1;
  for (let yy = 0; yy < h0; yy++) for (let xx = 0; xx < w0; xx++) {
    const i = (yy * w0 + xx) * 4;
    if (dt[i + 3] > 40 && !(dt[i] > 246 && dt[i + 1] > 246 && dt[i + 2] > 246)) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
  }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = w0 - 1; y1 = h0 - 1; }
  const pad = 4; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w0 - 1, x1 + pad); y1 = Math.min(h0 - 1, y1 + pad);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, s = Math.min(1, maxW / Math.max(bw, bh));
  const out = document.createElement("canvas"); out.width = Math.max(1, Math.round(bw * s)); out.height = Math.max(1, Math.round(bh * s));
  const o = out.getContext("2d"); o.imageSmoothingQuality = "high"; o.drawImage(cv, x0, y0, bw, bh, 0, 0, out.width, out.height);
  let url = out.toDataURL("image/webp", 0.9);
  if (!/^data:image\/webp/.test(url)) url = out.toDataURL("image/png");
  return url;
}
const HM_TITLES = ["Headmaster", "Headmistress", "Head Teacher", "Principal", "Vice Principal", "Manager"];
function StampCard({ cfg, update, mobile }) {
  const [msg, setMsg] = useState(null);
  const [crop, setCrop] = useState(null);
  const [clean, setClean] = useState(true);
  const [busy, setBusy] = useState("");
  const [drag, setDrag] = useState("");
  const th = CUR_TH || THEMES.teal;
  const hmTitle = cfg.hmTitle || "Headmaster";
  const [customT, setCustomT] = useState(!!cfg.hmTitle && !HM_TITLES.includes(cfg.hmTitle));
  const handle = (field, label, maxW, f) => {
    if (!f) return;
    if (!/^image\//.test(f.type)) { setMsg({ ok: false, text: "Please choose an image file (PNG, JPG or WEBP)." }); return; }
    setMsg(null);
    readAsDataUrl(f).then((src) => setCrop({ src, field, label, maxW })).catch((er) => setMsg({ ok: false, text: er.message }));
  };
  const afterCrop = (url) => {
    const { field, label, maxW } = crop; setCrop(null); setBusy(field);
    setTimeout(async () => {
      try {
        const img = await loadImg(url);
        const data = processStamp(img, clean, maxW);
        update((n) => { n[field] = data; });
        setMsg({ ok: true, text: `${label} added — see the preview below.` });
      } catch (er) { setMsg({ ok: false, text: (er && er.message) || "Couldn't use this image." }); }
      setBusy("");
    }, 30);
  };
  const checker = "repeating-conic-gradient(#eef1f5 0 25%, #ffffff 0 50%) 0 0 / 14px 14px";
  const Drop = ({ field, label, hint, maxW, icon }) => {
    const has = !!cfg[field], working = busy === field;
    return (
      <div style={{ minWidth: 0, border: `1.5px solid ${has ? `${th.accent}55` : C.line}`, borderRadius: 16, overflow: "hidden", background: "#fff", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: `1px solid ${C.line}`, background: "#fafbfc" }}>
          <span style={{ width: 32, height: 32, borderRadius: 10, display: "grid", placeItems: "center", flexShrink: 0, background: has ? `linear-gradient(135deg, ${th.g1}, ${th.g2})` : "#eef1f5", color: has ? "#fff" : th.accent, fontSize: 16 }}>{icon}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: C.ink }}>{label}</div>
            <div style={{ fontSize: 11.5, color: C.sub }}>{hint}</div>
          </div>
          <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 20, whiteSpace: "nowrap", background: has ? C.freeSoft : "#f1f3f6", color: has ? C.free : C.sub }}>{has ? "✓ Added" : "Not added"}</span>
        </div>
        <label onDragOver={(e) => { e.preventDefault(); setDrag(field); }} onDragLeave={() => setDrag("")} onDrop={(e) => { e.preventDefault(); setDrag(""); handle(field, label, maxW, e.dataTransfer.files && e.dataTransfer.files[0]); }}
          style={{ display: "grid", placeItems: "center", height: mobile ? 130 : 140, margin: 10, borderRadius: 12, cursor: "pointer", border: `2px dashed ${drag === field ? th.accent : has ? "transparent" : "#c9d1dc"}`, background: has ? checker : drag === field ? `${th.accent}10` : "#f8fafc", padding: 10, overflow: "hidden" }}>
          <input type="file" accept="image/*" onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; handle(field, label, maxW, f); }} style={{ display: "none" }} />
          {working ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, color: th.accent, fontWeight: 700 }}><span className="tt-spin" />Cleaning the image…</span>
            : has ? <img src={cfg[field]} alt={label} style={{ display: "block", maxWidth: "100%", maxHeight: (mobile ? 130 : 140) - 24, width: "auto", height: "auto", objectFit: "contain" }} />
            : <span style={{ textAlign: "center", color: C.sub, fontSize: 12.5, lineHeight: 1.5 }}>
                <span style={{ display: "grid", placeItems: "center", width: 40, height: 40, margin: "0 auto 6px", borderRadius: 12, background: `${th.accent}14`, color: th.accent }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5M5 20h14" /></svg>
                </span>
                <b style={{ color: C.ink }}>{mobile ? "Tap to take a photo or choose" : "Click or drop an image here"}</b><br />PNG, JPG or a phone photo
              </span>}
        </label>
        {has && (
          <div style={{ display: "flex", gap: 8, padding: "0 10px 10px" }}>
            <label className="tt-btn" style={{ ...ghostBtn, flex: 1, textAlign: "center", cursor: "pointer" }}>
              Replace<input type="file" accept="image/*" onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; handle(field, label, maxW, f); }} style={{ display: "none" }} />
            </label>
            <button className="tt-btn" onClick={() => update((n) => { delete n[field]; })} style={{ ...ghostBtn, flex: 1, color: C.clash }}>Remove</button>
          </div>
        )}
      </div>
    );
  };
  const seg = (val, opts, set) => (
    <div style={{ display: "inline-flex", flexWrap: "wrap", border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden", background: "#fff" }}>
      {opts.map(([k, l]) => <button key={k} className="tt-btn" onClick={() => set(k)} style={{ border: "none", padding: "6px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", background: val === k ? th.accent : "transparent", color: val === k ? "#fff" : C.sub }}>{l}</button>)}
    </div>
  );
  const lab = { display: "grid", gap: 5, fontSize: 11, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 0.4, minWidth: 0 };
  const chk = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: C.ink, cursor: "pointer" };
  const g = stampGeom(cfg), px = mobile ? 3.3 : 3.6;
  return (
    <div style={{ ...card, marginBottom: 16 }}>
      {crop && <CropModal src={crop.src} title={crop.label} square={crop.field === "seal"} onDone={afterCrop} onCancel={() => setCrop(null)} />}
      <Panelhead text="Headmaster signature & school seal" count={cfg.hmSign || cfg.seal ? [cfg.hmSign && "signature", cfg.seal && "seal"].filter(Boolean).join(" + ") : "not set"} tone={cfg.hmSign || cfg.seal ? "free" : undefined} />
      <div style={{ padding: mobile ? 12 : 14, display: "grid", gap: 14 }}>
        <div className="tt-callout">Sign or stamp on plain white paper and take a photo from straight above in good light. The paper is removed and the edges trimmed automatically, so only the ink prints on the class and teacher timetables.</div>
        <div style={{ display: "grid", gridTemplateColumns: mobile ? "minmax(0, 1fr)" : "repeat(2, minmax(0, 1fr))", gap: 12 }}>
          <Drop field="hmSign" label="HM signature" hint="Signed on white paper" maxW={700} icon="✍" />
          <Drop field="seal" label="School seal" hint="Stamped on white paper" maxW={520} icon="◉" />
        </div>
        <label style={{ ...chk, fontSize: 12.5, color: C.sub }}><input type="checkbox" checked={clean} onChange={(e) => setClean(e.target.checked)} /> Remove the white paper background when uploading (untick for a ready-made transparent PNG)</label>
        {msg && <div style={{ fontSize: 12.5, fontWeight: 600, color: msg.ok ? C.free : C.clash }}>{msg.text}</div>}

        <div style={{ display: "grid", gridTemplateColumns: mobile ? "minmax(0, 1fr)" : "repeat(2, minmax(0, 1fr))", gap: 14, padding: 12, borderRadius: 14, background: "#f8fafc", border: `1px solid ${C.line}` }}>
          <label style={lab}>Title under the signature
            <select className="tt-sel" style={{ fontFamily: sans, fontSize: 13, height: 36 }} value={customT ? "__custom" : hmTitle} onChange={(e) => { if (e.target.value === "__custom") setCustomT(true); else { setCustomT(false); update((n) => { n.hmTitle = e.target.value; }); } }}>
              {HM_TITLES.map((x) => <option key={x}>{x}</option>)}
              <option value="__custom">Custom title…</option>
            </select>
          </label>
          {customT ? (
            <label style={lab}>Your title
              <input className="tt-in" autoFocus value={cfg.hmTitle && !HM_TITLES.includes(cfg.hmTitle) ? cfg.hmTitle : ""} onChange={(e) => update((n) => { if (e.target.value.trim()) n.hmTitle = e.target.value; else delete n.hmTitle; })} style={{ fontFamily: sans, fontSize: 13, height: 36 }} />
            </label>
          ) : (
            <label style={lab}>Name (optional)
              <input className="tt-in" value={cfg.hmName || ""} style={{ fontFamily: sans, fontSize: 13, height: 36 }} onChange={(e) => update((n) => { if (e.target.value) n.hmName = e.target.value; else delete n.hmName; })} />
            </label>
          )}
          {customT && (
            <label style={lab}>Name (optional)
              <input className="tt-in" value={cfg.hmName || ""} style={{ fontFamily: sans, fontSize: 13, height: 36 }} onChange={(e) => update((n) => { if (e.target.value) n.hmName = e.target.value; else delete n.hmName; })} />
            </label>
          )}
          <div style={lab}>Signature size {seg(cfg.signSize || "M", [["S", "Small"], ["M", "Medium"], ["L", "Large"]], (v) => update((n) => { n.signSize = v; }))}</div>
          <div style={lab}>Seal size {seg(cfg.sealSize || "M", [["S", "Small"], ["M", "Medium"], ["L", "Large"]], (v) => update((n) => { n.sealSize = v; }))}</div>
          <div style={lab}>Seal position {seg(cfg.sealPos || "corner", [["corner", "Bottom left of page"], ["left", "Beside sign"], ["over", "On the sign"], ["right", "Right"]], (v) => update((n) => { n.sealPos = v; }))}</div>
          <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
            <label style={chk}><input type="checkbox" checked={cfg.signOnClass !== false} onChange={(e) => update((n) => { n.signOnClass = e.target.checked; })} /> Print on class timetables</label>
            <label style={chk}><input type="checkbox" checked={cfg.signOnTeacher !== false} onChange={(e) => update((n) => { n.signOnTeacher = e.target.checked; })} /> Print on teacher timetables</label>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Preview — bottom of a printed timetable (actual proportions)</div>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: mobile && g.pos === "corner" && cfg.seal ? "space-between" : "flex-end", gap: mobile ? 0 : 40, padding: mobile ? "18px 14px 12px" : "18px 26px 14px", border: `1px solid ${C.line}`, borderRadius: 12, background: "#fff", overflow: "hidden", boxShadow: "inset 0 -3px 0 #0e6b7322" }}>
            {g.pos === "corner" && cfg.seal && <img src={cfg.seal} alt="" style={{ width: g.sd * px * (mobile ? 0.8 : 1), height: g.sd * px * (mobile ? 0.8 : 1), objectFit: "contain", opacity: 0.92, mixBlendMode: "multiply", flexShrink: 0, marginRight: mobile ? 10 : 0 }} />}
            {!mobile && <div style={{ marginRight: "auto", fontSize: 11, color: C.sub, lineHeight: 1.5 }}>{cfg.school} · Class 5 A<br />Generated today</div>}
            {!mobile && <div style={{ width: 52 * px, textAlign: "center", flexShrink: 0 }}><div style={{ height: g.boxH * px }} /><div style={{ borderTop: `1.5px solid ${C.ink}`, paddingTop: 3, fontSize: 12, fontWeight: 700 }}>Class Teacher</div></div>}
            <div style={{ width: 52 * px, maxWidth: "100%", textAlign: "center", flexShrink: mobile ? 1 : 0, margin: mobile && g.pos !== "corner" ? "0 auto" : 0 }}>
              <div style={{ height: g.boxH * px, position: "relative", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
                {cfg.seal && g.pos !== "corner" && <img src={cfg.seal} alt="" style={{ position: "absolute", width: g.sd * px, height: g.sd * px, objectFit: "contain", opacity: 0.9, mixBlendMode: "multiply",
                  ...(g.pos === "over" ? { left: "50%", marginLeft: (-g.sd / 2) * px, bottom: -g.sd * 0.04 * px } : g.pos === "right" ? { right: -6 * px, bottom: -g.sd * 0.2 * px } : { left: mobile ? -8 * px : -15 * px, bottom: -g.sd * 0.2 * px }) }} />}
                {cfg.hmSign ? <img src={cfg.hmSign} alt="" style={{ position: "relative", maxHeight: g.sh * px, maxWidth: 50 * px, objectFit: "contain", mixBlendMode: "multiply" }} />
                  : !cfg.seal && <span style={{ fontSize: 11.5, color: C.sub, alignSelf: "center" }}>Upload a signature or seal to see it here</span>}
              </div>
              <div style={{ borderTop: `1.5px solid ${C.ink}`, paddingTop: 3, fontSize: 12, fontWeight: 700, position: "relative" }}>{hmTitle}{cfg.hmName && <div style={{ fontSize: 11, fontWeight: 600, color: C.sub }}>{cfg.hmName}</div>}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
function LogoCard({ cfg, update }) {
  const [msg, setMsg] = useState(null);
  const [crop, setCrop] = useState(null);
  const onFile = (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    if (!/^image\//.test(f.type)) { setMsg({ ok: false, text: "Please choose an image file (PNG, JPG or WEBP)." }); return; }
    readAsDataUrl(f).then((src) => setCrop(src)).catch((er) => setMsg({ ok: false, text: er.message }));
  };
  const useLogo = (url) => {
    setCrop(null);
    setMsg({ ok: true, text: "Processing the logo…" });
    (async () => {
      try {
        const img = await loadImg(url), box = logoBBox(img);
        const big = logoCanvas(img, box, 480, false, 0);
        let logo = big.toDataURL("image/webp", 0.86);
        if (!/^data:image\/webp/.test(logo)) logo = big.toDataURL("image/png");
        const icon = logoCanvas(img, box, 180, true, 0.08).toDataURL("image/png");
        update((n) => { n.logo = logo; n.logoIcon = icon; });
        setMsg({ ok: true, text: "Logo saved. It now shows in the header, as the browser icon, as a watermark in the app and on every PDF." });
      } catch (er) { setMsg({ ok: false, text: (er && er.message) || "Couldn't use this image." }); }
    })();
  };
  const dlIcons = async () => {
    try {
      const img = await loadImg(cfg.logo), box = { sx: 0, sy: 0, sw: img.naturalWidth, sh: img.naturalHeight };
      downloadCanvas(logoCanvas(img, box, 192, true, 0.08), "icon-192.png");
      setTimeout(() => downloadCanvas(logoCanvas(img, box, 512, true, 0.08), "icon-512.png"), 400);
    } catch (e) { setMsg({ ok: false, text: (e && e.message) || "Couldn't make the icons." }); }
  };
  const chk = { display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 600, color: C.ink, cursor: "pointer" };
  return (
    <div style={{ ...card, marginBottom: 16 }}>
      {crop && <CropModal src={crop} title="school logo" square onDone={useLogo} onCancel={() => setCrop(null)} />}
      <Panelhead text="School logo — header, app icon & watermark" count={cfg.logo ? "uploaded" : "not set"} tone={cfg.logo ? "free" : undefined} />
      <div style={{ padding: 14, display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ width: 112, height: 112, borderRadius: 16, border: `2px dashed ${cfg.logo ? C.primary : C.line}`, background: cfg.logo ? "#fff" : "#f7f9fb", display: "grid", placeItems: "center", padding: 8, flexShrink: 0 }}>
          {cfg.logo ? <img src={cfg.logo} alt="School logo" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /> : <span style={{ fontSize: 12, color: C.sub, textAlign: "center" }}>No logo yet</span>}
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <label className="tt-btn" style={{ ...solidBtn, display: "inline-block" }}>
              {cfg.logo ? "Change logo" : "Upload logo"}
              <input type="file" accept="image/*" onChange={onFile} style={{ display: "none" }} />
            </label>
            {cfg.logo && <button className="tt-btn" onClick={dlIcons} style={ghostBtn}>Download app icons (192 & 512)</button>}
            {cfg.logo && <button className="tt-btn" onClick={() => update((n) => { delete n.logo; delete n.logoIcon; })} style={{ ...ghostBtn, color: C.clash }}>Remove logo</button>}
          </div>
          {cfg.logo && (
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 8 }}>
              <label style={chk}><input type="checkbox" checked={cfg.wmApp !== false} onChange={(e) => update((n) => { n.wmApp = e.target.checked; })} /> Watermark in the app</label>
              <label style={chk}><input type="checkbox" checked={cfg.wmPdf !== false} onChange={(e) => update((n) => { n.wmPdf = e.target.checked; })} /> Watermark on PDFs</label>
            </div>
          )}
          <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.55 }}>PNG with a transparent background looks best. Empty borders are trimmed automatically. The logo is saved with your timetable, so every device sees it. For the installed phone/desktop app icon, put the two downloaded icons in the <b>public</b> folder of the project and redeploy.</div>
          {msg && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, color: msg.ok ? C.free : C.clash }}>{msg.text}</div>}
        </div>
      </div>
    </div>
  );
}

function NavDrawer({ open, onClose, view, setView, TH, school, logo, status = {}, theme, setTheme, onSignOut, only, me }) {
  if (!open) return null;
  return (
    <div onClick={onClose} className="tt-noprint" style={{ position: "fixed", inset: 0, background: "rgba(16,25,40,.45)", zIndex: 90 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: 280, maxWidth: "84%", background: "#fff", boxShadow: "2px 0 24px rgba(0,0,0,.25)", display: "flex", flexDirection: "column", animation: "ttslide .2s ease" }}>
        <div style={{ background: `linear-gradient(115deg, ${TH.g2}, ${TH.g1})`, color: "#fff", padding: "18px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {logo && <div style={{ width: 44, height: 44, borderRadius: 12, background: "#fff", display: "grid", placeItems: "center", padding: 3, marginRight: 10, flexShrink: 0 }}><img src={logo} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /></div>}
          <div style={{ marginRight: "auto" }}>
            <div style={{ fontWeight: 800, fontSize: 15 }}>TIME TABLE</div>
            <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.8)" }}>{school}{me ? ` · signed in as ${me}` : ""}</div>
          </div>
          <button className="tt-btn" onClick={onClose} aria-label="Close" style={{ border: "none", background: "transparent", color: "#fff", fontSize: 24, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ overflowY: "auto", padding: "8px 0", flex: 1 }}>
          {TABS.filter(([k]) => !only || only.includes(k)).map(([k, label]) => {
            const on = view === k, st = status[k] || {}, tn = tabTone(st.tone, TH);
            return (
              <div key={k} onClick={() => { setView(k); onClose(); }} style={{ margin: "3px 10px", padding: "8px 10px", borderRadius: 12, display: "flex", alignItems: "center", gap: 11, cursor: "pointer", border: `2px solid ${on ? TH.accent : "transparent"}`, background: on ? `${TH.accent}10` : "transparent" }}>
                <span style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 10, display: "grid", placeItems: "center", background: on ? `linear-gradient(135deg, ${TH.g1}, ${TH.g2})` : "#f1f4f7", color: on ? "#fff" : TH.accent }}><Icon name={k} size={17} /></span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 14, fontWeight: on ? 800 : 700, color: on ? TH.g2 : C.ink }}>{label}</span>
                  {st.text && <span style={{ display: "inline-block", marginTop: 2, fontSize: 10.5, fontWeight: 700, padding: "1px 8px", borderRadius: 20, background: tn.bg, color: tn.fg }}>{st.text}</span>}
                </span>
              </div>
            );
          })}
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
          <div style={{ fontSize: 11, color: C.sub, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>Theme <span style={{ float: "right", textTransform: "none", fontWeight: 600 }}>version {APP_VERSION}</span></div>
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
                    : r.t ? (<><div style={{ fontFamily: mono, fontWeight: 700, fontSize: 12.5, color: C.ink, whiteSpace: "normal", wordBreak: "break-word", overflowWrap: "anywhere", lineHeight: 1.3 }}>{r.t}</div><div style={{ fontSize: 10.5, color: bar || C.sub, marginTop: 2, fontWeight: 600, letterSpacing: 0.2 }}>{r.s}</div></>)
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
      <ViewHeader title="Free teachers & substitution" note="Pick a slot to see who can cover it" right={<><PrintBtn onClick={() => exportSubChartPDF(cfg, { paper: "A3" })} icon="pdf" label="Substitution chart" sub="A3 · whole week" /><PrintBtn onClick={() => exportFreeDailyPDF(cfg, { paper: "A4", day: fday })} icon="pdf" light label="Today's sheet" sub={`A4 · ${DAY_FULL[fday] || ""}`} /></>} />
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

/* ---------------- mapping & teacher load ---------------- */
function parseBKeyRows(arr) {
  const clean = (arr || []).filter((r) => r && r.some((x) => String(x == null ? "" : x).trim() !== ""));
  if (!clean.length) return [];
  const cell = (r, k) => String((k >= 0 && r[k] != null) ? r[k] : "").trim();
  const hdr = clean[0].map((x) => String(x == null ? "" : x).trim().toLowerCase());
  let ci = hdr.indexOf("class"), di = hdr.indexOf("division"), si = hdr.indexOf("subject"), ti = hdr.indexOf("teacher");
  let start = 0;
  const hasHeader = ci >= 0 || si >= 0 || ti >= 0 || di >= 0;
  if (hasHeader) {
    start = 1;
    if (ci < 0) ci = 0;
    if (si < 0) si = di >= 0 ? 2 : 1;
    if (ti < 0) ti = di >= 0 ? 3 : 2;
  } else {
    // positional: column 1 = Class (with division), 2 = Subject, 3 = Teacher
    ci = 0; si = 1; ti = 2; di = -1;
  }
  const out = [];
  for (let i = start; i < clean.length; i++) {
    const r = clean[i];
    let cls = cell(r, ci);
    if (di >= 0) { const dv = cell(r, di); if (dv) cls = (cls + " " + dv).trim(); }
    const sub = cell(r, si).toUpperCase();
    const teacher = cell(r, ti);
    if (cls && sub) out.push({ cls, sub, teacher });
  }
  return out;
}

function SearchSelect({ value, options, onChange, placeholder, allowEmpty }) {
  const [txt, setTxt] = useState(value || "");
  const idRef = useRef("ss" + Math.random().toString(36).slice(2));
  useEffect(() => { setTxt(value || ""); }, [value]);
  const norm = (x) => String(x || "").toLowerCase().replace(/\s+/g, "");
  const find = (v) => options.find((o) => norm(o) === norm(v));
  const commit = (v) => {
    const m = find(v);
    if (m) { if (m !== value) onChange(m); setTxt(m); }
    else if (allowEmpty && String(v || "").trim() === "") { if (value) onChange(""); setTxt(""); }
    else setTxt(value || "");
  };
  return (
    <>
      <input className="tt-in" list={idRef.current} value={txt} placeholder={placeholder || "Type to search…"}
        onFocus={(e) => e.target.select()}
        onChange={(e) => { setTxt(e.target.value); const m = options.find((o) => o === e.target.value); if (m && m !== value) onChange(m); }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { commit(e.currentTarget.value); e.currentTarget.blur(); } }}
        style={{ width: "100%", fontFamily: mono, fontWeight: 700 }} />
      <datalist id={idRef.current}>{options.map((o) => <option key={o} value={o} />)}</datalist>
    </>
  );
}

function MapTabs({ cfg, section, setSection, teacherLoad, mobile }) {
  const stds = standardsOf(cfg);
  const emptyStd = stds.filter((st) => !Object.values(cfg.stdPeriods?.[st] || {}).some((v) => Number(v) > 0));
  const cov = combCover(cfg);
  const done = cfg.classes.filter((c) => { const rows = cfg.bkey[c] || []; return rows.length > 0 && rows.every((r) => r.sub && (r.teacher || (cov[c + "|" + r.sub] || 0) >= periodsFor(cfg, c, r.sub))); }).length;
  const over = cfg.singles.filter((t) => ((teacherLoad[t] || {}).target || 0) > teacherCap(cfg, t)).length;
  const tabs = [
    { k: "std", n: 1, icon: "▤", title: "Standard periods", hint: "Subjects & weekly periods per standard", status: emptyStd.length ? `${emptyStd.length} standard${emptyStd.length > 1 ? "s" : ""} empty` : `${stds.length} standard${stds.length === 1 ? "" : "s"} ready`, ok: !emptyStd.length },
    { k: "class", n: 2, icon: "⇄", title: "Class mapping", hint: "Teacher for each subject of a class", status: `${done} / ${cfg.classes.length} classes complete`, ok: done === cfg.classes.length },
    { k: "load", n: 3, icon: "◔", title: "Teacher load", hint: "Weekly periods of every teacher", status: over ? `${over} over capacity` : "all within limits", ok: !over },
  ];
  return (
    <div role="tablist" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: mobile ? 6 : 12, marginBottom: 18 }}>
      {tabs.map((t) => {
        const on = section === t.k;
        return (
          <button key={t.k} role="tab" aria-selected={on} className="tt-btn" onClick={() => setSection(t.k)}
            style={{ textAlign: "left", cursor: "pointer", borderRadius: 14, padding: mobile ? "10px 9px" : "14px 16px", border: `2px solid ${on ? C.primary : C.line}`, background: on ? C.primarySoft : "#fff", boxShadow: on ? "0 6px 18px rgba(14,107,115,.16)" : "0 1px 2px rgba(16,24,40,.04)", display: "flex", gap: mobile ? 8 : 12, alignItems: "center", transition: "all .15s" }}>
            <span style={{ flexShrink: 0, width: mobile ? 30 : 40, height: mobile ? 30 : 40, borderRadius: 11, display: "grid", placeItems: "center", fontSize: mobile ? 15 : 19, fontWeight: 800, background: on ? C.primary : "#f1f4f7", color: on ? "#fff" : C.primary }}>{t.icon}</span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 10.5, fontWeight: 700, color: on ? C.primary : C.sub, letterSpacing: 0.5 }}>STEP {t.n}</span>
              <span style={{ display: "block", fontSize: mobile ? 12.5 : 14.5, fontWeight: 800, color: C.ink, lineHeight: 1.25 }}>{t.title}</span>
              {!mobile && <span style={{ display: "block", fontSize: 11.5, color: C.sub, marginTop: 1 }}>{t.hint}</span>}
              <span style={{ display: "inline-block", marginTop: 5, fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: t.ok ? C.freeSoft : C.warnSoft, color: t.ok ? C.free : C.warn }}>{t.status}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function BKeyView({ cfg, cls, setCls, update, expand, teacherLoad, mobile, ask, askPw }) {
  const rows = cfg.bkey[cls] || [];
  const [section, setSection] = useState(() => lsGet("tt_mapsec", "class"));
  useEffect(() => { lsSet("tt_mapsec", section); }, [section]);
  const [saveMsg, setSaveMsg] = useState(null);
  const [classMsg, setClassMsg] = useState(null);
  useEffect(() => { setClassMsg(null); }, [cls]);
  const saveClass = () => {
    const r = cfg.bkey[cls] || [];
    const st = stdOf(cls);
    const covS = combCover(cfg);
    const noT = r.filter((x) => !x.teacher && (covS[cls + "|" + x.sub] || 0) < periodsFor(cfg, cls, x.sub)).map((x) => x.sub);
    const noP = r.filter((x) => x.sub && !periodsFor(cfg, cls, x.sub)).map((x) => x.sub);
    const have = new Set(r.map((x) => x.sub));
    const missing = Object.keys(cfg.stdPeriods?.[st] || {}).filter((su) => Number(cfg.stdPeriods[st][su]) > 0 && !have.has(su));
    update((n) => { n.savedAt = new Date().toISOString(); });
    const warn = [];
    if (!r.length) warn.push("no subjects mapped yet");
    if (noT.length) warn.push("no teacher for " + noT.join(", "));
    if (noP.length) warn.push("0 periods for " + noP.join(", ") + " in Standard " + st);
    if (missing.length) warn.push("Standard " + st + " subjects not added: " + missing.join(", "));
    if (!cfg.classTeacher[cls]) warn.push("no class teacher set");
    const others = cfg.classes.filter((c) => c !== cls && (!(cfg.bkey[c] || []).length || (cfg.bkey[c] || []).some((x) => !x.teacher))).length;
    const tail = others ? ` (${others} other class${others > 1 ? "es are" : " is"} still incomplete.)` : "";
    setClassMsg(warn.length
      ? { tone: "warn", text: `Saved ${cls} — not complete yet: ${warn.join("; ")}. You can finish it later.${tail}` }
      : { tone: "primary", text: `Saved ${cls}. This class is fully mapped.${tail}` });
  };
  const saveMapping = () => {
    const noMap = cfg.classes.filter((c) => !(cfg.bkey[c] || []).length);
    const noTeacher = [], noPer = [];
    const covA = combCover(cfg);
    for (const c of cfg.classes) for (const r of (cfg.bkey[c] || [])) { if (!r.teacher && (covA[c + "|" + r.sub] || 0) < periodsFor(cfg, c, r.sub)) noTeacher.push(c + " " + r.sub); if (!periodsFor(cfg, c, r.sub)) noPer.push(c + " " + r.sub); }
    const noStdSubs = standardsOf(cfg).filter((st) => !Object.values(cfg.stdPeriods?.[st] || {}).some((v) => Number(v) > 0)).map((st) => "Std " + st);
    const noCT = cfg.classes.filter((c) => !cfg.classTeacher[c]);
    update((n) => { n.savedAt = new Date().toISOString(); });
    setSaveMsg({ noMap, noTeacher, noPer, noStdSubs, noCT });
  };
  const fileRef = useRef(null);
  const [imp, setImp] = useState("");
  const onImport = async (file) => {
    if (!file) return;
    setImp("");
    try {
      if (/\.xlsx?$/i.test(file.name)) { setImp("Please save your Excel sheet as CSV (columns: Class, Subject, Teacher) and upload that."); return; }
      const data = (await file.text()).split(/\r?\n/).map((l) => l.split(","));
      const parsed = parseBKeyRows(data);
      if (!parsed.length) { setImp("No rows found. Use columns: Class, Subject, Teacher."); return; }
      update((n) => {
        const byClass = {};
        for (const r of parsed) {
          const teacher = r.teacher || (n.singles[0] || "");
          (byClass[r.cls] ||= []).push({ sub: r.sub, teacher });
          if (!n.classes.includes(r.cls)) { n.classes.push(r.cls); n.classTeacher[r.cls] = null; n.grid[r.cls] = {}; n.days.forEach((d) => (n.grid[r.cls][d] = emptyDay(n.periods.length))); }
          const st = stdOf(r.cls); if (!n.stdPeriods[st]) n.stdPeriods[st] = {};
          if (r.sub && !n.subjects.includes(r.sub)) n.subjects.push(r.sub);
          if (teacher && teacher.indexOf(" ") < 0 && !n.singles.includes(teacher)) n.singles.push(teacher);
        }
        for (const c in byClass) n.bkey[c] = byClass[c];
        n.singles.sort();
      });
      setImp(`Imported ${parsed.length} mapping row(s) across ${new Set(parsed.map((r) => r.cls)).size} class(es). Set each standard's periods in the table above.`);
    } catch (e) {
      setImp("Couldn't read that file. A CSV with columns Class, Subject, Teacher always works. (Excel .xlsx works on the deployed app.)");
    }
  };
  const std = stdOf(cls);
  const totalKeyed = rows.reduce((a, r) => a + periodsFor(cfg, cls, r.sub), 0);
  const weekSlots = cfg.days.length * classPeriods(cfg, cls);
  const combinedNames = (cfg.combined || []).map((s) => s.name);
  const covM = combCover(cfg);
  useEffect(() => {
    const existing = cfg.bkey[cls];
    if (existing) return; // only auto-load for brand-new classes; an explicit Clear leaves an empty array
    const st = stdOf(cls);
    const withPer = Object.keys(cfg.stdPeriods?.[st] || {}).filter((su) => cfg.subjects.includes(su) && Number(cfg.stdPeriods[st][su]) > 0);
    if (!withPer.length) return;
    update((n) => { n.bkey[cls] = withPer.map((su) => ({ sub: su, teacher: "" })); });
  }, [cls]);

  const setRow = (i, field, val) => update((n) => { n.bkey[cls][i][field] = val; });
  const addRow = () => update((n) => { (n.bkey[cls] ||= []).push({ sub: cfg.subjects[0], teacher: "" }); });
  const delRow = (i) => update((n) => { n.bkey[cls].splice(i, 1); });
  const setCT = (v) => update((n) => { n.classTeacher[cls] = v; });
  const subsForStd = (n, c) => { const st = stdOf(c); const ks = Object.keys(n.stdPeriods?.[st] || {}).filter((su) => n.subjects.includes(su) && Number(n.stdPeriods[st][su]) > 0); return ks.length ? ks : n.subjects; };
  const autofillAll = () => { update((n) => { for (const c of n.classes) { const have = new Set((n.bkey[c] || []).map((r) => r.sub)); (n.bkey[c] || (n.bkey[c] = [])); for (const su of subsForStd(n, c)) if (!have.has(su)) n.bkey[c].push({ sub: su, teacher: "" }); } }); setImp("Added each standard’s subjects to every class. Now assign a teacher to each row (blank rows are skipped until you do)."); };
  const fillClassSubs = () => { update((n) => { const have = new Set((n.bkey[cls] || []).map((r) => r.sub)); (n.bkey[cls] || (n.bkey[cls] = [])); for (const su of subsForStd(n, cls)) if (!have.has(su)) n.bkey[cls].push({ sub: su, teacher: "" }); }); };
  const clearThisClass = () => ask(`Clear all mapping (subjects + teachers) for ${cls}?`, () => update((n) => { n.bkey[cls] = []; }));
  const clearAllMapping = () => askPw("Clear the mapping (subjects + teachers) AND combined subjects for EVERY class? Standard periods, classes and the teacher list are kept.", () => update((n) => { for (const c of n.classes) n.bkey[c] = []; n.combined = []; }));
  const [copyTargets, setCopyTargets] = useState([]);
  const [showPaste, setShowPaste] = useState(false);
  const [search, setSearch] = useState("");
  const [pasteSub, setPasteSub] = useState("");
  const [pasteTea, setPasteTea] = useState("");
  const splitCol = (txt) => txt.split(/\r?\n/).map((l) => l.replace(/\t.*$/, "").trim());
  const applyPaste = () => {
    // Paste a Subjects column and a Teachers column straight from Excel/Sheets; rows align top-to-bottom.
    // If the Subjects box itself has two tab/comma columns, use those and ignore the Teachers box.
    let subCells = pasteSub.split(/\r?\n/).map((l) => l.trim()).filter((l, i, a) => l !== "" || i < a.length - 1);
    let teaCol = pasteTea.split(/\r?\n/).map((l) => l.trim());
    const twoCol = subCells.some((l) => /[,\t]/.test(l));
    const rows = [];
    for (let i = 0; i < subCells.length; i++) {
      let sub = subCells[i], teacher = teaCol[i] || "";
      if (twoCol) { const p = subCells[i].split(/[,\t]/); sub = (p[0] || "").trim(); teacher = (p[1] || "").trim(); }
      sub = sub.trim().toUpperCase();
      if (sub) rows.push({ sub: sub, teacher: (teacher || "").trim() });
    }
    if (!rows.length) return;
    update((n) => { n.bkey[cls] = rows; for (const r of rows) { if (r.sub && !n.subjects.includes(r.sub)) n.subjects.push(r.sub); if (r.teacher && r.teacher.indexOf(" ") < 0 && !n.singles.includes(r.teacher)) n.singles.push(r.teacher); } n.singles.sort(); });
    setImp("Applied pasted mapping to " + cls + " (" + rows.length + " rows).");
  };
  const toggleTarget = (v) => setCopyTargets((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));
  const doCopy = () => { if (!copyTargets.length) return; ask(`Copy ${cls}'s full mapping (subjects + teachers) to ${copyTargets.length} class(es)? Their current mapping is replaced.`, () => { update((n) => { const src = JSON.stringify(n.bkey[cls] || []); for (const t of copyTargets) n.bkey[t] = JSON.parse(src); }); setImp(`Copied ${cls}'s mapping to: ${copyTargets.join(", ")}.`); setCopyTargets([]); }); };

  return (
    <div>
      <ViewHeader title={section === "std" ? "Mapping · Standard periods" : section === "load" ? "Mapping · Teacher load" : `Mapping · Class ${cls}`} note={section === "std" ? "Step 1 — give each standard its own subjects and weekly periods." : section === "load" ? "Step 3 — check every teacher’s weekly load from the mapping before generating." : `Step 2 — assign a teacher to each subject of ${cls}. Periods come from Standard ${std}.`} right={<>
        <button className="tt-btn" onClick={autofillAll} style={ghostBtn}>Auto-fill subjects · all classes</button>
        <button className="tt-btn" onClick={clearAllMapping} style={{ ...ghostBtn, color: C.clash }}>Clear all mapping</button>
        <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={(e) => onImport(e.target.files && e.target.files[0])} style={{ display: "none" }} />
        <button className="tt-btn" onClick={() => fileRef.current && fileRef.current.click()} style={ghostBtn}>Import CSV / Excel</button>
      </>} />
      {imp && <Banner tone="primary">{imp}</Banner>}
      <MapTabs cfg={cfg} section={section} setSection={setSection} teacherLoad={teacherLoad} mobile={mobile} />

      {section === "std" && <StandardPeriods cfg={cfg} update={update} highlightStd={std} mobile={mobile} ask={ask} />}
      {section === "load" && <TeacherLoadSection cfg={cfg} teacherLoad={teacherLoad} />}

      {section === "class" && <>
      <div style={{ ...card, padding: "10px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", overflow: "visible" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.sub }}>Find class:</span>
        <div style={{ width: 160 }}><SearchSelect value={cls} options={cfg.classes} onChange={(v) => setCls && setCls(v)} placeholder="Type a class, e.g. 6 B" /></div>
        <span style={{ fontSize: 12, color: C.sub }}>Editing <b style={{ fontFamily: mono, color: C.primary }}>{cls}</b> · Standard {std}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr)", gap: 16, alignItems: "start", maxWidth: 900 }}>
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderBottom: `1px solid ${C.line}`, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Subject → teacher · {cls}</span>
            <label style={{ fontSize: 12, color: C.sub, marginLeft: "auto" }}>Class teacher:&nbsp;
              <select className="tt-sel" style={{ width: 120, display: "inline-block" }} value={cfg.classTeacher[cls] || ""} onChange={(e) => setCT(e.target.value)}>
                <option value="">—</option>{cfg.singles.filter((t) => t === cfg.classTeacher[cls] || !Object.values(cfg.classTeacher).includes(t)).map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <button className="tt-btn" onClick={() => setShowPaste((v) => !v)} style={{ ...ghostBtn, padding: "5px 11px" }}>{showPaste ? "Hide paste" : "Paste from Excel"}</button>
          </div>
          <div style={{ padding: "8px 14px", borderBottom: `1px solid ${C.line}` }}>
            <input className="tt-in" style={{ width: "100%", maxWidth: 340, fontSize: 13, padding: "8px 10px" }} placeholder="Search subject or teacher in this class…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <table style={tbl}>
            <thead><tr><th style={{ ...th, textAlign: "left", paddingLeft: 12 }}>Subject</th><th style={{ ...th, textAlign: "left" }}>Teacher</th><th style={{ ...th, width: 62 }}>Periods</th><th style={{ ...th, width: 40 }}></th></tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const q = search.trim().toLowerCase();
                if (q && !(((r.sub || "") + " " + (r.teacher || "")).toLowerCase().includes(q))) return null;
                return (
                <tr key={i}>
                  <td style={{ ...cellTd, height: 40, padding: 5 }}>
                    <SearchSelect value={r.sub} options={cfg.subjects} onChange={(v) => setRow(i, "sub", v)} placeholder="Search subject…" />
                  </td>
                  <td style={{ ...cellTd, height: 40, padding: 5 }}>
                    <SearchSelect value={r.teacher} options={[...cfg.singles, ...combinedNames]} allowEmpty onChange={(v) => setRow(i, "teacher", v)} placeholder="Search teacher…" />
                  </td>
                  <td style={{ ...cellTd, height: 40 }}>
                    <span style={{ fontFamily: mono, fontWeight: 700, fontSize: 13, color: periodsFor(cfg, cls, r.sub) ? C.primary : C.clash }} title="Set in the Standard periods table above">{periodsFor(cfg, cls, r.sub)}</span>
                    {covM[cls + "|" + r.sub] > 0 && !combinedNames.includes(r.teacher) && <div title="Periods taught in a combined session" style={{ fontSize: 9.5, color: C.accent, fontWeight: 700 }}>{Math.min(covM[cls + "|" + r.sub], periodsFor(cfg, cls, r.sub))} comb.</div>}
                  </td>
                  <td style={{ ...cellTd, height: 40, padding: 5 }}>
                    <button className="tt-btn" onClick={() => delRow(i)} title="Remove" style={{ border: "none", background: "transparent", color: C.clash, fontSize: 16, cursor: "pointer" }}>×</button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", gap: 12, flexWrap: "wrap" }}>
            <button className="tt-btn" onClick={saveClass} style={solidBtn}>Save {cls}</button>
            <button className="tt-btn" onClick={addRow} style={ghostBtn}>+ Add subject</button>
            <button className="tt-btn" onClick={fillClassSubs} style={ghostBtn}>Fill from standard subjects</button>
            <button className="tt-btn" onClick={clearThisClass} style={{ ...ghostBtn, color: C.clash }}>Clear this class</button>
            <span style={{ fontSize: 12.5, color: totalKeyed > weekSlots ? C.clash : C.sub, marginLeft: "auto" }}>
              {totalKeyed} periods keyed of {weekSlots} weekly slots{totalKeyed > weekSlots ? " · over capacity" : ""}
            </span>
          </div>
          {classMsg && <div style={{ margin: "0 14px 12px", padding: "9px 12px", borderRadius: 9, fontSize: 12.5, lineHeight: 1.55, fontWeight: 500, background: classMsg.tone === "warn" ? C.warnSoft : C.primarySoft, color: classMsg.tone === "warn" ? C.warn : C.primary, border: `1px solid ${classMsg.tone === "warn" ? C.warn : C.primary}33`, display: "flex", gap: 8 }}>
            <span style={{ flex: 1 }}>{classMsg.tone === "warn" ? "⚠ " : "✓ "}{classMsg.text}</span>
            <button className="tt-btn" onClick={() => setClassMsg(null)} style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 16, lineHeight: 1 }}>×</button>
          </div>}
          {showPaste && <div style={{ borderTop: `1px solid ${C.line}`, padding: 12 }}>
            <div style={{ fontSize: 11.5, color: C.sub, fontWeight: 700, marginBottom: 6 }}>Paste from Excel / Sheets for {cls} — copy the Subjects column into the left box and the Teachers column into the right box (rows line up top to bottom). This replaces the rows for the class.</div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10.5, color: C.sub, fontWeight: 700, marginBottom: 3 }}>SUBJECTS</div>
                <textarea className="tt-in" style={{ width: "100%", minHeight: 120, fontFamily: mono, resize: "vertical" }} value={pasteSub} onChange={(e) => setPasteSub(e.target.value)} placeholder={"MAT\nENG\nSS"} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10.5, color: C.sub, fontWeight: 700, marginBottom: 3 }}>TEACHERS</div>
                <textarea className="tt-in" style={{ width: "100%", minHeight: 120, fontFamily: mono, resize: "vertical" }} value={pasteTea} onChange={(e) => setPasteTea(e.target.value)} placeholder={"KPM\nDN\nMPS"} />
              </div>
            </div>
            <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
              <button className="tt-btn" onClick={applyPaste} style={solidBtn}>Apply paste to {cls}</button>
              <span style={{ fontSize: 11.5, color: C.sub }}>Tip: you can also paste both columns together into the Subjects box (tab or comma separated).</span>
            </div>
          </div>}
        </div>
      </div>

      <div style={{ ...card, marginTop: 16 }}>
        <Panelhead text={`Copy ${cls}'s mapping to other classes`} />
        <div style={{ padding: 14 }}>
          <ChipPicker label="Copy to" all={cfg.classes.filter((c) => c !== cls)} selected={copyTargets} onToggle={toggleTarget} onSetAll={(a) => setCopyTargets(a.filter((c) => c !== cls))} />
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button className="tt-btn" onClick={() => setCopyTargets(cfg.classes.filter((c) => c !== cls && stdOf(c) === std))} style={ghostBtn}>Select all Std {std}</button>
            <button className="tt-btn" onClick={doCopy} style={solidBtn}>Copy to selected ({copyTargets.length})</button>
          </div>
          <div className="tt-callout" style={{ marginTop: 10 }}>Set one class fully (subjects + teachers), then copy it to the classes that share the same setup and tweak only what differs. Copying replaces the target classes' mapping.</div>
        </div>
      </div>
      </>}
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

function StandardPeriods({ cfg, update, highlightStd, mobile, ask }) {
  const stds = standardsOf(cfg);
  const cap = cfg.days.length * cfg.periods.length;
  const setP = (s, sub, val) => update((n) => { (n.stdPeriods[s] || (n.stdPeriods[s] = {}))[sub] = Math.max(0, +val || 0); });
  const removeSub = (s, sub) => update((n) => { if (n.stdPeriods[s]) delete n.stdPeriods[s][sub]; });
  const addSub = (s, sub) => update((n) => { (n.stdPeriods[s] || (n.stdPeriods[s] = {})); if (!(Number(n.stdPeriods[s][sub]) > 0)) n.stdPeriods[s][sub] = 5; });
  const moveSub = (s, sub, dir) => update((n) => { const keys = Object.keys(n.stdPeriods[s] || {}); const i = keys.indexOf(sub); const j = i + dir; if (i < 0 || j < 0 || j >= keys.length) return; const tmp = keys[i]; keys[i] = keys[j]; keys[j] = tmp; const re = {}; for (const k of keys) re[k] = n.stdPeriods[s][k]; n.stdPeriods[s] = re; });
  const copyStd = (from, to) => { if (!to || to === from) return; ask("Copy Standard " + from + "'s subjects and periods to Standard " + to + "? It replaces Standard " + to + "'s current subjects.", () => update((n) => { n.stdPeriods[to] = JSON.parse(JSON.stringify(n.stdPeriods[from] || {})); })); };
  return (
    <div style={card}>
      <Panelhead text="Standard periods  -  each standard has its own subjects & weekly periods" />
      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "repeat(auto-fill, minmax(230px, 1fr))", gap: 12, padding: 14 }}>
        {stds.map((s) => {
          const subs = Object.keys(cfg.stdPeriods?.[s] || {}).filter((su) => cfg.subjects.includes(su) && Number(cfg.stdPeriods[s][su]) > 0);
          const missing = cfg.subjects.filter((su) => !(Number(cfg.stdPeriods?.[s]?.[su]) > 0));
          const total = subs.reduce((a, su) => a + Number(cfg.stdPeriods[s][su] || 0), 0);
          return (
            <div key={s} style={{ border: `1px solid ${s === highlightStd ? C.primary : C.line}`, borderRadius: 12, overflow: "hidden", background: "#fff" }}>
              <div style={{ padding: "9px 12px", background: s === highlightStd ? C.primarySoft : "#f7f9fb", fontWeight: 800, color: C.primary, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Standard {s}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <select className="tt-sel" title="Copy these subjects to another standard" value="" onChange={(e) => copyStd(s, e.target.value)} style={{ width: 78, fontSize: 10.5, padding: "2px 4px" }}>
                    <option value="">copy to…</option>{stds.filter((x) => x !== s).map((x) => <option key={x} value={x}>Std {x}</option>)}
                  </select>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: total > cap ? C.clash : C.sub }}>{total}/{cap}</span>
                </span>
              </div>
              <div style={{ padding: 10, display: "grid", gap: 6 }}>
                {subs.length === 0 && <div style={{ fontSize: 12, color: C.sub, padding: "4px 2px" }}>No subjects yet  -  add below.</div>}
                {subs.map((su) => (
                  <div key={su} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: SUBJECT_BAR[su] || C.sub, flexShrink: 0 }} />
                    <span style={{ fontFamily: mono, fontWeight: 700, flex: 1 }}>{su}</span>
                    <NumInput value={cfg.stdPeriods[s][su]} onCommit={(v) => setP(s, su, v)} />
                    <button className="tt-btn" onClick={() => moveSub(s, su, -1)} title="Move up" style={{ border: "none", background: "transparent", color: C.sub, cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0 }}>▲</button>
                    <button className="tt-btn" onClick={() => moveSub(s, su, 1)} title="Move down" style={{ border: "none", background: "transparent", color: C.sub, cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0 }}>▼</button>
                    <button className="tt-btn" onClick={() => removeSub(s, su)} title="Remove from this standard" style={{ border: "none", background: "transparent", color: C.clash, cursor: "pointer", fontSize: 15, lineHeight: 1 }}>×</button>
                  </div>
                ))}
                {missing.length > 0 && (
                  <select className="tt-sel" value="" onChange={(e) => { if (e.target.value) addSub(s, e.target.value); }} style={{ marginTop: 2 }}>
                    <option value="">+ add subject...</option>
                    {missing.map((su) => <option key={su} value={su}>{su}</option>)}
                  </select>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="tt-callout" style={{ margin: "0 14px 14px" }}>Standards don't have to match  -  give each its own subjects and periods. Remove a subject with ×, add one from the dropdown. "Auto-fill subjects" uses each standard's own list. New standards appear here automatically when you add their classes in Setup.</div>
    </div>
  );
}

function TeacherLoadSection({ cfg, teacherLoad }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("code");
  const [filt, setFilt] = useState("all");
  const [open, setOpen] = useState(null);
  const cap = cfg.days.length * cfg.periods.length;
  const combNames = new Set((cfg.combined || []).map((x) => x.name));
  const detail = {};
  cfg.singles.forEach((t) => (detail[t] = []));
  const cov = combCover(cfg);
  for (const c of cfg.classes) for (const r of (cfg.bkey[c] || [])) {
    if (!r.teacher || combNames.has(r.teacher)) continue;
    const own = Math.max(0, periodsFor(cfg, c, r.sub) - (cov[c + "|" + r.sub] || 0)); if (!own) continue;
    for (const tk of String(r.teacher).split(" ")) if (detail[tk]) detail[tk].push({ c, divs: [c], sub: r.sub, per: own });
  }
  for (const g of Object.values(combGroups(cfg))) {
    for (const tk of g.teachers) if (detail[tk]) { const mine = [...new Set(g.sessions.filter((x) => x.teachers.includes(tk)).flatMap((x) => x.divisions))].sort(cmpClass); const divs = mine.join(", "); detail[tk].push({ c: divs, divs: mine, sub: `${g.sub} (combined “${g.name}”, ${g.sessions.length} session${g.sessions.length > 1 ? "s" : ""})`, per: g.need }); }
  }
  let list = cfg.singles.map((t) => {
    const L = teacherLoad[t] || { target: 0, placed: 0 };
    const classes = new Set(detail[t].flatMap((d) => d.divs || [d.c])).size;
    const capT = teacherCap(cfg, t);
    return { t, target: L.target || 0, placed: L.placed || 0, free: capT - (L.target || 0), classes, capT };
  });
  const qq = q.trim().toLowerCase();
  if (qq) list = list.filter((x) => x.t.toLowerCase().includes(qq) || detail[x.t].some((d) => (d.c + " " + d.sub).toLowerCase().includes(qq)));
  if (filt === "over") list = list.filter((x) => x.target > x.capT);
  else if (filt === "none") list = list.filter((x) => x.target === 0);
  else if (filt === "incomplete") list = list.filter((x) => x.placed !== x.target);
  if (sort === "target") list.sort((a, b) => b.target - a.target);
  else if (sort === "free") list.sort((a, b) => a.free - b.free);
  else if (sort === "remaining") list.sort((a, b) => (b.target - b.placed) - (a.target - a.placed));
  const all = cfg.singles.map((t) => (teacherLoad[t] || { target: 0 }).target || 0);
  const totalTarget = all.reduce((a, b) => a + b, 0);
  const overN = cfg.singles.filter((t) => ((teacherLoad[t] || {}).target || 0) > teacherCap(cfg, t)).length;
  const zeroN = all.filter((v) => v === 0).length;
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
        <Stat label="Teachers" value={cfg.singles.length} />
        <Stat label="Periods mapped (total)" value={totalTarget} />
        <Stat label="Max per teacher / week" value={cap} />
        <Stat label="Over capacity" value={overN} tone={overN ? "bad" : "good"} />
        <Stat label="No periods mapped" value={zeroN} tone={zeroN ? "warn" : "good"} />
      </div>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 14px", borderBottom: `1px solid ${C.line}`, flexWrap: "wrap" }}>
          <input className="tt-in" style={{ width: 220, fontSize: 13, padding: "7px 9px" }} placeholder="Search teacher, class or subject…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="tt-sel" style={{ width: 170 }} value={filt} onChange={(e) => setFilt(e.target.value)}>
            <option value="all">Show: all teachers</option><option value="over">Show: over capacity</option><option value="none">Show: no periods mapped</option><option value="incomplete">Show: not fully placed</option>
          </select>
          <select className="tt-sel" style={{ width: 150, marginLeft: "auto" }} value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="code">Sort: name</option><option value="target">Sort: most periods</option><option value="free">Sort: least free</option><option value="remaining">Sort: most left to place</option>
          </select>
        </div>
        <div className="tt-scroll" style={{ overflowX: "auto" }}>
          <table style={{ ...tbl, minWidth: 640 }}>
            <thead><tr>
              <th style={{ ...th, textAlign: "left", paddingLeft: 12, width: 110 }}>Teacher</th>
              <th style={{ ...th, width: 66 }}>Classes</th>
              <th style={{ ...th, width: 76 }}>Mapped</th>
              <th style={{ ...th, width: 66 }}>Free</th>
              <th style={th}>Load (of their week)</th>
              <th style={{ ...th, width: 66 }}>Placed</th>
              <th style={{ ...th, width: 100 }}>Status</th>
            </tr></thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={7} style={{ ...cellTd, color: C.sub, height: 44 }}>No teachers match.</td></tr>}
              {list.map((x) => {
                const over = x.target > x.capT;
                const pct = x.capT ? Math.min(100, Math.round((x.target / x.capT) * 100)) : 0;
                const barCol = over ? C.clash : pct >= 85 ? C.warn : C.primary;
                const rem = x.target - x.placed;
                const st = x.target === 0 ? ["not mapped", C.sub, "#f1f3f6"] : over ? [`over by ${x.target - x.capT}`, C.clash, C.clashSoft] : x.placed > x.target ? [`placed +${x.placed - x.target}`, C.clash, C.clashSoft] : rem === 0 ? ["complete", C.free, C.freeSoft] : [`${rem} to place`, C.warn, C.warnSoft];
                const isOpen = open === x.t;
                return (
                  <React.Fragment key={x.t}>
                    <tr onClick={() => setOpen(isOpen ? null : x.t)} style={{ cursor: "pointer", background: isOpen ? C.primarySoft : "transparent" }}>
                      <td style={{ ...cellTd, textAlign: "left", paddingLeft: 12, fontFamily: mono, fontWeight: 800, height: 38 }}>{isOpen ? "▾ " : "▸ "}{x.t}</td>
                      <td style={{ ...cellTd, height: 38, fontFamily: mono }}>{x.classes}</td>
                      <td style={{ ...cellTd, height: 38, fontFamily: mono, fontWeight: 700 }}>{x.target}</td>
                      <td style={{ ...cellTd, height: 38, fontFamily: mono, color: x.free < 0 ? C.clash : C.ink }}>{x.free}</td>
                      <td style={{ ...cellTd, height: 38 }}>
                        <div style={{ height: 9, background: "#edf0f4", borderRadius: 6, overflow: "hidden" }}><div style={{ width: pct + "%", height: "100%", background: barCol }} /></div>
                      </td>
                      <td style={{ ...cellTd, height: 38, fontFamily: mono }}>{x.placed}</td>
                      <td style={{ ...cellTd, height: 38 }}><span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: st[2], color: st[1], whiteSpace: "nowrap" }}>{st[0]}</span></td>
                    </tr>
                    {isOpen && (
                      <tr><td colSpan={7} style={{ ...cellTd, textAlign: "left", padding: "10px 14px", background: "#fafbfc" }}>
                        {detail[x.t].length === 0 ? <span style={{ color: C.sub, fontSize: 12.5 }}>Not mapped to any class yet.</span> : (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {detail[x.t].map((d, k) => (
                              <span key={k} style={{ fontSize: 12, padding: "4px 9px", borderRadius: 8, background: "#fff", border: `1px solid ${C.line}`, borderLeft: `4px solid ${SUBJECT_BAR[d.sub] || C.primary}` }}>
                                <b style={{ fontFamily: mono }}>{d.c}</b> · {d.sub} · <b>{d.per}</b>
                              </span>
                            ))}
                          </div>
                        )}
                      </td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="tt-note">Mapped = weekly periods this teacher is given in the mapping (combined subjects counted once). Free = periods left in that teacher’s week (their working days × periods) after that. Placed = periods actually in the generated timetable. Tap a teacher to see their classes.</div>
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

/* ---------------- Assign timetable (mapping constrained) ---------------- */
/* ---------------- Timetable versions (different patterns) ---------------- */
function versionStats(cfg, grid) {
  const cm = {}; (cfg.combined || []).forEach((x) => (cm[x.name] = x));
  const toks = (code) => (!code ? [] : cm[code] ? cm[code].teachers : String(code).split(" "));
  let filled = 0, total = 0, ctP1 = 0, doubles = 0;
  const busy = {};
  for (const c of cfg.classes) {
    const lim = classPeriods(cfg, c);
    for (const d of cfg.days) {
      const row = grid[c]?.[d] || []; const seen = {};
      for (let p = 0; p < lim; p++) {
        total++; const sl = row[p]; if (!sl || !sl[0]) continue; filled++;
        if (sl[1]) { seen[sl[1]] = (seen[sl[1]] || 0) + 1; if (seen[sl[1]] === 2) doubles++; }
        for (const t of toks(sl[0])) ((busy[t] ||= {})[d] ||= new Set()).add(p);
      }
      if (row[0] && row[0][0] && row[0][0] === cfg.classTeacher[c]) ctP1++;
    }
  }
  let gaps = 0;
  for (const t of Object.keys(busy)) for (const d of Object.keys(busy[t])) { const ps = [...busy[t][d]].sort((a, b) => a - b); gaps += ps[ps.length - 1] - ps[0] + 1 - ps.length; }
  let q = 0; try { q = qualityReport(cfg, grid).score; } catch (e) { /* ignore */ }
  return { filled, total, ctP1, doubles, gaps, q };
}

function gridDiff(cfg, g1, g2) {
  let diff = 0, tot = 0;
  for (const c of cfg.classes) { const lim = classPeriods(cfg, c); for (const d of cfg.days) for (let p = 0; p < lim; p++) { tot++; if ((g1?.[c]?.[d]?.[p]?.[0] || "") !== (g2?.[c]?.[d]?.[p]?.[0] || "")) diff++; } }
  return tot ? diff / tot : 0;
}
function versionScore(st) { return st.filled * 100 + (st.q || 0) * 4 + st.ctP1 * 3 - st.doubles * 2 - st.gaps * 0.3; }
function versionsCSV(cfg, list) {
  const q = (x) => (/[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
  const L = [["Version", "Class", "Day", ...cfg.periods.map((p) => "P" + p)].join(",")];
  for (const v of list) for (const c of cfg.classes) for (const d of cfg.days)
    L.push([q(v.name), c, d, ...cfg.periods.map((_, pi) => { const sl = v.grid[c]?.[d]?.[pi]; return sl && sl[0] ? q(sl[0] === sl[1] ? sl[1] : `${sl[1]}/${sl[0]}`) : ""; })].join(","));
  return L.join("\n") + "\n";
}
function downloadText(name, text, type) {
  try { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: type || "text/csv" })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 200); }
  catch (e) { alert("Couldn't download: " + ((e && e.message) || e)); }
}
const MAX_SAVED_VERSIONS = 10;
function VersionsPanel({ cfg, update, ask, opts }) {
  const [n, setN] = useState("max");
  const [list, setList] = useState([]);
  const [busy, setBusy] = useState("");
  const [running, setRunning] = useState(false);
  const [sort, setSort] = useState("best");
  const [view, setView] = useState({ id: null, cls: cfg.classes[0] });
  const [paper, setPaper] = useState("A4");
  const stopRef = useRef(false);
  const saved = cfg.versions || [];
  const make = () => {
    const target = n === "max" ? 30 : +n, out = []; let tries = 0, dupRun = 0;
    stopRef.current = false; setList([]); setRunning(true); setView({ id: null, cls: view.cls });
    const t0 = Date.now();
    const finish = (why) => { setRunning(false); setBusy(why); };
    const one = () => {
      if (stopRef.current) return finish(`Stopped. ${out.length} different version${out.length === 1 ? "" : "s"} made.`);
      if (out.length >= target) return finish(`Done — ${out.length} different versions in ${Math.round((Date.now() - t0) / 1000)} s.${n === "max" ? " That is the limit of 30 at a time; save the ones you like and run again for more." : ""}`);
      if (dupRun >= 8) return finish(`Done — only ${out.length} different version${out.length === 1 ? " is" : "s are"} possible with your current locks, rules and combined sessions (the generator kept producing the same timetables). Unfreeze some periods or relax rules for more variety.`);
      setBusy(`Making version ${out.length + 1}${n === "max" ? "" : ` of ${target}`}… (${tries} tried, ${tries - out.length} duplicates skipped)`);
      setTimeout(() => {
        try {
          tries++;
          const res = autoSchedule(cfg, "all", null, { ...opts(), seedBase: Math.floor(Math.random() * 1e9) });
          const near = out.find((x) => gridDiff(cfg, x.grid, res.grid) < 0.03);
          if (near) dupRun++;
          else {
            dupRun = 0;
            const st = versionStats(cfg, res.grid);
            out.push({ id: "v" + Date.now() + "_" + out.length, name: `Version ${out.length + 1}`, grid: res.grid, st, score: versionScore(st), unplaced: res.unplaced, diffNow: gridDiff(cfg, cfg.grid, res.grid) });
            setList(out.slice());
          }
        } catch (e) { return finish("Couldn't generate: " + ((e && e.message) || e)); }
        one();
      }, 25);
    };
    one();
  };
  const withGrid = (v) => ({ ...cfg, grid: v.grid });
  const use = (v) => ask(`Use ${v.name}? It replaces the current timetable of every class. (Tip: save the current timetable as a version first if you may want it back.)`, () => { update((x) => { x.grid = JSON.parse(JSON.stringify(v.grid)); }); setBusy(`${v.name} is now your timetable.`); });
  const save = (v) => {
    if (saved.length >= MAX_SAVED_VERSIONS) { setBusy(`You can keep up to ${MAX_SAVED_VERSIONS} saved versions. Delete one first.`); return; }
    const name = `Saved ${new Date().toLocaleDateString(undefined, { day: "2-digit", month: "short" })} · ${v.name}`;
    update((x) => { x.versions = [...(x.versions || []), { id: "s" + Date.now(), name, at: Date.now(), grid: v.grid, st: v.st, score: v.score }]; });
    setBusy(`${v.name} saved — it stays in the app until you delete it.`);
  };
  const saveCurrent = () => {
    if (saved.length >= MAX_SAVED_VERSIONS) { setBusy(`You can keep up to ${MAX_SAVED_VERSIONS} saved versions. Delete one first.`); return; }
    const st = versionStats(cfg, cfg.grid);
    update((x) => { x.versions = [...(x.versions || []), { id: "s" + Date.now(), name: `Current timetable · ${new Date().toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`, at: Date.now(), grid: JSON.parse(JSON.stringify(cfg.grid)), st, score: versionScore(st) }]; });
    setBusy("The current timetable is saved as a version.");
  };
  const del = (v) => ask(`Delete "${v.name}"?`, () => update((x) => { x.versions = (x.versions || []).filter((y) => y.id !== v.id); }));
  const rename = (v, name) => update((x) => { const y = (x.versions || []).find((z) => z.id === v.id); if (y) y.name = name; });
  const shown = sort === "best" ? list.slice().sort((a, b) => b.score - a.score) : list;
  const bestScore = list.length ? Math.max(...list.map((x) => x.score)) : null;
  const all = [...list, ...saved];
  const v = all.find((x) => x.id === view.id) || null;
  const best = (key, dir) => list.length ? (dir < 0 ? Math.min : Math.max)(...list.map((x) => x.st[key])) : null;
  const num = (val, key, dir) => <td style={{ ...cellTd, height: 36, fontFamily: mono, fontWeight: list.length > 1 && val === best(key, dir) ? 800 : 500, color: list.length > 1 && val === best(key, dir) ? C.free : C.ink }}>{val}</td>;
  const sm = { ...ghostBtn, padding: "4px 9px", fontSize: 12 };
  const actions = (x, isSaved) => (
    <div style={{ display: "flex", gap: 5, justifyContent: "center", flexWrap: "wrap" }}>
      <button className="tt-btn" onClick={() => setView({ ...view, id: view.id === x.id ? null : x.id })} style={sm}>{view.id === x.id ? "Hide" : "View"}</button>
      <button className="tt-btn" onClick={() => exportClassesPDF(withGrid(x), paper)} style={sm}>Class PDF</button>
      <button className="tt-btn" onClick={() => exportTeachersPDF(withGrid(x), paper)} style={sm}>Teacher PDF</button>
      <button className="tt-btn" onClick={() => downloadText(`${x.name.replace(/[^\w-]+/g, "_")}.csv`, versionsCSV(cfg, [x]))} style={sm}>CSV</button>
      {!isSaved && <button className="tt-btn" onClick={() => save(x)} style={sm}>Save</button>}
      {isSaved && <button className="tt-btn" onClick={() => del(x)} style={{ ...sm, color: C.clash }}>Delete</button>}
      <button className="tt-btn" onClick={() => use(x)} style={{ ...solidBtn, padding: "4px 12px", fontSize: 12 }}>Use</button>
    </div>
  );
  return (
    <div style={{ ...card, marginBottom: 14 }}>
      <Panelhead text="Timetable versions — make many different timetables and pick the best" count={list.length ? `${list.length} made · ${saved.length} saved` : saved.length ? `${saved.length} saved` : null} />
      <div style={{ padding: 14, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 12.5, color: C.sub }}>
          <span>Make</span>
          <select className="tt-sel" style={{ width: 210 }} value={n} onChange={(e) => setN(e.target.value)} disabled={running}>
            <option value="max">All possible (up to 30 different)</option>
            {["2", "3", "5", "8", "10", "15", "20"].map((x) => <option key={x} value={x}>{x} versions</option>)}
          </select>
          {!running && <button className="tt-btn" onClick={make} style={solidBtn}>Generate versions</button>}
          {running && <button className="tt-btn" onClick={() => { stopRef.current = true; }} style={{ ...solidBtn, background: C.clash }}>Stop</button>}
          <button className="tt-btn" onClick={saveCurrent} disabled={running} style={ghostBtn}>Save current timetable as a version</button>
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center" }}>
            PDF paper <select className="tt-sel" style={{ width: 80 }} value={paper} onChange={(e) => setPaper(e.target.value)}><option>A4</option><option>A3</option><option>Letter</option><option>Legal</option></select>
          </span>
        </div>
        <div className="tt-callout">Each version is a complete, clash-free timetable built from the same mapping, rules, common periods and combined sessions. <b>Frozen (locked) periods stay the same in every version</b> — freeze what must not change (Scheduling rules → Freeze / unfreeze periods), then generate. Copies that are almost the same (less than 3% different) are skipped, so every version in the list is really different. Nothing changes until you press <b>Use</b>.</div>
        {busy && <div style={{ fontSize: 12.5, color: running ? C.primary : C.ink, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>{running && <span className="tt-spin" />}{busy}</div>}
        {list.length > 0 && (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 12.5, color: C.sub }}>
              <span>Order</span>
              <select className="tt-sel" style={{ width: 130 }} value={sort} onChange={(e) => setSort(e.target.value)}><option value="best">Best first</option><option value="made">As made</option></select>
              <span style={{ marginLeft: "auto" }} />
              <button className="tt-btn" onClick={() => downloadText("all_timetable_versions.csv", versionsCSV(cfg, list))} style={ghostBtn}>Download all versions (one CSV)</button>
            </div>
            <div className="tt-scroll" style={{ overflowX: "auto" }}>
              <table style={{ ...tbl, minWidth: 1080 }}>
                <thead><tr>
                  <th style={{ ...th, width: 120 }}>Version</th><th style={th} title="Periods placed">Filled</th><th style={th} title="Days the class teacher takes P1">Class teacher P1</th><th style={th} title="Times a subject comes twice on one day">Twice a day</th><th style={th} title="Empty periods between a teacher's lessons">Teacher gaps</th><th style={th} title="Teaching-quality score from your preferences">Quality</th><th style={th} title="How much it differs from the timetable you have now">Different from now</th><th style={th}>Actions</th>
                </tr></thead>
                <tbody>{shown.map((x) => (
                  <tr key={x.id} style={{ background: view.id === x.id ? C.primarySoft : "transparent" }}>
                    <td style={{ ...cellTd, height: 36, fontWeight: 800 }}>{x.name.replace("Version ", "#")}{x.score === bestScore && list.length > 1 && <span style={{ marginLeft: 6, fontSize: 10.5, padding: "1px 7px", borderRadius: 10, background: C.freeSoft, color: C.free }}>★ best</span>}</td>
                    <td style={{ ...cellTd, height: 36, fontFamily: mono, color: x.unplaced ? C.warn : C.free, fontWeight: 700 }}>{x.st.filled}/{x.st.total}</td>
                    {num(x.st.ctP1, "ctP1", 1)}{num(x.st.doubles, "doubles", -1)}{num(x.st.gaps, "gaps", -1)}{num(x.st.q || 0, "q", 1)}
                    <td style={{ ...cellTd, height: 36, fontFamily: mono }}>{Math.round(x.diffNow * 100)}%</td>
                    <td style={{ ...cellTd, height: 36, minWidth: 380 }}>{actions(x, false)}</td>
                  </tr>))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11.5, color: C.sub }}>Green = best value. ★ best = most periods filled, then more class-teacher P1 days, fewer twice-a-day subjects and fewer teacher gaps. Made versions disappear when you leave this page — press <b>Save</b> to keep one.</div>
          </>
        )}
        {saved.length > 0 && (
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "9px 12px", background: "#f7f9fb", fontSize: 13, fontWeight: 800, borderBottom: `1px solid ${C.line}` }}>Saved versions <span style={{ color: C.sub, fontWeight: 600, fontSize: 12 }}>({saved.length} of {MAX_SAVED_VERSIONS}) — kept with your timetable on every device</span></div>
            <div className="tt-scroll" style={{ overflowX: "auto" }}>
              <table style={{ ...tbl, minWidth: 880 }}>
                <tbody>{saved.map((x) => (
                  <tr key={x.id} style={{ background: view.id === x.id ? C.primarySoft : "transparent" }}>
                    <td style={{ ...cellTd, height: 38, textAlign: "left", paddingLeft: 10, width: 300 }}><input className="tt-in" style={{ fontFamily: sans, fontWeight: 700 }} value={x.name} onChange={(e) => rename(x, e.target.value)} /></td>
                    <td style={{ ...cellTd, height: 38, fontFamily: mono, fontSize: 12 }}>{x.st ? `${x.st.filled}/${x.st.total} filled · CT P1 ${x.st.ctP1} · gaps ${x.st.gaps}` : ""}</td>
                    <td style={{ ...cellTd, height: 38 }}>{actions(x, true)}</td>
                  </tr>))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {v && (
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#f7f9fb", fontSize: 12.5 }}>
              <b>{v.name}</b> · class
              <select className="tt-sel" style={{ width: 90 }} value={view.cls} onChange={(e) => setView({ ...view, cls: e.target.value })}>{cfg.classes.map((c) => <option key={c}>{c}</option>)}</select>
            </div>
            <GridTable cfg={cfg} render={(d, pi) => {
              if (pi >= classPeriods(cfg, view.cls)) return { bg: "#eef0f3" };
              const sl = v.grid[view.cls]?.[d]?.[pi] || [null, null];
              const cs = (cfg.combined || []).find((x) => x.name === sl[0]);
              return { t: cs ? cs.teachers.join(" ") : sl[0], s: sl[1], bg: sl[0] ? SUBJECT_TINT[sl[1]] || "#fff" : "#fafafa", sub: sl[1] };
            }} />
          </div>
        )}
      </div>
    </div>
  );
}

function EditView({ cfg, cls, update, expand, clashTokens, occupancy, ask, askPw, mobile }) {
  const keys = cfg.bkey[cls] || [];
  const [report, setReport] = useState("");
  const [fzDay, setFzDay] = useState(cfg.days[0]);
  const [rpMode, setRpMode] = useState("replace");
  const [rpFrom, setRpFrom] = useState("");
  const [rpTo, setRpTo] = useState("");
  const [rpScope, setRpScope] = useState("all");
  const [rpMap, setRpMap] = useState(true);
  const doReplace = () => {
    const A = rpFrom, B = rpTo.trim().toUpperCase();
    if (!A || !B || A === B) { setReport("Pick the teacher to change and a different teacher (or type a new name)."); return; }
    const swap = rpMode === "swap";
    const where = rpScope === "all" ? "ALL classes" : cls;
    const verb = swap ? `Swap ${A} ↔ ${B}` : `Replace ${A} with ${B}`;
    ask(`${verb} in ${where}${rpMap ? " (timetable + mapping)" : " (timetable only)"}?`, () => {
      update((n) => {
        if (!n.singles.includes(B)) { n.singles.push(B); n.singles.sort(); }
        const combNames = new Set((n.combined || []).map((x) => x.name));
        const sw = (v) => (v === A ? B : swap && v === B ? A : v);
        const swCode = (v) => (!v || combNames.has(v) ? v : String(v).indexOf(" ") < 0 ? sw(v) : String(v).split(" ").map(sw).join(" "));
        const scope = rpScope === "all" ? n.classes : [cls];
        for (const c of scope) {
          for (const d of n.days) (n.grid[c]?.[d] || []).forEach((sl) => { sl[0] = swCode(sl[0]); });
          if (rpMap) (n.bkey[c] || []).forEach((r) => { r.teacher = swCode(r.teacher); });
          if (n.classTeacher[c] === A) n.classTeacher[c] = B; else if (swap && n.classTeacher[c] === B) n.classTeacher[c] = A;
        }
        if (rpScope === "all") (n.combined || []).forEach((se) => { se.teachers = [...new Set(se.teachers.map(sw))]; });
      });
      setReport(`${verb} in ${where}: done. If ${swap ? "either teacher" : B} was already teaching at some of those times, the clash counter will show it — fix those slots or run Fill remaining.`);
      setRpFrom(""); setRpTo("");
    });
  };
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

  const offDay = useMemo(() => {
    const TD = cfg.teacherDays || {}; const out = [];
    if (!Object.keys(TD).length) return out;
    const combs = {}; (cfg.combined || []).forEach((x) => (combs[x.name] = x));
    for (const c of cfg.classes) for (const d of cfg.days) (cfg.grid[c]?.[d] || []).forEach((sl, p) => {
      if (!sl || !sl[0]) return;
      const toks = combs[sl[0]] ? combs[sl[0]].teachers : String(sl[0]).split(" ");
      for (const t of toks) { const a = TD[t]; if (a && a.length && !a.includes(d)) out.push(`${t} in ${c} ${d} P${p + 1}`); }
    });
    return [...new Set(out)];
  }, [cfg]);
  const [thorough, setThorough] = useState(false);
  const genOpts = () => ({ ...(thorough ? { maxMs: 15000, walkMs: 9000, walkFails: 30000 } : {}), seedBase: Math.floor(Math.random() * 1e9) });
  const fillPct = (res) => { let f = 0, tot = 0; for (const c of cfg.classes) { const lim = classPeriods(cfg, c); for (const d of cfg.days) for (let p = 0; p < lim; p++) { tot++; if (res.grid?.[c]?.[d]?.[p]?.[0]) f++; } } return { f, tot }; };
  const describeRun = (res, okText) => {
    const parts = [];
    const fp = fillPct(res); parts.push(`Filled ${fp.f} of ${fp.tot} periods (${fp.tot ? Math.round((fp.f * 100) / fp.tot) : 0}%).`);
    if (res.unplaced === 0) parts.push(okText);
    else parts.push(`${res.unplaced} period(s) could not be placed without breaking a rule: ${res.missing.slice(0, 10).join(", ")}${res.missing.length > 10 ? ` … +${res.missing.length - 10} more` : ""}.`);
    if (res.issues && res.issues.length) parts.push(`Rule notes: ${res.issues.slice(0, 6).join("; ")}${res.issues.length > 6 ? ` … +${res.issues.length - 6} more` : ""}.`);
    return parts.join(" ");
  };
  const genAll = () => ask("Auto-generate a fresh, clash-free timetable for the whole school from the mapping? This replaces every current assignment.", () => {
    setReport(thorough ? "Generating thoroughly… this can take up to 25 seconds." : "Generating… this can take a few seconds.");
    setTimeout(() => {
      try {
        const res = autoSchedule(cfg, "all", null, genOpts());
        update((n) => { n.grid = res.grid; });
        setReport(describeRun(res, "Generated a complete clash-free timetable for all classes, following every rule."));
      } catch (e) { setReport("Couldn't generate: " + ((e && e.message) || e) + ". A rule/language-session may reference a class or teacher that no longer exists — check Classes & setup, or try 'Fill remaining'."); }
    }, 60);
  });
  const genFillAll = () => {
    setReport(thorough ? "Filling thoroughly… this can take up to 25 seconds." : "Filling remaining slots…");
    setTimeout(() => {
      try {
        const res = autoSchedule(cfg, "gaps", null, genOpts());
        update((n) => { n.grid = res.grid; });
        setReport(describeRun(res, "Filled all remaining slots following every rule. Your existing timetable and locks were kept."));
      } catch (e) { setReport("Couldn't fill: " + ((e && e.message) || e) + ". Check Classes & setup for a removed class/teacher still referenced by a rule or language session."); }
    }, 60);
  };
  const fillClass = () => {
    setReport(`Filling ${cls}…`);
    setTimeout(() => { try { const res = autoSchedule(cfg, "class", cls); update((n) => { n.grid = res.grid; }); setReport(describeRun(res, `Filled the empty slots of ${cls} following every rule.`)); } catch (e) { setReport("Couldn't fill " + cls + ": " + ((e && e.message) || e)); } }, 60);
  };
  const clearClass = () => ask(`Clear the entire timetable for ${cls}?`, () => { update((n) => { for (const d of n.days) n.grid[cls][d] = emptyDay(n.periods.length); }); setReport(`Cleared ${cls}.`); });
  const clearAllTT = () => askPw("Clear EVERY class's timetable and start completely blank? All locks are also removed.", () => { update((n) => { for (const c of n.classes) for (const d of n.days) n.grid[c][d] = emptyDay(n.periods.length); n.locked = {}; }); setReport("All timetables cleared — everything is blank."); });
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
      <ViewHeader title={`Assign timetable · Class ${cls}`} note="Each slot offers only this class's mapped subjects. Picking one sets the teacher automatically." right={<>
        <button className="tt-btn" onClick={genFillAll} style={solidBtn}>Fill remaining (all)</button>
        <button className="tt-btn" onClick={fillClass} style={ghostBtn}>Auto-fill {cls}</button>
        <button className="tt-btn" onClick={clearClass} style={ghostBtn}>Clear {cls}</button>
        <button className="tt-btn" onClick={clearAllTT} style={{ ...ghostBtn, color: C.clash }}>Clear all</button>
        <button className="tt-btn" onClick={genAll} style={ghostBtn}>Regenerate (replace all)</button>
        <label title="Spends up to about 25 seconds searching, to place as many periods as possible" style={{ fontSize: 12.5, color: C.sub, display: "inline-flex", alignItems: "center", gap: 5, fontWeight: 600 }}><input type="checkbox" checked={thorough} onChange={(e) => setThorough(e.target.checked)} /> Try harder (max fill)</label>
      </>} />
      {report && <Banner tone="primary">{report}</Banner>}
      <QualityPanel cfg={cfg} update={update} ask={ask} compact />
      <SwapBoard cfg={cfg} update={update} cls={cls} mobile={mobile} />
      <VersionsPanel cfg={cfg} update={update} ask={ask} opts={genOpts} />
      <div style={{ ...card, marginBottom: 14, padding: 12, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.sub }}>Change a teacher after assigning:</span>
        <select className="tt-sel" style={{ width: 150 }} value={rpMode} onChange={(e) => setRpMode(e.target.value)}><option value="replace">Replace teacher</option><option value="swap">Swap (interchange)</option></select>
        <select className="tt-sel" style={{ width: 110 }} value={rpFrom} onChange={(e) => setRpFrom(e.target.value)}><option value="">teacher…</option>{cfg.singles.map((t) => <option key={t}>{t}</option>)}</select>
        <span style={{ fontWeight: 800, color: C.primary }}>{rpMode === "swap" ? "↔" : "→"}</span>
        <input className="tt-in" list="tt-rp-teachers" style={{ width: 130 }} placeholder={rpMode === "swap" ? "other teacher" : "new teacher"} value={rpTo} onChange={(e) => setRpTo(e.target.value)} />
        <datalist id="tt-rp-teachers">{cfg.singles.map((t) => <option key={t} value={t} />)}</datalist>
        <select className="tt-sel" style={{ width: 130 }} value={rpScope} onChange={(e) => setRpScope(e.target.value)}><option value="all">All classes</option><option value="class">Only {cls}</option></select>
        <label style={{ fontSize: 12.5, color: C.sub, display: "inline-flex", alignItems: "center", gap: 5 }}><input type="checkbox" checked={rpMap} onChange={(e) => setRpMap(e.target.checked)} /> also update mapping</label>
        <button className="tt-btn" onClick={doReplace} style={solidBtn}>Apply</button>
        <div style={{ width: "100%", fontSize: 11.5, color: C.sub, lineHeight: 1.5 }}>Replace: a temporary name, or a teacher who left, hands every period to the new teacher (type a new name to add one). Swap: two teachers exchange their periods — across the school, or only in {cls}.</div>
      </div>
      {offDay.length > 0 && <Banner tone="warn">Off-day warning — {offDay.length} period(s) are given to a teacher on a day they don't work: {offDay.slice(0, 8).join(", ")}{offDay.length > 8 ? ` … +${offDay.length - 8} more` : ""}. Move them, or run Fill remaining after clearing those slots.</Banner>}
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
      {keys.length === 0 && <Banner tone="warn">No mapping set for {cls} yet. Add subjects in the “Mapping” tab first.</Banner>}

      <div style={{ ...card, overflowX: "auto" }}>
        <table style={{ ...tbl, minWidth: 820 }}>
          <thead><tr><th style={{ ...th, width: 46 }}>P</th>{cfg.days.map((d) => <th key={d} style={th}>{DAY_FULL[d]}</th>)}</tr></thead>
          <tbody>
            {cfg.periods.map((p, pi) => (
              <tr key={p}>
                <td style={perTd}>{p}</td>
                {cfg.days.map((d) => {
                  if (pi >= classPeriods(cfg, cls)) return <td key={d} style={{ ...editTd, background: "#eef0f3", textAlign: "center", color: C.sub, fontSize: 11 }} title={`${cls} has ${classPeriods(cfg, cls)} periods a day`}>—</td>;
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
function FreezePanel({ cfg, update, ask }) {
  const [scope, setScope] = useState("all");
  const [day, setDay] = useState("all");
  const [per, setPer] = useState("all");
  const [what, setWhat] = useState("all");
  const [msg, setMsg] = useState("");
  const cm = useMemo(() => { const m = {}; (cfg.combined || []).forEach((x) => (m[x.name] = x)); return m; }, [cfg.combined]);
  const tOf = (code) => (!code ? [] : cm[code] ? cm[code].teachers : String(code).split(" "));
  const stds = standardsOf(cfg);
  const locked = cfg.locked || {};
  const keyOf = (c, d, p) => `${c}|${d}|${p}`;
  const classesIn = (sc) => sc === "all" ? cfg.classes : sc.startsWith("std:") ? cfg.classes.filter((c) => stdOf(c) === sc.slice(4)) : [sc.slice(4)];
  const match = useMemo(() => {
    const out = [];
    for (const c of classesIn(scope)) {
      const lim = classPeriods(cfg, c);
      for (const d of cfg.days) {
        if (day !== "all" && d !== day) continue;
        for (let p = 0; p < lim; p++) {
          if (per !== "all" && p !== +per) continue;
          const sl = cfg.grid[c]?.[d]?.[p] || [null, null];
          if (what === "filled" && !sl[0]) continue;
          if (what === "empty" && sl[0]) continue;
          if (what.startsWith("sub:") && sl[1] !== what.slice(4)) continue;
          if (what.startsWith("tch:") && !tOf(sl[0]).includes(what.slice(4))) continue;
          if (what === "combined" && !cm[sl[0]]) continue;
          out.push(keyOf(c, d, p));
        }
      }
    }
    return out;
  }, [cfg, scope, day, per, what, cm]);
  const nLockedMatch = match.filter((k) => locked[k]).length;
  const allKeys = Object.keys(locked).filter((k) => locked[k]);
  const nFilled = allKeys.filter((k) => { const [c, d, p] = k.split("|"); return cfg.grid[c]?.[d]?.[+p]?.[0]; }).length;
  const byClass = {}; for (const k of allKeys) { const c = k.split("|")[0]; byClass[c] = (byClass[c] || 0) + 1; }
  const apply = (on) => {
    const ks = match.slice();
    update((n) => { n.locked = n.locked || {}; for (const k of ks) { if (on) n.locked[k] = true; else delete n.locked[k]; } });
    setMsg(on ? `Froze ${ks.length - nLockedMatch} more period${ks.length - nLockedMatch === 1 ? "" : "s"} (${ks.length} match).` : `Unfroze ${nLockedMatch} period${nLockedMatch === 1 ? "" : "s"}.`);
  };
  const slotCount = (d, p) => { let k = 0, tot = 0; for (const c of cfg.classes) { if (p >= classPeriods(cfg, c)) continue; tot++; if (locked[keyOf(c, d, p)]) k++; } return { k, tot }; };
  const toggleSlot = (d, p) => { const { k, tot } = slotCount(d, p); const on = k < tot; update((n) => { n.locked = n.locked || {}; for (const c of n.classes) { if (p >= classPeriods(n, c)) continue; const kk = keyOf(c, d, p); if (on) n.locked[kk] = true; else delete n.locked[kk]; } }); };
  const unfreezeClass = (c) => update((n) => { for (const k of Object.keys(n.locked || {})) if (k.startsWith(c + "|")) delete n.locked[k]; });
  const lab = { display: "grid", gap: 4, fontSize: 11, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 0.4 };
  return (
    <div style={card}>
      <Panelhead text="Freeze / unfreeze periods" count={`${allKeys.length} frozen`} tone={allKeys.length ? "free" : undefined} />
      <div style={{ padding: 14, display: "grid", gap: 14 }}>
        <div className="tt-callout">A <b>frozen</b> period is never changed by Auto-generate, Fill remaining, Fix clashes or new versions — a filled one keeps its subject and teacher, an empty one stays blank. Choose what to freeze below, or tap a cell in the day × period map to freeze / unfreeze that period for all classes. Single periods can also be frozen with 🔓 on the Assign timetable tab.</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={lab}>Classes
            <select className="tt-sel" style={{ width: 150 }} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">All classes</option>
              <optgroup label="Standard">{stds.map((s) => <option key={s} value={"std:" + s}>Standard {s}</option>)}</optgroup>
              <optgroup label="Class">{cfg.classes.map((c) => <option key={c} value={"cls:" + c}>{c}</option>)}</optgroup>
            </select>
          </label>
          <label style={lab}>Day
            <select className="tt-sel" style={{ width: 130 }} value={day} onChange={(e) => setDay(e.target.value)}><option value="all">All days</option>{cfg.days.map((d) => <option key={d} value={d}>{DAY_FULL[d]}</option>)}</select>
          </label>
          <label style={lab}>Period
            <select className="tt-sel" style={{ width: 110 }} value={per} onChange={(e) => setPer(e.target.value)}><option value="all">All periods</option>{cfg.periods.map((p, i) => <option key={i} value={i}>P{p}</option>)}</select>
          </label>
          <label style={lab}>Which periods
            <select className="tt-sel" style={{ width: 190 }} value={what} onChange={(e) => setWhat(e.target.value)}>
              <option value="all">All (filled and empty)</option>
              <option value="filled">Filled only</option>
              <option value="empty">Empty only (keep blank)</option>
              <option value="combined">Combined sessions only</option>
              <optgroup label="Subject">{cfg.subjects.map((s) => <option key={s} value={"sub:" + s}>{s}</option>)}</optgroup>
              <optgroup label="Teacher">{cfg.singles.map((t) => <option key={t} value={"tch:" + t}>{t}</option>)}</optgroup>
            </select>
          </label>
          <span style={{ fontSize: 12.5, color: C.sub, paddingBottom: 7 }}><b style={{ color: C.ink }}>{match.length}</b> match · <b style={{ color: C.accent }}>{nLockedMatch}</b> already frozen</span>
          <span style={{ display: "inline-flex", gap: 8, marginLeft: "auto" }}>
            <button className="tt-btn" disabled={!match.length || nLockedMatch === match.length} onClick={() => apply(true)} style={{ ...solidBtn, background: C.accent, boxShadow: "0 2px 8px rgba(217,138,43,.3)", opacity: !match.length || nLockedMatch === match.length ? 0.5 : 1 }}>🔒 Freeze {match.length - nLockedMatch || ""}</button>
            <button className="tt-btn" disabled={!nLockedMatch} onClick={() => apply(false)} style={{ ...ghostBtn, opacity: nLockedMatch ? 1 : 0.5 }}>🔓 Unfreeze {nLockedMatch || ""}</button>
          </span>
        </div>
        {msg && <div style={{ fontSize: 12.5, fontWeight: 600, color: C.free }}>{msg}</div>}
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>Day × period map <span style={{ color: C.sub, fontWeight: 600 }}>(classes frozen)</span></div>
            <table style={{ borderCollapse: "separate", borderSpacing: 3 }}>
              <thead><tr><th />{cfg.periods.map((p, i) => <th key={i} style={{ fontSize: 11, color: C.sub, fontWeight: 700 }}>P{p}</th>)}</tr></thead>
              <tbody>{cfg.days.map((d) => (
                <tr key={d}>
                  <td style={{ fontSize: 11.5, fontWeight: 800, color: C.sub, paddingRight: 6 }}>{DAY_FULL[d].slice(0, 3)}</td>
                  {cfg.periods.map((_, p) => {
                    const { k, tot } = slotCount(d, p), full = tot && k === tot;
                    return <td key={p}><button className="tt-btn" onClick={() => toggleSlot(d, p)} title={`${DAY_FULL[d]} P${p + 1}: ${k} of ${tot} classes frozen — tap to ${full ? "unfreeze" : "freeze"} all`}
                      style={{ width: 46, height: 32, borderRadius: 8, cursor: "pointer", fontSize: 11.5, fontWeight: 800, fontFamily: mono, border: `1.5px solid ${k ? C.accent : C.line}`, background: full ? C.accent : k ? C.accentSoft : "#fff", color: full ? "#fff" : k ? "#94620b" : "#b4bccb" }}>{full ? "🔒" : k || "·"}</button></td>;
                  })}
                </tr>))}
              </tbody>
            </table>
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 800 }}>Frozen by class</span>
              <span style={{ fontSize: 11.5, color: C.sub }}>{nFilled} filled · {allKeys.length - nFilled} kept blank</span>
              {allKeys.length > 0 && <button className="tt-btn" onClick={() => ask(`Unfreeze all ${allKeys.length} frozen periods in every class?`, () => update((n) => { n.locked = {}; }))} style={{ ...ghostBtn, marginLeft: "auto", padding: "4px 10px", fontSize: 12, color: C.clash }}>Unfreeze everything</button>}
            </div>
            {allKeys.length === 0 ? <div style={{ fontSize: 12.5, color: C.sub }}>Nothing is frozen yet.</div> : (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {Object.keys(byClass).sort(cmpClass).map((c) => (
                  <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 4px 3px 10px", borderRadius: 20, background: C.accentSoft, border: `1px solid ${C.accent}44`, fontSize: 12, fontWeight: 700, color: "#7a4a10" }}>
                    <span style={{ fontFamily: mono }}>{c}</span><span style={{ fontWeight: 600 }}>{byClass[c]}</span>
                    <button className="tt-btn" onClick={() => unfreezeClass(c)} title={`Unfreeze all of ${c}`} style={{ border: "none", background: "#fff", borderRadius: 20, width: 20, height: 20, cursor: "pointer", color: C.clash, fontWeight: 800, lineHeight: 1 }}>×</button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
function RulesView({ cfg, update, ask }) {
  const r = (sub) => cfg.rules?.[sub] || {};
  const setRule = (sub, field, val) => update((n) => { (n.rules[sub] ||= {}); if (val === null || val === "" || (Array.isArray(val) && !val.length)) delete n.rules[sub][field]; else n.rules[sub][field] = val; });
  const toggleForbid = (sub, p) => { const cur = new Set(r(sub).forbid || []); cur.has(p) ? cur.delete(p) : cur.add(p); setRule(sub, "forbid", [...cur].sort((a, b) => a - b)); };

  return (
    <div>
      <ViewHeader title="Scheduling rules" note="Conditions the auto-generator must respect. Set them, then press Auto-generate on the Assign tab." />
      <Banner tone="primary">Rules are applied when you Auto-generate. Each is per subject and applies to every class. If a rule is impossible (e.g. a subject taught by one teacher pinned to the same period for all classes), the generator will leave those lessons unplaced and tell you.</Banner>
      <div style={{ marginBottom: 16 }}><FreezePanel cfg={cfg} update={update} ask={ask} /></div>
      <QualityPanel cfg={cfg} update={update} ask={ask} />
      <RoomsPanel cfg={cfg} update={update} ask={ask} />
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
      <CTDaysPanel cfg={cfg} update={update} />
      <CommonPeriodsPanel cfg={cfg} update={update} />
      <ClassRulesPanel cfg={cfg} update={update} />
      <TwicePanel cfg={cfg} update={update} />
      <p className="tt-callout" style={{ marginTop: 12 }}>
        “Once per day” (no subject twice in a day for a class) is always enforced. Combined subjects follow the same rules via their subject. After changing rules, go to Assign timetable → Auto-generate all to rebuild.
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
      <div className="tt-note">
        Turn on for a subject in a standard when it has more weekly periods than working days (e.g. English 6 periods across 5 days). The generator may then place it twice on one weekday for classes in that standard, spread as evenly as possible. Off means at most once per day.
      </div>
    </div>
  );
}

function CTDaysPanel({ cfg, update }) {
  const D = cfg.days.length;
  const stds = standardsOf(cfg);
  const [q, setQ] = useState("");
  const [allN, setAllN] = useState(String(D));
  const [stdSel, setStdSel] = useState(stds[0] || "");
  const [stdN, setStdN] = useState(String(D));
  const [target, setTarget] = useState(String(D));
  const [minD, setMinD] = useState("2");
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState("");
  const [result, setResult] = useState(null);
  const ruleOf = (c) => cfg.classRules?.[c]?.[1];
  const valOf = (c) => { const r = ruleOf(c); if (!r || r.kind !== "ct") return "off"; if (r.days && r.days.length) return "fixed"; return r.count ? String(r.count) : String(D); };
  const setVal = (n, c, v) => {
    n.classRules = n.classRules || {};
    if (v === "off") { if (n.classRules[c]) { delete n.classRules[c][1]; if (!Object.keys(n.classRules[c]).length) delete n.classRules[c]; } return; }
    (n.classRules[c] ||= {}); n.classRules[c][1] = { kind: "ct", count: +v };
  };
  const setOne = (c, v) => update((n) => setVal(n, c, v));
  const setMany = (list, v) => update((n) => { for (const c of list) if (n.classTeacher[c]) setVal(n, c, v); });
  const ctSubs = (c) => { const ct = cfg.classTeacher[c]; return (cfg.bkey[c] || []).filter((r) => r.teacher === ct && r.sub).map((r) => `${r.sub} ${periodsFor(cfg, c, r.sub)}`).join(", "); };
  const list = cfg.classes.filter((c) => !q.trim() || (c + " " + (cfg.classTeacher[c] || "")).toLowerCase().includes(q.trim().toLowerCase()));
  // if every class keeps P1 for its class teacher every day, teachers who are nobody's class teacher can never use P1
  const p1Short = useMemo(() => {
    const allDays = cfg.classes.filter((c) => cfg.classTeacher[c]).every((c) => valOf(c) === String(D));
    if (!allDays) return [];
    const cts = new Set(Object.values(cfg.classTeacher).filter(Boolean)); const cov = combCover(cfg); const need = {};
    for (const c of cfg.classes) for (const r of (cfg.bkey[c] || [])) { if (!r.teacher || cts.has(r.teacher) || (cfg.combined || []).some((x) => x.name === r.teacher)) continue; need[r.teacher] = (need[r.teacher] || 0) + Math.max(0, periodsFor(cfg, c, r.sub) - (cov[c + "|" + r.sub] || 0)); }
    const blocked = (cfg.commonPeriods || []).reduce((a, cp) => a + (cp.classes.length >= cfg.classes.length ? (cp.slots || []).length : 0), 0);
    return Object.entries(need).map(([t, n]) => ({ t, n, room: teacherCap(cfg, t) - blocked - teacherWorkDays(cfg, t).length })).filter((x) => x.n > x.room);
  }, [cfg]);
  const opts = [["off", "Off"], ...Array.from({ length: D }, (_, i) => [String(i + 1), i + 1 === D ? `${D} (every day)` : `${i + 1} day${i ? "s" : ""}`])];

  const runBalance = () => {
    const minN = +minD, tgt = +target;
    let counts = {};
    for (const c of cfg.classes) { if (!cfg.classTeacher[c]) continue; const v = valOf(c); if (v === "fixed") continue; counts[c] = tgt; }
    if (!Object.keys(counts).length) { setProg("No classes with a class teacher to balance."); return; }
    setBusy(true); setResult(null); setProg("Test run 1…");
    let it = 0, best = null, prevU = 1e9;
    const step = () => {
      it++;
      let st;
      try { st = ctBalanceStep(cfg, counts, minN); } catch (e) { setBusy(false); setProg("Couldn't test: " + ((e && e.message) || e)); return; }
      if (!best || st.res.unplaced < best.res.unplaced) best = { counts: { ...counts }, res: st.res, notP1: st.notP1 };
      const worse = it > 1 && st.res.unplaced >= prevU;
      if (st.res.unplaced === 0 || !st.changed || worse || it >= 10) {
        setBusy(false); setProg("");
        const changed = Object.entries(best.counts).filter(([c, v]) => v !== tgt).sort((a, b) => cmpClass(a[0], b[0]));
        setResult({ ...best, tgt, changed });
        return;
      }
      prevU = st.res.unplaced; counts = st.next;
      setProg(`Test run ${it + 1}… (${st.res.unplaced} period(s) still not fitting — giving P1 back in the classes that need it)`);
      setTimeout(step, 40);
    };
    setTimeout(step, 40);
  };
  const applyResult = (withGrid) => update((n) => {
    for (const [c, v] of Object.entries(result.counts)) setVal(n, c, String(v));
    if (withGrid) n.grid = result.res.grid;
  });

  return (
    <div style={{ ...card, marginTop: 16 }}>
      <Panelhead text="Class teacher in the first period — days per week, per class" />
      <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.line}`, display: "grid", gap: 10 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12.5, color: C.sub, fontWeight: 700, minWidth: 92 }}>All classes:</span>
          <select className="tt-sel" style={{ width: 130 }} value={allN} onChange={(e) => setAllN(e.target.value)}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <button className="tt-btn" onClick={() => setMany(cfg.classes, allN)} style={ghostBtn}>Set all</button>
          <span style={{ fontSize: 12.5, color: C.sub, fontWeight: 700, marginLeft: 12 }}>Standard</span>
          <select className="tt-sel" style={{ width: 70 }} value={stdSel} onChange={(e) => setStdSel(e.target.value)}>{stds.map((s) => <option key={s} value={s}>{s}</option>)}</select>
          <select className="tt-sel" style={{ width: 130 }} value={stdN} onChange={(e) => setStdN(e.target.value)}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <button className="tt-btn" onClick={() => setMany(cfg.classes.filter((c) => stdOf(c) === stdSel), stdN)} style={ghostBtn}>Set Std {stdSel}</button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", background: C.primarySoft, borderRadius: 10, padding: "9px 11px" }}>
          <span style={{ fontSize: 12.5, color: C.primary, fontWeight: 800 }}>Auto-balance:</span>
          <span style={{ fontSize: 12.5, color: C.sub }}>aim for</span>
          <select className="tt-sel" style={{ width: 120 }} value={target} onChange={(e) => setTarget(e.target.value)}>{opts.filter(([v]) => v !== "off").map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <span style={{ fontSize: 12.5, color: C.sub }}>but never fewer than</span>
          <select className="tt-sel" style={{ width: 90 }} value={minD} onChange={(e) => setMinD(e.target.value)}>{Array.from({ length: D }, (_, i) => String(i + 1)).map((v) => <option key={v} value={v}>{v} day{+v > 1 ? "s" : ""}</option>)}</select>
          <button className="tt-btn" onClick={runBalance} disabled={busy} style={{ ...solidBtn, opacity: busy ? 0.6 : 1 }}>{busy ? "Testing…" : "Find the best days"}</button>
          <span style={{ fontSize: 11.5, color: C.sub, width: "100%" }}>Test-generates the timetable and lowers the class-teacher days only in the classes where IT, PET, LB or other periods can't fit — one day at a time. Nothing changes until you apply. Classes with exact days ticked are left as they are.</span>
        </div>
        {p1Short.length > 0 && <div style={{ fontSize: 12.5, lineHeight: 1.55, padding: "8px 11px", borderRadius: 9, background: C.warnSoft, color: C.warn }}>
          With the class teacher in P1 <b>every day in every class</b>, these teachers can never teach in P1 and don't have enough other periods: {p1Short.map((x) => `${x.t} needs ${x.n}, only ${x.room} non-P1 periods`).join("; ")}. Some classes must give P1 to them — press <b>Find the best days</b>.
        </div>}
        {prog && <div style={{ fontSize: 12.5, color: C.primary, fontWeight: 600 }}>{prog}</div>}
        {result && (
          <div style={{ border: `1px solid ${result.res.unplaced ? C.warn : C.free}55`, background: result.res.unplaced ? C.warnSoft : C.freeSoft, borderRadius: 10, padding: "10px 12px", fontSize: 12.5, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 800, color: result.res.unplaced ? C.warn : C.free }}>
              {result.res.unplaced === 0 ? "Everything fits." : `Best found: ${result.res.unplaced} period(s) still don't fit.`}
              {" "}{result.changed.length ? `Class teacher P1 lowered in ${result.changed.length} class${result.changed.length > 1 ? "es" : ""}; all others keep ${result.tgt} day${result.tgt > 1 ? "s" : ""}.` : `All classes keep ${result.tgt} day${result.tgt > 1 ? "s" : ""}.`}
            </div>
            {result.changed.length > 0 && <div style={{ fontFamily: mono, marginTop: 4 }}>{result.changed.map(([c, v]) => `${c}: ${v}`).join(" · ")}</div>}
            {result.res.unplaced > 0 && <div style={{ marginTop: 4, color: C.ink }}>Still not fitting: {result.res.missing.slice(0, 8).join(", ")}{result.res.missing.length > 8 ? " …" : ""}.{result.notP1 ? ` ${result.notP1} of these can't use P1 anyway (a subject rule keeps them out of P1), so fewer class-teacher days won't help them — check their subject rules or teacher load.` : ""}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button className="tt-btn" onClick={() => applyResult(false)} style={solidBtn}>Apply these days</button>
              <button className="tt-btn" onClick={() => applyResult(true)} style={ghostBtn}>Apply days + use this timetable</button>
              <button className="tt-btn" onClick={() => setResult(null)} style={ghostBtn}>Discard</button>
            </div>
          </div>
        )}
      </div>
      <div style={{ padding: "8px 14px", borderBottom: `1px solid ${C.line}` }}><input className="tt-in" style={{ width: 220 }} placeholder="Search class or teacher…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="tt-scroll" style={{ maxHeight: 420, overflow: "auto" }}>
        <table style={{ ...tbl, minWidth: 560 }}>
          <thead><tr><th style={{ ...th, textAlign: "left", paddingLeft: 12, width: 80 }}>Class</th><th style={{ ...th, width: 100 }}>Class teacher</th><th style={{ ...th, textAlign: "left" }}>Their subjects here (periods)</th><th style={{ ...th, width: 170 }}>P1 days / week</th></tr></thead>
          <tbody>{list.map((c) => { const v = valOf(c); const ct = cfg.classTeacher[c]; const r = ruleOf(c); return (
            <tr key={c}>
              <td style={{ ...cellTd, textAlign: "left", paddingLeft: 12, fontFamily: mono, fontWeight: 800, height: 38 }}>{c}</td>
              <td style={{ ...cellTd, height: 38, fontFamily: mono }}>{ct || <span style={{ color: C.clash, fontSize: 11 }}>none set</span>}</td>
              <td style={{ ...cellTd, height: 38, textAlign: "left", fontSize: 11.5, color: C.sub }}>{ct ? ctSubs(c) || "—" : ""}</td>
              <td style={{ ...cellTd, height: 38 }}>
                {v === "fixed" ? <span style={{ fontSize: 11.5, color: C.primary, fontWeight: 700 }} title="Edit in Class-specific period rules below">exact: {r.days.join(", ")}</span>
                  : <select className="tt-sel" disabled={!ct} style={{ width: 140, margin: "0 auto", fontWeight: 700, color: v === "off" ? C.sub : C.primary }} value={v} onChange={(e) => setOne(c, e.target.value)}>{opts.map(([o, l]) => <option key={o} value={o}>{l}</option>)}</select>}
              </td>
            </tr>); })}</tbody>
        </table>
      </div>
      <div className="tt-note">On the other days, the class teacher is kept out of P1 in that class, so P1 is free for IT, PET, LB and others. The generator picks which days; to fix exact days for a class, use Class-specific period rules below.</div>
    </div>
  );
}

function ClassRulesPanel({ cfg, update }) {
  const [c, setC] = useState(cfg.classes[0]);
  const [bulkCount, setBulkCount] = useState("3");
  const cls = cfg.classes.includes(c) ? c : cfg.classes[0];
  const ct = cfg.classTeacher[cls];
  const ctRow = (cfg.bkey[cls] || []).find((r) => r.teacher === ct);
  const pairs = (cfg.bkey[cls] || []).filter((r) => r.teacher && !(cfg.combined || []).some((s) => s.name === r.teacher));
  const ruleAt = (p) => cfg.classRules?.[cls]?.[p];
  const encode = (r) => !r ? "" : r.kind === "ct" ? "ct" : `pair|${r.sub}|${r.teacher}`;
  const setRule = (p, val) => update((n) => {
    (n.classRules[cls] ||= {});
    const prev = n.classRules[cls][p] || {};
    if (!val) delete n.classRules[cls][p];
    else if (val === "ct") n.classRules[cls][p] = { kind: "ct", count: prev.count, days: prev.days };
    else { const [, sub, teacher] = val.split("|"); n.classRules[cls][p] = { kind: "pair", sub, teacher, count: prev.count, days: prev.days }; }
    if (Object.keys(n.classRules[cls]).length === 0) delete n.classRules[cls];
  });
  const setOpt = (p, fn) => update((n) => { const r = n.classRules?.[cls]?.[p]; if (r) fn(r); });
  const toggleDay = (p, d) => setOpt(p, (r) => { const a = r.days || []; r.days = a.includes(d) ? a.filter((x) => x !== d) : cfg.days.filter((x) => a.includes(x) || x === d); if (!r.days.length) delete r.days; });
  const applyCTAll = () => update((n) => { for (const x of n.classes) { (n.classRules[x] ||= {}); n.classRules[x][1] = { kind: "ct", count: bulkCount === "all" ? undefined : +bulkCount }; } });
  const clearCTAll = () => update((n) => { for (const x of n.classes) if (n.classRules[x]) { delete n.classRules[x][1]; if (Object.keys(n.classRules[x]).length === 0) delete n.classRules[x]; } });
  const dayOpts = [["all", "every day"], ...Array.from({ length: cfg.days.length }, (_, i) => [String(i + 1), `${i + 1} day${i ? "s" : ""} a week`])];

  return (
    <div style={{ ...card, marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderBottom: `1px solid ${C.line}`, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Class-specific period rules</span>
        <label style={{ fontSize: 12, color: C.sub, marginLeft: "auto" }}>Class&nbsp;
          <select className="tt-sel" style={{ width: 100, display: "inline-block" }} value={cls} onChange={(e) => setC(e.target.value)}>{cfg.classes.map((x) => <option key={x}>{x}</option>)}</select>
        </label>
        <span style={{ fontSize: 12, color: C.sub }}>Class teacher: <b style={{ fontFamily: mono, color: C.ink }}>{ct || "—"}</b>{ctRow ? ` (${ctRow.sub})` : ""}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: `1px solid ${C.line}` }}>
        <span style={{ fontSize: 12.5, color: C.sub, fontWeight: 700 }}>All classes: class teacher takes P1 on</span>
        <select className="tt-sel" style={{ width: 140 }} value={bulkCount} onChange={(e) => setBulkCount(e.target.value)}>{dayOpts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <button className="tt-btn" onClick={applyCTAll} style={solidBtn}>Apply to ALL classes</button>
        <button className="tt-btn" onClick={clearCTAll} style={ghostBtn}>Clear P1 rule (all)</button>
      </div>
      <div style={{ padding: 14, display: "grid", gap: 10 }}>
        {cfg.periods.map((p) => {
          const r = ruleAt(p);
          return (
            <div key={p} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", paddingBottom: r ? 8 : 0, borderBottom: r ? `1px dashed ${C.line}` : "none" }}>
              <span style={{ fontFamily: mono, fontWeight: 800, color: C.primary, width: 34 }}>P{p}</span>
              <select className="tt-sel" style={{ maxWidth: 300 }} value={encode(r)} onChange={(e) => setRule(p, e.target.value)}>
                <option value="">No rule — scheduler decides</option>
                {ct && <option value="ct">Class teacher{ctRow ? ` — ${ct} (${ctRow.sub})` : ` — ${ct}`}</option>}
                {pairs.map((x, i) => <option key={i} value={`pair|${x.sub}|${x.teacher}`}>{x.sub} — {x.teacher}</option>)}
              </select>
              {r && <>
                <select className="tt-sel" style={{ width: 140, opacity: r.days && r.days.length ? 0.45 : 1 }} disabled={!!(r.days && r.days.length)} value={r.count ? String(r.count) : "all"} onChange={(e) => setOpt(p, (x) => { if (e.target.value === "all") delete x.count; else x.count = +e.target.value; })}>{dayOpts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                <span style={{ fontSize: 11.5, color: C.sub }}>or only on:</span>
                {cfg.days.map((d) => { const on = (r.days || []).includes(d); return <button key={d} className="tt-btn" onClick={() => toggleDay(p, d)} style={{ padding: "3px 8px", borderRadius: 7, fontSize: 11.5, fontWeight: 700, cursor: "pointer", border: `1px solid ${on ? C.primary : C.line}`, background: on ? C.primary : "#fff", color: on ? "#fff" : C.sub }}>{d}</button>; })}
              </>}
            </div>
          );
        })}
      </div>
      <div className="tt-callout" style={{ margin: "0 14px 14px" }}>
        Pick how many days a week the ruled period applies (e.g. class teacher in P1 on 3 days) and the generator chooses the days — or tick exact days. On the other days that period is left free for other subjects. “Class teacher” means whatever subject the class teacher takes in {cls}. These are placed first, before other lessons.
      </div>
    </div>
  );
}

function CommonPeriodsPanel({ cfg, update }) {
  const [sub, setSub] = useState(cfg.subjects[0] || "");
  const [per, setPer] = useState(String(cfg.periods.length));
  const [days, setDays] = useState([]);
  const [classes, setClasses] = useState([]);
  const list = cfg.commonPeriods || [];
  const add = () => {
    if (!sub || !days.length || !classes.length) return;
    update((n) => { (n.commonPeriods ||= []).push({ id: Date.now(), sub, classes: [...classes], slots: days.map((d) => [d, +per]) }); });
    setDays([]);
  };
  const del = (id) => update((n) => { n.commonPeriods = (n.commonPeriods || []).filter((x) => x.id !== id); });
  const toggleDay = (d) => setDays((a) => (a.includes(d) ? a.filter((x) => x !== d) : cfg.days.filter((x) => a.includes(x) || x === d)));
  return (
    <div style={{ ...card, marginTop: 16 }}>
      <Panelhead text="Common periods — one subject at the same period for many classes" count={list.length} />
      <div style={{ padding: 14, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12.5, color: C.sub }}>Subject&nbsp;<select className="tt-sel" style={{ width: 110, display: "inline-block" }} value={sub} onChange={(e) => setSub(e.target.value)}>{cfg.subjects.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label style={{ fontSize: 12.5, color: C.sub }}>Period&nbsp;<select className="tt-sel" style={{ width: 70, display: "inline-block" }} value={per} onChange={(e) => setPer(e.target.value)}>{cfg.periods.map((p) => <option key={p} value={p}>P{p}</option>)}</select></label>
          <span style={{ fontSize: 12.5, color: C.sub }}>Days:</span>
          {cfg.days.map((d) => { const on = days.includes(d); return <button key={d} className="tt-btn" onClick={() => toggleDay(d)} style={{ padding: "4px 9px", borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer", border: `1px solid ${on ? C.primary : C.line}`, background: on ? C.primary : "#fff", color: on ? "#fff" : C.sub }}>{d}</button>; })}
        </div>
        <ChipPicker label="Classes" all={cfg.classes} selected={classes} onToggle={(v) => setClasses((a) => (a.includes(v) ? a.filter((x) => x !== v) : [...a, v]))} onSetAll={(a) => setClasses(a)} />
        <div><button className="tt-btn" onClick={add} style={solidBtn} disabled={!sub || !days.length || !classes.length}>Add common period</button></div>
        {list.length > 0 && (
          <div style={{ display: "grid", gap: 6 }}>
            {list.map((cp) => (
              <div key={cp.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: `1px solid ${C.line}`, borderLeft: `4px solid ${SUBJECT_BAR[cp.sub] || C.primary}`, borderRadius: 8, fontSize: 12.5 }}>
                <b style={{ fontFamily: mono }}>{cp.sub}</b>
                <span>{(cp.slots || []).map(([d, p]) => `${d} P${p}`).join(", ")}</span>
                <span style={{ color: C.sub }}>· {cp.classes.length} class{cp.classes.length > 1 ? "es" : ""}</span>
                <button className="tt-btn" onClick={() => del(cp.id)} style={{ ...ghostBtn, marginLeft: "auto", color: C.clash, padding: "3px 9px" }}>Remove</button>
              </div>
            ))}
          </div>
        )}
        <div className="tt-callout">
          Each class gets the subject at that period with its own mapped teacher (or with no teacher, for activities like assembly). One teacher can't be in several classes at once — if the same teacher teaches this subject to many of the selected classes, make it a Combined subject instead. Common periods are placed before everything else, and count towards the subject's weekly periods.
        </div>
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
  if ((cfg.combined || []).length) L.push(`Combined (parallel) subjects: ` + cfg.combined.map((s) => `${s.name} [teachers ${s.teachers.join("/")}; divisions ${s.divisions.join("/")}]`).join("; "));
  const rl = Object.entries(cfg.rules || {}).filter(([, v]) => v && Object.keys(v).length);
  if (rl.length) L.push(`Scheduling rules: ` + rl.map(([s, v]) => `${s}{${[v.pin ? "pin P" + v.pin : "", v.forbid?.length ? "never P" + v.forbid.join("/P") : "", v.band ? v.band : "", v.distinct ? "distinct-periods" : ""].filter(Boolean).join(",")}}`).join("; "));
  const crl = Object.entries(cfg.classRules || {}).filter(([, v]) => v && Object.keys(v).length);
  if (crl.length) L.push(`Class period rules: ` + crl.map(([c, m]) => `${c}{` + Object.entries(m).map(([p, r]) => `P${p}=${r.kind === "ct" ? "classteacher(" + (cfg.classTeacher[c] || "?") + ")" : r.sub + "/" + r.teacher}`).join(",") + `}`).join("; "));
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
      <p className="tt-callout" style={{ marginTop: 12 }}>The assistant can read the whole timetable and make edits on request. Review changes in the Class or Assign views — use Reset if an edit isn't what you wanted.</p>
    </div>
  );
}

/* ---------------- Combined subjects (any subject) ---------------- */
function CombinedView({ cfg, update, ask, mobile, occupancy, teacherLoad }) {
  const sessions = cfg.combined || [];
  const [sel, setSel] = useState(0);
  const i = Math.min(sel, Math.max(0, sessions.length - 1));
  const s = sessions[i];

  const editS = (fn) => update((n) => { fn(n.combined[i]); });
  const addSession = () => { update((n) => { (n.combined ||= []); let k = n.combined.length + 1; while (n.combined.some((x) => x.name === `COMBINED ${k}`)) k++; n.combined.push({ name: `COMBINED ${k}`, sub: n.subjects[0] || "", teachers: [], divisions: [] }); }); setSel(sessions.length); };
  const delSession = () => ask(`Remove combined session “${s.name}”? It will be cleared from any timetable slots that use it.`, () => update((n) => {
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
  const [cMsg, setCMsg] = useState(null);
  const setArr = (field, arr) => editS((x) => { x[field] = arr.slice(); });

  // scheduling: a session is "at" (d,p) if every member division has it there
  const scheduledAt = (d, p) => s && s.divisions.length > 0 && s.divisions.every((c) => cfg.grid[c]?.[d]?.[p]?.[0] === s.name);
  const toggleSlot = (d, p) => update((n) => {
    const ses = n.combined[i]; const on = ses.divisions.every((c) => n.grid[c]?.[d]?.[p]?.[0] === ses.name);
    for (const c of ses.divisions) { if (!n.grid[c]) continue; n.grid[c][d][p] = on ? [null, null] : [ses.name, ses.sub]; }
    const pn = p + 1; ses.slots = (ses.slots || []).filter(([dd, pp]) => !(dd === d && pp === pn));
    if (!on) ses.slots.push([d, pn]);
    if (!ses.slots.length) delete ses.slots;
  });
  // detection: a member teacher already teaching a REGULAR class in this slot = real clash
  const teacherClashAt = (d, p) => {
    if (!s) return null;
    const myG = combGroupOf(s); const byName = {}; (cfg.combined || []).forEach((x) => (byName[x.name] = x));
    for (const t of s.teachers) { const e = occupancy?.[d]?.[p]?.tok?.get(t); if (!e) continue; if (e.norm && e.norm.size > 0) return t; if ([...e.comb].some((b) => b !== s.name && combGroupOf(byName[b]) !== myG)) return t; }
    return null;
  };
  // a member division already has a different subject in this slot (would be overwritten)
  const overwriteAt = (d, p) => s ? s.divisions.filter((c) => { const cell = cfg.grid[c]?.[d]?.[p]; return cell && cell[0] && cell[0] !== s.name; }) : [];
  const saveSession = () => {
    if (!s) return;
    const todo = [];
    if (!s.name.trim()) todo.push("give it a name");
    if (!s.sub) todo.push("choose a subject");
    if (!s.teachers.length) todo.push("pick at least one teacher");
    if (!s.divisions.length) todo.push("pick the class(es)");
    else if (s.divisions.length < 2 && s.teachers.length < 2) todo.push("pick 2 or more classes to merge (or 2 or more teachers for one class)");
    let placed = 0; for (const d of cfg.days) cfg.periods.forEach((_, pi) => { if (scheduledAt(d, pi)) placed++; });
    update((n) => { n.savedAt = new Date().toISOString(); });
    setCMsg(todo.length
      ? { tone: "warn", text: `Saved “${s.name}” — still to do: ${todo.join("; ")}.` }
      : { tone: "primary", text: `Saved “${s.name}”: ${s.sub}, ${s.teachers.length} teacher(s), ${s.divisions.length} divisions, placed in ${placed} slot(s)${placed ? "." : " — not placed yet (use the grid below, or Fill remaining in Assign)."}` });
  };

  // ---- fast block mapping: act on the whole group (sessions that run together) ----
  const [wholeGroup, setWholeGroup] = useState(true);
  const byName = {}; sessions.forEach((x) => (byName[x.name] = x));
  const myG = s ? combGroupOf(s) : "";
  const groupAll = s ? sessions.filter((x) => combGroupOf(x) === myG) : [];
  const gSes = s ? (wholeGroup ? groupAll : [s]) : [];
  const gDivs = [...new Set(gSes.flatMap((x) => x.divisions))].filter((c) => cfg.grid[c]).sort(cmpClass);
  const gTeach = [...new Set(gSes.flatMap((x) => x.teachers))];
  const gNeed = gSes.length ? Math.max(...gSes.map((x) => Number(x.perWeek) || periodsFor(cfg, x.divisions[0] || cfg.classes[0], x.sub))) : 0;
  const runningAt = (d, pi) => gDivs.length > 0 && gDivs.every((c) => gSes.some((x) => x.divisions.includes(c) && cfg.grid[c]?.[d]?.[pi]?.[0] === x.name));
  const slotInfo = (d, pi) => {
    const TD = cfg.teacherDays || {};
    const off = gTeach.filter((t) => TD[t] && TD[t].length && !TD[t].includes(d));
    const clash = gTeach.filter((t) => { const e = occupancy?.[d]?.[pi]?.tok?.get(t); if (!e) return false; if (e.norm && e.norm.size) return true; return [...e.comb].some((b) => { const x = byName[b]; return x && !gSes.includes(x) && combGroupOf(x) !== myG; }); });
    const inOther = gDivs.filter((c) => { const cell = cfg.grid[c]?.[d]?.[pi]; return cell && cell[0] && byName[cell[0]] && !gSes.some((x) => x.name === cell[0]); }).map((c) => `${c} (${cfg.grid[c][d][pi][0]})`);
    const busy = gDivs.filter((c) => { const cell = cfg.grid[c]?.[d]?.[pi]; return cell && cell[0] && !byName[cell[0]] && !gSes.some((x) => x.name === cell[0]); });
    const locked = gDivs.filter((c) => cfg.locked?.[`${c}|${d}|${pi}`] || pi >= classPeriods(cfg, c));
    const r = cfg.rules?.[s?.sub] || {};
    const ruleNo = (r.pin && r.pin !== pi + 1) || (r.forbid && r.forbid.includes(pi + 1));
    return { off, clash, busy, inOther, locked, ruleNo, clean: !off.length && !clash.length && !busy.length && !inOther.length && !locked.length && !ruleNo };
  };
  let gPlaced = 0; const gDaysUsed = new Set();
  cfg.days.forEach((d) => cfg.periods.forEach((_, pi) => { if (runningAt(d, pi)) { gPlaced++; gDaysUsed.add(d); } }));
  const placeAt = (list) => update((n) => {
    for (const [d, pi] of list) for (const x of gSes) {
      const ses = n.combined.find((y) => y.name === x.name); if (!ses) continue;
      for (const c of ses.divisions) { if (!n.grid[c] || n.locked?.[`${c}|${d}|${pi}`] || pi >= classPeriods(n, c)) continue; const cur = n.grid[c][d][pi][0]; if (cur && cur !== ses.name && n.combined.some((y) => y.name === cur)) continue; n.grid[c][d][pi] = [ses.name, ses.sub]; }
      ses.slots = (ses.slots || []).filter(([dd, pp]) => !(dd === d && pp === pi + 1)); ses.slots.push([d, pi + 1]);
    }
  });
  const removeAt = (list) => update((n) => {
    for (const [d, pi] of list) for (const x of gSes) {
      const ses = n.combined.find((y) => y.name === x.name); if (!ses) continue;
      for (const c of ses.divisions) { const cell = n.grid[c]?.[d]?.[pi]; if (cell && cell[0] === ses.name) n.grid[c][d][pi] = [null, null]; }
      ses.slots = (ses.slots || []).filter(([dd, pp]) => !(dd === d && pp === pi + 1)); if (!ses.slots.length) delete ses.slots;
    }
  });
  const clickSlot = (d, pi) => {
    if (runningAt(d, pi)) { removeAt([[d, pi]]); return; }
    const info = slotInfo(d, pi);
    const probs = [];
    if (info.clash.length || info.off.length || info.inOther.length) {
      setCMsg({ tone: "warn", text: `Can't place on ${d} P${pi + 1}: ${[info.clash.length ? `${info.clash.join(", ")} already teaching then` : "", info.off.length ? `${info.off.join(", ")} not working on ${d}` : "", info.inOther.length ? `${info.inOther.join(", ")} already in another combined session then` : ""].filter(Boolean).join("; ")}. Pick a “+” slot, or press Auto-place remaining.` });
      return;
    }
    if (info.busy.length) probs.push(`${info.busy.join(", ")} already ha${info.busy.length > 1 ? "ve" : "s"} a lesson here (it will be replaced)`);
    if (info.locked.length) probs.push(`${info.locked.join(", ")} locked (skipped)`);
    if (info.ruleNo) probs.push(`a scheduling rule keeps ${s.sub} out of P${pi + 1}`);
    if (probs.length) ask(`Place ${wholeGroup && groupAll.length > 1 ? `the whole "${myG}" block` : `"${s.name}"`} on ${d} P${pi + 1}? — ${probs.join("; ")}.`, () => placeAt([[d, pi]]));
    else placeAt([[d, pi]]);
  };
  const autoPlace = () => {
    const want = gNeed - gPlaced; if (want <= 0) { setCMsg({ tone: "primary", text: `"${myG}" already has all ${gNeed} period(s).` }); return; }
    const pick = []; const used = new Set(gDaysUsed);
    for (const pass of [0, 1]) for (const d of cfg.days) {
      if (pick.length >= want) break;
      if (pass === 0 && used.has(d)) continue;
      const ruled = (pi) => gDivs.some((c) => cfg.classRules?.[c]?.[pi + 1]);
      const order = cfg.periods.map((_, pi) => pi).sort((a, b) => (ruled(a) ? 100 : 0) + a - ((ruled(b) ? 100 : 0) + b));
      for (const pi of order) {
        if (pick.length >= want) break;
        if (runningAt(d, pi) || pick.some(([a, b]) => a === d && b === pi)) continue;
        if (slotInfo(d, pi).clean) { pick.push([d, pi]); used.add(d); break; }
      }
    }
    if (pick.length) placeAt(pick);
    setCMsg(pick.length === want ? { tone: "primary", text: `Placed ${pick.length} more slot(s) for "${wholeGroup ? myG : s.name}" with no clashes: ${pick.map(([d, pi]) => `${d} P${pi + 1}`).join(", ")}.` }
      : { tone: "warn", text: `Placed ${pick.length} of ${want} in free slots. There's no other time when all ${gDivs.length} classes and ${gTeach.length} teachers are free together — press “Make room” to move ordinary lessons aside (they are placed again automatically).`, room: true });
  };
  const makeRoom = () => ask("Make room for the combined sessions? Ordinary lessons are moved to other free times where needed. Locked slots, rules and combined sessions already placed stay.", () => {
    setTimeout(() => {
      try {
        const res = autoSchedule(cfg, "gaps", null, { softKeep: true });
        update((n) => { n.grid = res.grid; });
        setCMsg(res.unplaced ? { tone: "warn", text: `Made room. ${res.unplaced} period(s) could not be placed again without breaking a rule: ${res.missing.slice(0, 6).join(", ")}.` } : { tone: "primary", text: "Made room: combined sessions placed and all moved lessons placed again with no clashes." });
      } catch (e) { setCMsg({ tone: "warn", text: "Couldn't make room: " + ((e && e.message) || e) }); }
    }, 50);
  });
  const fixAll = () => ask("Fix all clashes? The periods that collide are taken out and placed again at free times. Locked slots, rules and everything else stay.", () => {
    setTimeout(() => {
      try {
        const f = fixAllClashes(cfg);
        update((n) => { n.grid = f.grid; n.combined = f.combined; });
        setCMsg(f.res.unplaced ? { tone: "warn", text: `Fixed ${f.removed.length} clashing period(s). ${f.res.unplaced} could not be placed again: ${f.res.missing.slice(0, 6).join(", ")}.` } : { tone: "primary", text: `Fixed: ${f.removed.length} clashing period(s) moved to free times. No clashes left.` });
      } catch (e) { setCMsg({ tone: "warn", text: "Couldn't fix: " + ((e && e.message) || e) }); }
    }, 50);
  });
  const setupIssues = useMemo(() => {
    const out = [];
    const groups = combGroups(cfg);
    for (const gr of Object.values(groups)) {
      const seen = {};
      for (const x of gr.sessions) for (const c of x.divisions) { if (seen[c] && seen[c] !== x.name) out.push({ bad: true, text: `${c} is in both “${seen[c]}” and “${x.name}”, which run together (block ${gr.name}). A class can be in only one session of a block — remove it from one.` }); else seen[c] = x.name; }
      const days = cfg.days.filter((d) => [...gr.teachers].every((t) => !(cfg.teacherDays?.[t]?.length) || cfg.teacherDays[t].includes(d)));
      if (gr.teachers.size && !days.length) out.push({ bad: true, text: `Block ${gr.name}: its teachers have no working day in common, so it can never be placed.` });
      else if (gr.teachers.size && days.length < Math.min(gr.need, cfg.days.length)) out.push({ bad: false, text: `Block ${gr.name}: its teachers share only ${days.length} working day(s) for ${gr.need} period(s) — some days will have it twice.` });
    }
    const subBlocks = {};
    for (const gr of Object.values(groups)) for (const x of gr.sessions) for (const c of x.divisions) (subBlocks[c + "|" + x.sub] || (subBlocks[c + "|" + x.sub] = new Set())).add(gr.name);
    for (const [k, set] of Object.entries(subBlocks)) if (set.size > 1) { const [c, sub] = k.split("|"); out.push({ bad: false, text: `${c} has ${sub} in ${set.size} different blocks (${[...set].join(", ")}), so it gets the periods of each. If that's not intended, keep it in one.` }); }
    for (const x of sessions) { if (!x.teachers.length) out.push({ bad: false, text: `“${x.name}” has no teacher yet.` }); if (!x.divisions.length) out.push({ bad: false, text: `“${x.name}” has no class yet.` }); }
    for (const t of new Set(sessions.flatMap((x) => x.teachers))) { const L = teacherLoad?.[t]; const cap = teacherCap(cfg, t); if (L && L.target > cap) out.push({ bad: true, text: `${t} needs ${L.target} periods (combined + own classes) but has only ${cap} in the week — take them out of a session or reduce periods.` }); }
    return out;
  }, [cfg, teacherLoad]);
  const clearBlock = () => ask(`Remove every placed slot of ${wholeGroup && groupAll.length > 1 ? `the "${myG}" block` : `"${s.name}"`}?`, () => {
    const list = []; cfg.days.forEach((d) => cfg.periods.forEach((_, pi) => list.push([d, pi]))); removeAt(list);
  });

  // ---- clash & overlap check across all combined sessions ----
  const overlap = useMemo(() => {
    const tIn = {}, dIn = {};
    for (const x of sessions) { x.teachers.forEach((t) => (tIn[t] ||= []).push(x)); x.divisions.forEach((c) => (dIn[c] ||= []).push(x)); }
    const cross = (m) => Object.entries(m).filter(([, xs]) => new Set(xs.map(combGroupOf)).size > 1).map(([k, xs]) => ({ k, groups: [...new Set(xs.map(combGroupOf))], names: xs.map((x) => x.name) }));
    const live = []; const bad = new Set();
    for (const d of cfg.days) for (let pi = 0; pi < cfg.periods.length; pi++) {
      const m = occupancy?.[d]?.[pi]?.tok; if (!m) continue;
      for (const [t, e] of m) {
        if (!e.comb || !e.comb.size) continue;
        const gs = new Set([...e.comb].map((b) => combGroupOf(byName[b])));
        if ((e.norm && e.norm.size) || gs.size > 1) {
          live.push({ t, d, pi, what: [...[...e.comb].map((b) => `${b}`), ...(e.norm ? [...e.norm] : [])] });
          e.comb.forEach((b) => bad.add(b));
        }
      }
    }
    return { tCross: cross(tIn), dCross: cross(dIn), live, bad };
  }, [cfg, occupancy]);
  const sharedNote = s ? s.teachers.map((t) => ({ t, others: sessions.filter((x) => x !== s && x.teachers.includes(t)) })).filter((x) => x.others.length) : [];

  return (
    <div>
      <ViewHeader title="Combined subjects" note="Combine any subject: merge several classes for one teacher (e.g. PET for 5 A + 5 B), put two or more teachers in one class together (e.g. an IT lab), or build a language-style block where several groups run at the same time. Placing a session fills every class in it at once." />
      {cMsg && <Banner tone={cMsg.tone}>{cMsg.text}{cMsg.room && <button className="tt-btn" onClick={makeRoom} style={{ ...solidBtn, marginLeft: 10, padding: "5px 11px" }}>Make room</button>}</Banner>}
      {sessions.length > 0 && (overlap.live.length > 0 || setupIssues.length > 0) && (
        <div style={{ ...card, marginBottom: 16 }}>
          <Panelhead text="Setup & clash check" count={overlap.live.length ? `${overlap.live.length} clash${overlap.live.length > 1 ? "es" : ""}` : setupIssues.some((x) => x.bad) ? "setup problems" : "no clashes"} tone={overlap.live.length || setupIssues.some((x) => x.bad) ? undefined : "free"} />
          <div style={{ padding: "10px 14px", display: "grid", gap: 8, fontSize: 12.5, lineHeight: 1.55 }}>
            {overlap.live.length > 0 && <div><button className="tt-btn" onClick={fixAll} style={solidBtn}>Fix all clashes</button> <span style={{ fontSize: 11.5, color: C.sub }}>moves only what collides; locked slots and rules stay</span></div>}
            {setupIssues.map((x, k) => <div key={"s" + k} style={{ color: x.bad ? C.clash : C.warn }}>{x.bad ? "✖ " : "• "}{x.text}</div>)}
            {overlap.live.slice(0, 12).map((x, k) => (
              <div key={k} style={{ color: C.clash }}>⚠ <b style={{ fontFamily: mono }}>{x.t}</b> on {x.d} P{x.pi + 1} is in {x.what.join(" + ")} at the same time.</div>
            ))}
            {overlap.live.length > 12 && <div style={{ color: C.clash }}>… +{overlap.live.length - 12} more clashes</div>}

          </div>
        </div>
      )}
      {sessions.length > 0 && !overlap.live.length && (overlap.tCross.length > 0 || overlap.dCross.length > 0) && (
        <div className="tt-callout" style={{ margin: "-4px 0 14px" }}>
          ⓘ In more than one session (this is fine — they always get different times, nothing to do):{" "}
          {overlap.dCross.length > 0 && <>classes <b style={{ fontFamily: mono }}>{overlap.dCross.map((x) => x.k).sort(cmpClass).join(", ")}</b></>}
          {overlap.dCross.length > 0 && overlap.tCross.length > 0 && "; "}
          {overlap.tCross.length > 0 && <>teachers <b style={{ fontFamily: mono }}>{overlap.tCross.map((x) => x.k).join(", ")}</b></>}.
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "210px minmax(0,1fr)", gap: 16, alignItems: "start" }}>
        <div style={card}>
          <Panelhead text="Sessions" count={sessions.length} />
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {sessions.map((x, k) => (
              <div key={k} onClick={() => { setSel(k); setCMsg(null); }} style={{ padding: "9px 14px", cursor: "pointer", fontFamily: mono, fontSize: 12.5, fontWeight: k === i ? 700 : 500, color: k === i ? C.primary : C.ink, background: k === i ? C.primarySoft : "transparent", borderLeft: k === i ? `3px solid ${C.primary}` : "3px solid transparent" }}>
                {x.name}{overlap.bad.has(x.name) && <span title="In a live clash" style={{ color: C.clash, marginLeft: 6 }}>⚠</span>}<div style={{ fontSize: 10.5, color: C.sub, fontWeight: 500 }}>{x.sub} · group {combGroupOf(x)} · {x.teachers.length} teachers · {x.divisions.length} div</div>
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
                <button className="tt-btn" onClick={saveSession} style={{ ...solidBtn, marginLeft: "auto" }}>Save</button>
                <button className="tt-btn" onClick={delSession} style={{ ...ghostBtn, color: C.clash }}>Remove session</button>
              </div>
              <div style={{ padding: 14, display: "grid", gap: 14 }}>
                <ChipPicker label="Teachers in this session" all={cfg.singles} selected={s.teachers} onToggle={(v) => toggleArr("teachers", v)} onSetAll={(a) => setArr("teachers", a)} />
                {sharedNote.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: -6 }}>
                    {sharedNote.map(({ t, others }) => { const diff = others.filter((x) => combGroupOf(x) !== myG); return (
                      <span key={t} title={others.map((x) => `${x.name} (group ${combGroupOf(x)})`).join("\n")} style={{ fontSize: 11.5, padding: "3px 8px", borderRadius: 8, background: diff.length ? C.warnSoft : C.freeSoft, color: diff.length ? C.warn : C.free, fontWeight: 600 }}>
                        <b style={{ fontFamily: mono }}>{t}</b> {diff.length ? `⚠ also in ${diff.map((x) => x.name).join(", ")} (other group)` : `✓ also in ${others.length} session${others.length > 1 ? "s" : ""} of this block`}
                      </span>); })}
                  </div>
                )}
                <ChipPicker label="Classes in this session" all={cfg.classes} selected={s.divisions} onToggle={(v) => toggleArr("divisions", v)} onSetAll={(a) => setArr("divisions", a)} />
                <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", paddingTop: 4 }}>
                  <label style={{ fontSize: 12.5, color: C.sub }}>Periods / week&nbsp;
                    <input className="tt-in" type="number" min={0} max={40} style={{ width: 70, display: "inline-block", textAlign: "center" }} placeholder={String(periodsFor(cfg, s.divisions[0] || cfg.classes[0], s.sub) || "")} value={s.perWeek || ""} onChange={(e) => { const v = e.target.value; editS((x) => { if (v === "" || +v <= 0) delete x.perWeek; else x.perWeek = +v; }); }} />
                  </label>
                  <label style={{ fontSize: 12.5, color: C.sub }}>Runs&nbsp;
                    <select className="tt-sel" style={{ width: 230, display: "inline-block" }} value={!s.group ? "__own" : s.group === stdBlockName(s) ? "__sub" : "__custom"} onChange={(e) => { const v = e.target.value; editS((x) => { if (v === "__own") delete x.group; else if (v === "__sub") x.group = stdBlockName(x); else x.group = x.group && x.group !== stdBlockName(x) ? x.group : x.name + " block"; }); }}>
                      <option value="__own">on its own</option>
                      <option value="__sub">together with the other {stdBlockName(s)} sessions</option>
                      <option value="__custom">together with a named block…</option>
                    </select>
                  </label>
                  {s.group && s.group !== stdBlockName(s) && (
                    <label style={{ fontSize: 12.5, color: C.sub }}>Block name&nbsp;
                      <input className="tt-in" list="tt-comb-groups" style={{ width: 130, display: "inline-block" }} value={s.group} onChange={(e) => { const v = e.target.value; editS((x) => { x.group = v; }); }} />
                      <datalist id="tt-comb-groups">{[...new Set((cfg.combined || []).map((x) => (x.group || "").trim()).filter(Boolean))].map((g) => <option key={g} value={g} />)}</datalist>
                    </label>
                  )}
                  {(s.slots || []).length > 0 && <span style={{ fontSize: 12, color: C.primary, fontWeight: 700 }}>Fixed slots: {s.slots.map(([d, p]) => `${d} P${p}`).join(", ")}</span>}
                </div>
                <div style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.55 }}>Periods/week blank = all of the standard's {s.sub} periods are combined. Put a smaller number to combine only some — the rest are taught normally from each class's mapping (e.g. PET 2 a week: 1 combined, 1 separate). “On its own”: this session gets its own slots and never overlaps other sessions. “Together”: sessions in the same block always run in the same slots (language-style), so a teacher shared between them is counted once. Slots you mark in the grid below are kept when you regenerate.</div>
              </div>
            </div>

            <div style={card}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderBottom: `1px solid ${C.line}`, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>When does it run?</span>
                {groupAll.length > 1 && (
                  <label style={{ fontSize: 12.5, color: C.sub, display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" checked={wholeGroup} onChange={(e) => setWholeGroup(e.target.checked)} /> place the whole “{myG}” block ({groupAll.length} sessions) together
                  </label>
                )}
                <span style={{ marginLeft: "auto", fontSize: 12.5, fontWeight: 700, color: gPlaced >= gNeed ? C.free : C.warn }}>{gPlaced} / {gNeed} placed</span>
                <button className="tt-btn" onClick={autoPlace} style={solidBtn}>Auto-place remaining</button>
                <button className="tt-btn" onClick={clearBlock} style={{ ...ghostBtn, color: C.clash }}>Clear</button>
              </div>
              <div style={{ padding: "8px 14px 0", fontSize: 11.5, color: C.sub }}>
                {gDivs.length} divisions · teachers {gTeach.join(", ") || "—"} · days used: {cfg.days.filter((d) => gDaysUsed.has(d)).join(", ") || "none yet"}
              </div>
              <div style={{ overflowX: "auto", padding: 12 }}>
                <table style={{ ...tbl, minWidth: 560 }}>
                  <thead><tr><th style={{ ...th, width: 44 }}>P</th>{cfg.days.map((d) => <th key={d} style={{ ...th, background: gDaysUsed.has(d) ? C.accentSoft : undefined }}>{DAY_FULL[d].slice(0, 3)}</th>)}</tr></thead>
                  <tbody>
                    {cfg.periods.map((p, pi) => (
                      <tr key={p}><td style={perTd}>{p}</td>
                        {cfg.days.map((d) => {
                          const on = runningAt(d, pi);
                          const f = on ? null : slotInfo(d, pi);
                          let bg = "#fff", bd = null, label = <span style={{ color: C.free, fontWeight: 800, fontSize: 13 }}>+</span>, tip = "Free for every division and teacher — click to place";
                          if (on) { bg = C.accentSoft; bd = C.accent; label = <span style={{ color: C.accent, fontWeight: 800, fontSize: 11 }}>✓ running</span>; tip = "Running — click to remove"; }
                          else if (f.clash.length) { bg = C.clashSoft; bd = C.clash; label = <span style={{ color: C.clash, fontWeight: 800, fontSize: 10.5 }}>⚠ {f.clash.slice(0, 2).join(" ")}{f.clash.length > 2 ? "…" : ""}</span>; tip = `Clash: ${f.clash.join(", ")} already teaching`; }
                          else if (f.inOther.length) { bg = C.clashSoft; bd = C.clash; label = <span style={{ color: C.clash, fontWeight: 700, fontSize: 10.5 }}>{f.inOther[0].split(" (")[0]}: {f.inOther[0].split("(")[1].replace(")", "").slice(0, 10)}</span>; tip = `Already in another combined session: ${f.inOther.join(", ")}`; }
                          else if (f.off.length) { bg = C.clashSoft; bd = C.clash; label = <span style={{ color: C.clash, fontWeight: 700, fontSize: 10.5 }}>off: {f.off.slice(0, 2).join(" ")}</span>; tip = `${f.off.join(", ")} not working this day`; }
                          else if (f.locked.length) { bg = "#f1f3f6"; label = <span style={{ color: C.sub, fontSize: 11 }}>🔒 {f.locked.length}</span>; tip = `Locked in ${f.locked.join(", ")}`; }
                          else if (f.busy.length) { bg = C.warnSoft; bd = C.warn; label = <span style={{ color: C.warn, fontWeight: 700, fontSize: 10.5 }}>{f.busy.length} busy</span>; tip = `Already has a lesson: ${f.busy.join(", ")}`; }
                          else if (f.ruleNo) { bg = "#f6f6f6"; label = <span style={{ color: C.sub, fontSize: 11 }}>rule</span>; tip = `A scheduling rule keeps ${s.sub} out of this period`; }
                          return <td key={d} onClick={() => clickSlot(d, pi)} title={tip} style={{ ...cellTd, height: 40, cursor: "pointer", background: bg, boxShadow: bd ? `inset 0 0 0 2px ${bd}` : "none" }}>{label}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: "0 14px 12px", fontSize: 11.5, color: C.sub, lineHeight: 1.7 }}>
                <b style={{ color: C.free }}>+</b> ready · <b style={{ color: C.accent }}>✓</b> running · <b style={{ color: C.clash }}>⚠ name</b> that teacher is already teaching · <b style={{ color: C.clash }}>off</b> teacher's day off · <b style={{ color: C.clash }}>7 A: LAN</b> that class is in another combined session then · <b style={{ color: C.warn }}>N busy</b> classes have an ordinary lesson (it moves aside) · 🔒 locked · <b>rule</b> blocked by a scheduling rule. Clicking a warning slot asks before placing. Placed slots are kept when you regenerate.
              </div>
            </div>
          </div>
        ) : <div style={{ ...card, padding: 24, color: C.sub }}>No combined subjects yet. Create one to merge divisions for a parallel period (language, PET, etc.).</div>}
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

// Periods with several teachers (e.g. "LAN/KVS PV SH") are combined periods: link each to its combined session
// (same class + subject, or same teachers), creating the session if needed. Then sessions that run in exactly
// the same periods and share a teacher are put in one block, so their shared teachers are not counted as clashing.
function relinkCombined(n) {
  n.combined = n.combined || [];
  const singles = new Set(n.singles || []);
  const findName = (code) => n.combined.find((x) => x.name === code) || n.combined.find((x) => x.name === baseName(code));
  const created = new Set(); let changed = 0;
  for (const c of n.classes || []) for (const d of n.days || []) (n.grid?.[c]?.[d] || []).forEach((sl) => {
    if (!sl || !sl[0] || !sl[1]) return;
    const named = findName(sl[0]);
    if (named) { if (named.sub === sl[1] && !named.divisions.includes(c)) { named.divisions.push(c); changed++; } if (named.name !== sl[0]) { sl[0] = named.name; changed++; } return; }
    const toks = String(sl[0]).trim().split(/\s+/).filter(Boolean);
    let s = n.combined.find((x) => x.sub === sl[1] && (x.divisions || []).includes(c) && (toks.length > 1 || (x.teachers.length === 1 && x.teachers[0] === toks[0])));
    if (!s && toks.length > 1) {
      const key = [...toks].sort().join(" ");
      s = n.combined.find((x) => x.sub === sl[1] && [...x.teachers].sort().join(" ") === key);
      if (!s) {
        let nm = sl[0], k = 2; while (n.combined.some((x) => x.name === nm)) nm = `${sl[0]} (${k++})`;
        s = { name: nm, sub: sl[1], teachers: toks.slice(), divisions: [] }; n.combined.push(s); created.add(s);
        for (const t of toks) if (!singles.has(t)) { singles.add(t); (n.singles ||= []).push(t); }
      }
      if (!s.divisions.includes(c)) s.divisions.push(c);
    }
    if (!s) return;
    if (sl[0] !== s.name) { sl[0] = s.name; changed++; }
  });
  for (const s of created) s.group = stdBlockName(s);
  if (created.size) (n.singles || []).sort();
  // sessions that always run together and share a teacher belong to one block
  const slotsOf = {}; for (const s of n.combined) slotsOf[s.name] = new Set();
  for (const c of n.classes || []) for (const d of n.days || []) (n.grid?.[c]?.[d] || []).forEach((sl, p) => { if (sl && sl[0] && slotsOf[sl[0]]) slotsOf[sl[0]].add(d + "|" + p); });
  const same = (a, b) => a.size > 0 && a.size === b.size && [...a].every((x) => b.has(x));
  for (let loop = 0; loop < 5; loop++) {
    let moved = false;
    for (const a of n.combined) for (const b of n.combined) {
      if (a === b || combGroupOf(a) === combGroupOf(b)) continue;
      if (!a.teachers.some((t) => b.teachers.includes(t)) || !same(slotsOf[a.name], slotsOf[b.name])) continue;
      const g = a.group || b.group || stdBlockName(a);
      for (const x of n.combined) if (x === a || x === b || (x.group && (x.group === a.group || x.group === b.group))) x.group = g;
      a.group = g; b.group = g; moved = true; changed++;
    }
    if (!moved) break;
  }
  return changed;
}

/* ---------------- Timetable import ---------------- */
function parseDelimited(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const first = lines.find((l) => l.trim()) || "";
  const delim = first.includes("\t") ? "\t" : first.split(";").length > first.split(",").length ? ";" : ",";
  const rows = []; let row = [], cell = "", q = false;
  const src = lines.join("\n");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"' && cell === "") { q = true; continue; }
    if (ch === delim) { row.push(cell); cell = ""; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows.map((r) => r.map((x) => String(x).trim())).filter((r) => r.some((x) => x !== ""));
}
const impKey = (s) => String(s || "").toUpperCase().replace(/[\s\-_.]/g, "");
function impDay(s) { const k = String(s || "").trim().slice(0, 3).toUpperCase(); return WEEK_ORDER.includes(k) ? k : null; }
function impClassName(s) { const m = String(s || "").trim().match(/^(\d+)\s*[-_ ]?\s*([A-Za-z]+)$/); return m ? `${m[1]} ${m[2].toUpperCase()}` : String(s || "").trim().toUpperCase(); }

// Read rows into timetable entries, matching classes/teachers/subjects to the current setup.
function parseTimetableImport(cfg, rows) {
  const out = { entries: [], newClasses: new Set(), newTeachers: new Set(), newSubjects: new Set(), badDays: new Set(), maxP: 0, format: "", error: "", skipped: 0 };
  const hi = rows.findIndex((r) => r.some((x) => /^class/i.test(x)));
  if (hi < 0) { out.error = "No header row found. The first row must name the columns: Class, Day, P1, P2, … (grid) or Class, Day, Period, Subject, Teacher (list)."; return out; }
  const h = rows[hi].map((x) => x.toLowerCase());
  const ci = h.findIndex((x) => /^class/.test(x)), di = h.findIndex((x) => /^day/.test(x));
  const pi = h.findIndex((x) => /^(period|pd|p)$/.test(x) || /^period\b/.test(x) && !/\d/.test(x));
  const si = h.findIndex((x) => /^sub/.test(x)), ti = h.findIndex((x) => /^(teacher|staff|faculty)/.test(x));
  const perCols = h.map((x, k) => { const m = x.match(/^(?:p|period|pd)?\s*(\d+)$/); return m && k !== ci && k !== di ? [k, +m[1]] : null; }).filter(Boolean);
  if (ci < 0 || di < 0) { out.error = "The header needs a Class column and a Day column."; return out; }
  const clsMap = {}; cfg.classes.forEach((c) => (clsMap[impKey(c)] = c));
  const tMap = {}; cfg.singles.forEach((t) => (tMap[t.toUpperCase()] = t));
  const sMap = {}; cfg.subjects.forEach((x) => (sMap[x.toUpperCase()] = x));
  const cm = {}; (cfg.combined || []).forEach((x) => (cm[x.name.toUpperCase()] = x));
  const sessByTeachers = {}; (cfg.combined || []).forEach((x) => (sessByTeachers[[...x.teachers].sort().join(" ").toUpperCase()] = x));
  const resolveClass = (raw) => { const k = impKey(raw); if (clsMap[k]) return clsMap[k]; const nm = impClassName(raw); out.newClasses.add(nm); clsMap[k] = nm; return nm; };
  const resolveTeacher = (raw, cls) => {
    const t = String(raw || "").trim(); if (!t) return null; const U = t.toUpperCase();
    if (cm[U]) return { code: cm[U].name, sub: cm[U].sub };
    if (tMap[U]) return { code: tMap[U] };
    const toks = U.split(/[\s,+&]+/).filter(Boolean);
    if (toks.length > 1) { const s = sessByTeachers[[...toks].sort().join(" ")]; if (s && s.divisions.includes(cls)) return { code: s.name, sub: s.sub }; toks.forEach((x) => { if (!tMap[x]) out.newTeachers.add(x); }); return { code: toks.map((x) => tMap[x] || x).join(" ") }; }
    out.newTeachers.add(U); return { code: U };
  };
  const resolveSub = (raw) => { const U = String(raw || "").trim().toUpperCase(); if (!U) return null; if (!sMap[U]) out.newSubjects.add(U); return sMap[U] || U; };
  const parseCell = (txt, cls) => {
    const v = String(txt || "").trim(); if (!v || v === "-" || v === "—") return null;
    let parts = v.split(/\s*[\/|\n]\s*|\s+-\s+/).filter(Boolean);
    if (parts.length === 1) { const U = v.toUpperCase(); if (cm[U] || tMap[U]) parts = [null, v]; else { const w = v.split(/\s+/); parts = w.length > 1 && sMap[w[0].toUpperCase()] ? [w[0], w.slice(1).join(" ")] : [v]; } }
    let sub, tea;
    if (parts.length === 1) { sub = parts[0]; tea = null; }
    else if (parts[0] === null) { tea = parts[1]; }
    else if (sMap[String(parts[0]).toUpperCase()] || !sMap[String(parts[parts.length - 1]).toUpperCase()]) { sub = parts[0]; tea = parts.slice(1).join(" "); }
    else { sub = parts[parts.length - 1]; tea = parts.slice(0, -1).join(" "); }
    const subGuess = sub ? String(sub).trim().toUpperCase() : null;
    const multi = tea && String(tea).trim().split(/[\s,+&]+/).filter(Boolean).length > 1;
    const sessHit = multi && subGuess ? (cfg.combined || []).find((x) => x.divisions.includes(cls) && String(x.sub).toUpperCase() === subGuess) : null;
    const T = sessHit ? { code: sessHit.name, sub: sessHit.sub } : tea ? resolveTeacher(tea, cls) : null;
    let S = sub ? resolveSub(sub) : (T && T.sub) || null;
    if (!S && T) { const row = (cfg.bkey[cls] || []).find((r) => r.teacher === T.code); S = row ? row.sub : null; }
    if (!S && !T) return null;
    return { code: T ? T.code : S, sub: S || "" };
  };
  const push = (clsRaw, dayRaw, p, cellOrSub, teacherRaw) => {
    const day = impDay(dayRaw); if (!day) { if (String(dayRaw).trim()) out.badDays.add(String(dayRaw).trim()); out.skipped++; return; }
    if (!(p >= 1)) { out.skipped++; return; }
    const cls = resolveClass(clsRaw);
    const r = teacherRaw === undefined ? parseCell(cellOrSub, cls) : (() => { const su = String(cellOrSub || "").trim().toUpperCase(); const multi = String(teacherRaw || "").trim().split(/[\s,+&]+/).filter(Boolean).length > 1; const hit = multi && su ? (cfg.combined || []).find((x) => x.divisions.includes(cls) && String(x.sub).toUpperCase() === su) : null; const T = hit ? { code: hit.name, sub: hit.sub } : resolveTeacher(teacherRaw, cls); const S = cellOrSub ? resolveSub(cellOrSub) : (T && T.sub) || null; if (!S && !T) return null; return { code: T ? T.code : S, sub: S || "" }; })();
    if (!r) return;
    out.maxP = Math.max(out.maxP, p);
    if (!cfg.days.includes(day)) { out.badDays.add(day); out.skipped++; return; }
    out.entries.push({ cls, day, p: p - 1, code: r.code, sub: r.sub });
  };
  const body = rows.slice(hi + 1);
  if (pi >= 0 && (si >= 0 || ti >= 0)) {
    out.format = "list";
    for (const r of body) { if (!r[ci]) continue; const pn = parseInt(String(r[pi]).replace(/\D/g, ""), 10); push(r[ci], r[di], pn, si >= 0 ? r[si] : "", ti >= 0 ? r[ti] : ""); }
  } else if (perCols.length) {
    out.format = "grid";
    for (const r of body) { if (!r[ci]) continue; for (const [k, pn] of perCols) push(r[ci], r[di], pn, r[k]); }
  } else out.error = "Couldn't tell the layout. Use period columns (P1, P2, …) or Period + Subject + Teacher columns.";
  return out;
}

// Put the parsed timetable into a config (mutates it). Replaces the timetable of every class in the file.
function applyTimetableImport(n, parsed, o) {
  if (o.addClasses) for (const c of parsed.newClasses) if (!n.classes.includes(c)) { n.classes.push(c); n.classTeacher[c] = null; n.bkey[c] = n.bkey[c] || []; n.grid[c] = {}; n.days.forEach((d) => (n.grid[c][d] = emptyDay(n.periods.length))); }
  if (o.extendPeriods && parsed.maxP > n.periods.length) { const N = Math.min(12, parsed.maxP); n.periods = Array.from({ length: N }, (_, i) => i + 1); for (const c of n.classes) for (const d of n.days) { const a = n.grid[c][d] || []; while (a.length < N) a.push([null, null]); n.grid[c][d] = a; } }
  if (o.addTeachers) { for (const t of parsed.newTeachers) if (!n.singles.includes(t)) n.singles.push(t); n.singles.sort(); }
  for (const s of parsed.newSubjects) if (!n.subjects.includes(s)) n.subjects.push(s);
  const touched = new Set(parsed.entries.map((e) => e.cls).filter((c) => n.grid[c]));
  for (const c of touched) for (const d of n.days) n.grid[c][d] = emptyDay(n.periods.length);
  let placed = 0;
  for (const e of parsed.entries) { if (!n.grid[e.cls] || !n.grid[e.cls][e.day] || e.p >= n.periods.length) continue; n.grid[e.cls][e.day][e.p] = [e.code, e.sub]; placed++; }
  if (o.updateMapping) for (const e of parsed.entries) {
    if (!n.grid[e.cls] || !e.sub || e.code === e.sub) continue;
    const rows = n.bkey[e.cls] || (n.bkey[e.cls] = []);
    if (!rows.some((r) => r.sub === e.sub && r.teacher === e.code)) { const blank = rows.find((r) => r.sub === e.sub && !r.teacher); if (blank) blank.teacher = e.code; else rows.push({ sub: e.sub, teacher: e.code }); }
  }
  relinkCombined(n);
  return { placed, classes: touched.size };
}

// Same clash rule as the header counter, usable on any config.
function computeClashList(cfg) {
  const singles = new Set(cfg.singles); const cm = {}; (cfg.combined || []).forEach((x) => (cm[x.name] = x));
  const kOf = (code) => (!code ? null : cm[code] ? code : cm[baseName(code)] ? baseName(code) : null);
  const toks = (code) => { const k = kOf(code); if (k) return cm[k].teachers.filter((t) => singles.has(t)); if (singles.has(code)) return [code]; return String(code).split(" ").filter((t) => singles.has(t)); };
  const out = [];
  for (const d of cfg.days) for (let p = 0; p < cfg.periods.length; p++) {
    const m = new Map();
    for (const c of cfg.classes) {
      const code = cfg.grid[c]?.[d]?.[p]?.[0]; if (!code) continue; const k = kOf(code);
      for (const t of toks(code)) { const e = m.get(t) || { norm: [], groups: new Set(), sessions: new Set() }; if (k) { e.groups.add(combGroupOf(cm[k])); e.sessions.add(k); } else e.norm.push(`${c} ${cfg.grid[c][d][p][1] || ""}`.trim()); m.set(t, e); }
    }
    for (const [t, e] of m) if (e.norm.length > 1 || (e.norm.length && e.groups.size) || e.groups.size > 1) out.push({ t, day: d, p, where: [...e.norm, ...[...e.sessions]] });
  }
  return out;
}

function exportTimetableCSV(cfg) {
  const q = (x) => { const s = String(x == null ? "" : x); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [["Class", "Day", ...cfg.periods.map((p) => "P" + p)].join(",")];
  for (const c of cfg.classes) for (const d of cfg.days) lines.push([c, d, ...cfg.periods.map((_, pi) => { const sl = cfg.grid[c]?.[d]?.[pi]; return sl && sl[0] ? (sl[0] === sl[1] ? sl[1] : `${sl[1]}/${sl[0]}`) : ""; })].map(q).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "timetable.csv"; a.click();
}

function ImportPanel({ cfg, update, ask }) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null);
  const [backup, setBackup] = useState(null);
  const [o, setO] = useState({ addClasses: true, addTeachers: true, extendPeriods: true, updateMapping: false });
  const [done, setDone] = useState("");
  const fileRef = useRef(null);
  const read = (t) => {
    setDone(""); setBackup(null); setParsed(null);
    const s = String(t || "").trim(); if (!s) return;
    if (s[0] === "{") { try { const j = JSON.parse(s); if (j && j.classes && j.grid && j.days) { setBackup(j); return; } } catch {} }
    setParsed(parseTimetableImport(cfg, parseDelimited(s)));
  };
  const onFile = async (f) => { if (!f) return; if (/\.xlsx?$/i.test(f.name)) { setParsed({ error: "Excel files: select the cells in Excel, copy, and paste them in the box below — or save the sheet as CSV." }); return; } const t = await f.text(); setText(t.length > 200000 ? "" : t); read(t); };
  const preview = useMemo(() => {
    if (!parsed || parsed.error || !parsed.entries) return null;
    const trial = clone(cfg); const r = applyTimetableImport(trial, parsed, o);
    return { ...r, clashes: computeClashList(trial) };
  }, [parsed, o, cfg]);
  const apply = () => ask(`Import this timetable? It replaces the timetable of the ${preview.classes} class(es) in the file. Other classes stay as they are.`, () => {
    let r; update((n) => { r = applyTimetableImport(n, parsed, o); });
    setDone(`Imported ${preview.placed} period(s) into ${preview.classes} class(es). ${preview.clashes.length ? `${preview.clashes.length} clash(es) — click the clash badge at the top to see and fix them.` : "No clashes."}`);
    setParsed(null); setText("");
  });
  const restore = () => ask("Restore this backup? EVERYTHING (classes, teachers, mapping, rules, combined subjects and timetable) is replaced by the backup.", () => {
    update((n) => { for (const k of Object.keys(n)) delete n[k]; Object.assign(n, clone(backup)); });
    setDone("Backup restored."); setBackup(null); setText("");
  });
  const Opt = ({ k, label }) => <label style={{ fontSize: 12.5, color: C.ink, display: "inline-flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={o[k]} onChange={(e) => setO({ ...o, [k]: e.target.checked })} />{label}</label>;
  return (
    <div style={{ ...card, padding: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>Import a timetable</div>
      <div className="tt-callout" style={{ marginBottom: 12 }}>
        Bring in a timetable made somewhere else and check it for clashes before using it. Paste cells copied from Excel / Google Sheets, or choose a CSV file. Two layouts work:
        <br /><b>Grid</b>: <code style={{ fontFamily: mono }}>Class, Day, P1, P2, …</code> — one row per class per day; cells like <code style={{ fontFamily: mono }}>ENG/DN</code>, <code style={{ fontFamily: mono }}>ENG DN</code> or a combined session name.
        <br /><b>List</b>: <code style={{ fontFamily: mono }}>Class, Day, Period, Subject, Teacher</code> — one row per period.
        <br />A full data backup (.json) can be restored here too.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.json,.xlsx,.xls" style={{ display: "none" }} onChange={(e) => { onFile(e.target.files && e.target.files[0]); e.target.value = ""; }} />
        <button className="tt-btn" onClick={() => fileRef.current && fileRef.current.click()} style={ghostBtn}>Choose file…</button>
        <button className="tt-btn" onClick={() => exportTimetableCSV(cfg)} style={ghostBtn}>Download current timetable (CSV template)</button>
      </div>
      <textarea className="tt-in" value={text} onChange={(e) => setText(e.target.value)} placeholder={"Paste here, e.g.\nClass\tDay\tP1\tP2\tP3\n5 A\tMON\tENG/DN\tMAT/KPM\tSS/MPS"} style={{ width: "100%", minHeight: 120, fontFamily: mono, resize: "vertical" }} />
      <div style={{ marginTop: 8 }}><button className="tt-btn" onClick={() => read(text)} style={solidBtn} disabled={!text.trim()}>Read & check</button></div>
      {done && <div style={{ marginTop: 12 }}><Banner tone="primary">{done}</Banner></div>}
      {backup && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: C.warnSoft, fontSize: 12.5, lineHeight: 1.6 }}>
          This is a full backup: {backup.classes.length} classes, {(backup.singles || []).length} teachers, {(backup.combined || []).length} combined sessions. Clashes in it: <b>{computeClashList(backup).length}</b>.
          <div style={{ marginTop: 8 }}><button className="tt-btn" onClick={restore} style={{ ...solidBtn, background: C.clash }}>Restore everything from this backup</button></div>
        </div>
      )}
      {parsed && parsed.error && <div style={{ marginTop: 12 }}><Banner tone="warn">{parsed.error}</Banner></div>}
      {preview && (
        <div style={{ marginTop: 12, border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, display: "grid", gap: 8, fontSize: 12.5, lineHeight: 1.6 }}>
          <div><b>Read {parsed.entries.length} period(s)</b> ({parsed.format} layout) for <b>{preview.classes}</b> class(es){parsed.skipped ? ` · ${parsed.skipped} row(s)/cell(s) skipped` : ""}.</div>
          {parsed.newClasses.size > 0 && <div style={{ color: C.warn }}>New classes: <b style={{ fontFamily: mono }}>{[...parsed.newClasses].sort(cmpClass).join(", ")}</b></div>}
          {parsed.newTeachers.size > 0 && <div style={{ color: C.warn }}>New teachers: <b style={{ fontFamily: mono }}>{[...parsed.newTeachers].sort().join(", ")}</b></div>}
          {parsed.newSubjects.size > 0 && <div style={{ color: C.warn }}>New subjects (will be added): <b style={{ fontFamily: mono }}>{[...parsed.newSubjects].join(", ")}</b></div>}
          {parsed.badDays.size > 0 && <div style={{ color: C.warn }}>Skipped days (not working days here): <b>{[...parsed.badDays].join(", ")}</b></div>}
          {parsed.maxP > cfg.periods.length && <div style={{ color: C.warn }}>The file has {parsed.maxP} periods a day; this timetable has {cfg.periods.length}.</div>}
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {parsed.newClasses.size > 0 && <Opt k="addClasses" label="add the new classes" />}
            {parsed.newTeachers.size > 0 && <Opt k="addTeachers" label="add the new teachers" />}
            {parsed.maxP > cfg.periods.length && <Opt k="extendPeriods" label={`use ${parsed.maxP} periods a day`} />}
            <Opt k="updateMapping" label="also add missing subject–teacher pairs to the mapping" />
          </div>
          <div style={{ padding: "9px 11px", borderRadius: 9, background: preview.clashes.length ? C.clashSoft : C.freeSoft, color: preview.clashes.length ? C.clash : C.free }}>
            <b>{preview.clashes.length ? `${preview.clashes.length} clash(es) in the imported timetable` : "No clashes in the imported timetable."}</b>
            {preview.clashes.length > 0 && (
              <div style={{ marginTop: 6, maxHeight: 220, overflowY: "auto", color: C.ink }}>
                {preview.clashes.map((x, k) => <div key={k} style={{ padding: "3px 0", borderBottom: `1px solid ${C.line}` }}><b style={{ fontFamily: mono }}>{x.t}</b> {x.day} P{x.p + 1}: {x.where.join("  +  ")}</div>)}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="tt-btn" onClick={apply} style={solidBtn}>Import this timetable</button>
            <button className="tt-btn" onClick={() => { setParsed(null); }} style={ghostBtn}>Cancel</button>
          </div>
          <div style={{ fontSize: 11.5, color: C.sub }}>After importing, the clash badge at the top lists every clash, and “Fix all clashes” can repair them.</div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Export / PDF ---------------- */
function ExportView({ cfg, update, ask, pubState, publishNow, mobile }) {
  const [paper, setPaper] = useState("A4");
  const [ov, setOv] = useState({ paper: "A3", orient: "landscape", cper: 40, tper: 24 });
  const th = CUR_TH || THEMES.teal;
  const Card = ({ title, desc, actions, icon }) => (
    <div style={{ ...card, padding: 18, position: "relative" }}>
      <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: `linear-gradient(180deg, ${th.g1}, ${th.g2})` }} />
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <span style={{ width: 40, height: 40, borderRadius: 12, display: "grid", placeItems: "center", background: `${th.accent}14`, color: th.accent, flexShrink: 0 }}><Icon name={icon || "export"} size={19} /></span>
        <div style={{ fontSize: 15.5, fontWeight: 800, color: C.ink }}>{title}</div>
      </div>
      <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 14, lineHeight: 1.6 }}>{desc}</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{actions}</div>
    </div>
  );
  return (
    <div>
      <ViewHeader title="Import / Export" note="Import a timetable from another source and check it for clashes, or save timetables and reports as PDF (pick a paper size, default A4)." right={
        <label style={{ fontSize: 12.5, color: C.sub, display: "inline-flex", alignItems: "center", gap: 6 }}>Paper
          <select className="tt-sel" style={{ width: 110 }} value={paper} onChange={(e) => setPaper(e.target.value)}>
            <option>A4</option><option>A3</option><option>Letter</option><option>Legal</option>
          </select>
        </label>
      } />
      <div style={{ display: "grid", gap: 16 }}>
        <ImportPanel cfg={cfg} update={update} ask={ask} />
        <Card icon="classes" title="Class timetables" desc="One page per class (landscape) - periods across the top, weekdays down the side, subject + teacher in each cell."
          actions={<PrintBtn onClick={() => exportClassesPDF(cfg, paper)} icon="pdf" label={<>Export all class timetables ({paper})</>} />} />
        <Card icon="teachers" title="Teacher timetables" desc="One page per teacher (landscape) - the class and subject they take each period."
          actions={<PrintBtn onClick={() => exportTeachersPDF(cfg, paper)} icon="pdf" label={<>Export all teacher timetables ({paper})</>} />} />
        <Card icon="analysis" title="Compact overview sheets" desc="Many small timetables on each sheet. Choose how many go on one sheet, the paper size and the direction — the size of each small timetable is worked out to fit."
          actions={<div style={{ display: "grid", gap: 10, width: "100%" }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", fontSize: 12.5, color: C.sub }}>
              <label>Paper&nbsp;<select className="tt-sel" style={{ width: 90, display: "inline-block" }} value={ov.paper} onChange={(e) => setOv({ ...ov, paper: e.target.value })}><option>A3</option><option>A4</option><option>Letter</option><option>Legal</option></select></label>
              <label>Direction&nbsp;<select className="tt-sel" style={{ width: 120, display: "inline-block" }} value={ov.orient} onChange={(e) => setOv({ ...ov, orient: e.target.value })}><option value="landscape">Landscape</option><option value="portrait">Portrait</option></select></label>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", fontSize: 12.5, color: C.sub }}>
              <label>Classes per sheet&nbsp;<input className="tt-in" type="number" min={1} max={80} style={{ width: 70, display: "inline-block", textAlign: "center" }} value={ov.cper} onChange={(e) => setOv({ ...ov, cper: e.target.value })} /></label>
              <PrintBtn onClick={() => exportClassesOverviewPDF(cfg, { per: +ov.cper || 40, paper: ov.paper, orient: ov.orient })} icon="pdf" label={<>All classes ({ov.paper}, {ov.cper}/sheet)</>} />
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", fontSize: 12.5, color: C.sub }}>
              <label>Teachers per sheet&nbsp;<input className="tt-in" type="number" min={1} max={80} style={{ width: 70, display: "inline-block", textAlign: "center" }} value={ov.tper} onChange={(e) => setOv({ ...ov, tper: e.target.value })} /></label>
              <PrintBtn onClick={() => exportTeachersOverviewPDF(cfg, { per: +ov.tper || 24, paper: ov.paper, orient: ov.orient })} icon="pdf" label={<>All teachers ({ov.paper}, {ov.tper}/sheet)</>} />
            </div>
          </div>} />
        <Card icon="setup" title="Data backup" desc="Download all your setup and timetable (classes, teachers, mapping, rules, combined subjects, timetable) as one file. Keep it as a backup, or share it when asking for help."
          actions={<PrintBtn onClick={() => exportJSON(cfg)} icon="download" light label={<>Download data backup (.json)</>} />} />
        <TeacherLinksPanel cfg={cfg} update={update} ask={ask} pubState={pubState} publishNow={publishNow} mobile={mobile} />
        <ExcelCard cfg={cfg} />
        <SafetyPanel cfg={cfg} update={update} ask={ask} />
        <Card icon="free" title="Leisure / free periods" desc="Four ways to print who is free. The substitution chart is the quickest to use on a notice board: find the day and period, and every free teacher is listed in that box."
          actions={<LeisureExport cfg={cfg} paper={paper} />} />
      </div>
    </div>
  );
}

/* ---------------- Rooms, teaching quality & period swaps ---------------- */
function roomsOf(cfg) { return (cfg.rooms || []).filter((r) => r && r.name && (r.subjects || []).length).map((r) => ({ name: r.name, cap: Math.max(1, Number(r.cap) || 1), subjects: r.subjects })); }
function qualityPrefs(cfg) {
  const p = cfg.prefs || {};
  return { on: p.on !== false, maxRun: p.maxRun === undefined ? 3 : Number(p.maxRun) || 0, core: Array.isArray(p.core) ? p.core : [], dailyFree: p.dailyFree !== false, spread: p.spread !== false };
}
// state of a timetable used by the quality score, the polish pass and the swap check
function qState(cfg, grid) {
  const DAYS = cfg.days, D = DAYS.length, P = cfg.periods.length, singles = new Set(cfg.singles);
  const cm = {}; (cfg.combined || []).forEach((x) => { if (x && x.name) cm[x.name] = x; });
  const isC = (code) => !!(code && cm[combName(cm, code)]);
  const toks = (code) => { if (!code) return []; const s = cm[combName(cm, code)]; if (s) return s.teachers.filter((t) => singles.has(t)); return String(code).split(" ").filter((t) => singles.has(t)); };
  const ROOMS = roomsOf(cfg), roomsFor = {}; for (const r of ROOMS) for (const s of r.subjects) (roomsFor[s] || (roomsFor[s] = [])).push(r.name);
  const cap = {}; ROOMS.forEach((r) => (cap[r.name] = r.cap));
  const tb = {}; cfg.singles.forEach((t) => (tb[t] = Array.from({ length: D }, () => new Array(P).fill(0))));
  const rc = {}; ROOMS.forEach((r) => (rc[r.name] = Array.from({ length: D }, () => new Array(P).fill(0))));
  const sdc = {};
  for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) {
    const seen = new Set();
    for (const c of cfg.classes) {
      const sl = grid[c] && grid[c][DAYS[d]] && grid[c][DAYS[d]][p]; if (!sl || !sl[0]) continue;
      const k = c + "|" + d + "|" + sl[1]; sdc[k] = (sdc[k] || 0) + 1;
      if (isC(sl[0])) { if (seen.has(sl[0])) continue; seen.add(sl[0]); }
      for (const t of toks(sl[0])) if (tb[t]) tb[t][d][p]++;
      for (const r of roomsFor[sl[1]] || []) rc[r][d][p]++;
    }
  }
  for (const x of cfg.extraDuties || []) if (tb[x.t]) for (const sl of x.slots || []) { const d = DAYS.indexOf(sl[0]), p = +sl[1]; if (d >= 0 && p < P) tb[x.t][d][p]++; }
  return { DAYS, D, P, cm, isC, toks, roomsFor, cap, tb, rc, sdc };
}
function tdPen(arr, pr, P) {
  let pen = 0, run = 0, busy = 0;
  for (let p = 0; p <= P; p++) { const b = p < P && arr[p] > 0; if (b) { run++; busy++; } else { if (pr.maxRun && run > pr.maxRun) pen += 3 * (run - pr.maxRun); run = 0; } }
  if (pr.dailyFree && busy >= P) pen += 4;
  return pen;
}
function spreadPen(cfg, st, c, sub, pr) {
  if (!pr.spread || !sub) return 0;
  const days = []; let k = 0;
  for (let d = 0; d < st.D; d++) { const n = st.sdc[c + "|" + d + "|" + sub] || 0; days.push(n > 0); k += n; }
  if (!k || k > Math.floor(st.D / 2)) return 0;
  let pen = 0; for (let d = 1; d < st.D; d++) if (days[d] && days[d - 1]) pen++;
  return pen;
}
function qualityReport(cfg, grid) {
  const pr = qualityPrefs(cfg), st = qState(cfg, grid), P = st.P, half = fnCount(cfg), core = new Set(pr.core);
  let runs = 0, noFree = 0, afternoon = 0, spread = 0, lessons = 0, pen = 0, gaps = 0;
  for (const t of cfg.singles) for (let d = 0; d < st.D; d++) {
    if (!teacherWorkDays(cfg, t).includes(st.DAYS[d])) continue;
    const a = st.tb[t][d], tp = tdPen(a, pr, P); pen += tp;
    let run = 0, busy = 0, over = false, first = -1, last = -1;
    for (let p = 0; p <= P; p++) { const b = p < P && a[p] > 0; if (b) { run++; busy++; if (first < 0) first = p; last = p; } else { if (pr.maxRun && run > pr.maxRun) over = true; run = 0; } }
    if (over) runs++; if (pr.dailyFree && busy >= P) noFree++; if (busy) gaps += last - first + 1 - busy;
  }
  const subsOf = {};
  for (const c of cfg.classes) for (let d = 0; d < st.D; d++) for (let p = 0; p < P; p++) {
    const sl = grid[c] && grid[c][st.DAYS[d]] && grid[c][st.DAYS[d]][p]; if (!sl || !sl[0]) continue;
    lessons++; (subsOf[c] || (subsOf[c] = new Set())).add(sl[1]);
    if (core.has(sl[1]) && p >= half) { afternoon++; pen += 1; }
  }
  for (const c of Object.keys(subsOf)) for (const s of subsOf[c]) { const sp = spreadPen(cfg, st, c, s, pr); spread += sp; pen += sp; }
  let tdays = 0; for (const t of cfg.singles) tdays += teacherWorkDays(cfg, t).length;
  let coreL = 0; for (const c of cfg.classes) for (const dc of cfg.days) for (const sl of (grid[c] && grid[c][dc]) || []) if (sl && sl[0] && core.has(sl[1])) coreL++;
  const fr = (a, b) => (b ? Math.min(1, a / b) : 0);
  const parts = { runs: pr.maxRun ? fr(runs, tdays) : 0, noFree: pr.dailyFree ? fr(noFree, tdays) : 0, afternoon: core.size ? fr(afternoon, coreL) : 0, spread: pr.spread ? fr(spread, cfg.classes.length * 2) : 0 };
  const score = lessons ? Math.max(0, Math.round(100 - 30 * parts.runs - 25 * parts.noFree - 30 * parts.afternoon - 15 * parts.spread)) : 0;
  return { score, pen, runs, noFree, afternoon, spread, gaps, lessons, coreLessons: coreL, teacherDays: tdays, parts, prefs: pr };
}
// which cells the polish pass may move
function polishMovable(cfg, mode, onlyClass) {
  const common = new Set(); for (const cp of cfg.commonPeriods || []) for (const c of cp.classes || []) for (const [dc, pn] of cp.slots || []) common.add(c + "|" + dc + "|" + ((+pn) - 1));
  return (c, dc, p) => {
    if (mode === "class" && c !== onlyClass) return false;
    if (p >= classPeriods(cfg, c)) return false;
    if (cfg.locked && cfg.locked[c + "|" + dc + "|" + p]) return false;
    if (cfg.classRules && cfg.classRules[c] && cfg.classRules[c][p + 1]) return false;
    if (common.has(c + "|" + dc + "|" + p)) return false;
    if (mode === "gaps") { const sl = cfg.grid[c] && cfg.grid[c][dc] && cfg.grid[c][dc][p]; if (sl && sl[0]) return false; }
    return true;
  };
}
// hard + soft checks for moving lesson x (at da,pa) to (db,pb) while lesson y goes the other way, inside class c
function moveProblems(cfg, st, c, x, da, pa, y, db, pb) {
  const hard = [], soft = [];
  if (!x || !x[0]) return { hard, soft };
  const R = (cfg.rules || {})[x[1]] || {};
  if (R.pin && R.pin !== pb + 1) hard.push(`${x[1]} is pinned to P${R.pin}`);
  if (R.forbid && R.forbid.includes(pb + 1)) hard.push(`${x[1]} is not allowed in P${pb + 1}`);
  const yt = y && y[0] ? st.toks(y[0]) : [];
  for (const t of st.toks(x[0])) {
    if (!teacherWorkDays(cfg, t).includes(st.DAYS[db])) { hard.push(`${t} doesn't work on ${DAY_FULL[st.DAYS[db]] || st.DAYS[db]}`); continue; }
    const n = (st.tb[t] ? st.tb[t][db][pb] : 0) - (yt.includes(t) && (da !== db || pa !== pb) ? 1 : 0) - (da === db && pa === pb ? 1 : 0);
    if (n > 0) { let where = ""; for (const c2 of cfg.classes) { if (c2 === c) continue; const s2 = cfg.grid[c2] && cfg.grid[c2][st.DAYS[db]] && cfg.grid[c2][st.DAYS[db]][pb]; if (s2 && s2[0] && st.toks(s2[0]).includes(t)) { where = c2; break; } } hard.push(`${t} is teaching ${where || "another class"} then`); }
  }
  for (const r of st.roomsFor[x[1]] || []) { const n = st.rc[r][db][pb] - (y && y[0] && (st.roomsFor[y[1]] || []).includes(r) ? 1 : 0); if (n >= st.cap[r]) hard.push(`${r} is full then`); }
  if (da !== db && x[1] !== (y && y[1])) {
    const now = cfg.grid[c] ? cfg.days.map((dc) => (cfg.grid[c][dc] || []).filter((s) => s && s[1] === x[1]).length) : [];
    const lim = Math.max((cfg.twice && cfg.twice[stdOf(c)] && cfg.twice[stdOf(c)][x[1]]) ? 2 : 1, ...now);
    if ((st.sdc[c + "|" + db + "|" + x[1]] || 0) + 1 > lim) soft.push(`${x[1]} would come twice on ${DAY_FULL[st.DAYS[db]] || st.DAYS[db]}`);
  }
  if (R.distinct) for (let d = 0; d < st.D; d++) { if (d === da || d === db) continue; const s2 = cfg.grid[c] && cfg.grid[c][st.DAYS[d]] && cfg.grid[c][st.DAYS[d]][pb]; if (s2 && s2[1] === x[1]) { soft.push(`${x[1]} is already in P${pb + 1} on another day`); break; } }
  return { hard, soft };
}
function swapCheck(cfg, c, da, pa, db, pb) {
  const st = qState(cfg, cfg.grid), dA = cfg.days[da], dB = cfg.days[db];
  const a = cfg.grid[c] && cfg.grid[c][dA] && cfg.grid[c][dA][pa], b = cfg.grid[c] && cfg.grid[c][dB] && cfg.grid[c][dB][pb];
  const out = { hard: [], soft: [] };
  const mv = polishMovable(cfg, "all");
  if (!mv(c, dA, pa) || !mv(c, dB, pb)) out.hard.push("A locked, rule, common or beyond-the-day period can't be moved");
  if ((a && a[0] && st.isC(a[0])) || (b && b[0] && st.isC(b[0]))) out.hard.push("Combined periods move together — use the Combined subjects tab");
  if (out.hard.length) return out;
  const m1 = moveProblems(cfg, st, c, a, da, pa, b, db, pb), m2 = moveProblems(cfg, st, c, b, db, pb, a, da, pa);
  out.hard.push(...m1.hard, ...m2.hard); out.soft.push(...m1.soft, ...m2.soft);
  return out;
}
// hill-climb: swap lessons inside a class (never breaking a hard rule) to lower the quality penalty
function polishGrid(cfg, gridIn, movable, ms) {
  const pr = qualityPrefs(cfg);
  const grid = JSON.parse(JSON.stringify(gridIn));
  const work = { ...cfg, grid };
  const st = qState(work, grid), P = st.P, D = st.D, half = fnCount(cfg), core = new Set(pr.core);
  const cells = {};
  for (const c of cfg.classes) { const list = []; for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) { const sl = grid[c] && grid[c][st.DAYS[d]] && grid[c][st.DAYS[d]][p]; if (!sl) continue; if (sl[0] && st.isC(sl[0])) continue; if (movable(c, st.DAYS[d], p)) list.push([d, p]); } if (list.length > 1) cells[c] = list; }
  const cls = Object.keys(cells); if (!cls.length) return { grid, moves: 0 };
  const workDay = {}; cfg.singles.forEach((t) => { const w = teacherWorkDays(cfg, t); workDay[t] = st.DAYS.map((dc) => w.includes(dc)); });
  const tdp = (t, d) => (workDay[t] && workDay[t][d] ? tdPen(st.tb[t][d], pr, P) : 0);
  const at = (c, d, p) => grid[c][st.DAYS[d]][p];
  const local = (c, d1, p1, d2, p2, a, b) => {
    let s = 0; const ts = new Set([...st.toks(a && a[0]), ...st.toks(b && b[0])]);
    for (const t of ts) { s += tdp(t, d1); if (d2 !== d1) s += tdp(t, d2); }
    for (const [x, p] of [[at(c, d1, p1), p1], [at(c, d2, p2), p2]]) if (x && x[0] && core.has(x[1]) && p >= half) s += 1;
    const subs = new Set([a && a[1], b && b[1]].filter(Boolean)); for (const sb of subs) s += spreadPen(work, st, c, sb, pr);
    return s;
  };
  const apply = (c, d1, p1, d2, p2) => {
    const a = at(c, d1, p1), b = at(c, d2, p2);
    const mv = (x, df, pf, dt, pt) => { if (!x || !x[0]) return; for (const t of st.toks(x[0])) if (st.tb[t]) { st.tb[t][df][pf]--; st.tb[t][dt][pt]++; } for (const r of st.roomsFor[x[1]] || []) { st.rc[r][df][pf]--; st.rc[r][dt][pt]++; } st.sdc[c + "|" + df + "|" + x[1]]--; st.sdc[c + "|" + dt + "|" + x[1]] = (st.sdc[c + "|" + dt + "|" + x[1]] || 0) + 1; };
    mv(a, d1, p1, d2, p2); mv(b, d2, p2, d1, p1);
    grid[c][st.DAYS[d1]][p1] = b || [null, null]; grid[c][st.DAYS[d2]][p2] = a || [null, null];
  };
  const rng = makeRng(Date.now() % 100000 + 7);
  const t0 = Date.now(); let moves = 0, it = 0;
  while (Date.now() - t0 < ms) {
    for (let k = 0; k < 200; k++) {
      it++;
      const c = cls[Math.floor(rng() * cls.length)], list = cells[c];
      const [d1, p1] = list[Math.floor(rng() * list.length)], [d2, p2] = list[Math.floor(rng() * list.length)];
      if (d1 === d2 && p1 === p2) continue;
      const a = at(c, d1, p1), b = at(c, d2, p2);
      if ((!a || !a[0]) && (!b || !b[0])) continue;
      if (a && b && a[0] === b[0] && a[1] === b[1]) continue;
      const m1 = moveProblems(work, st, c, a, d1, p1, b, d2, p2); if (m1.hard.length || m1.soft.length) continue;
      const m2 = moveProblems(work, st, c, b, d2, p2, a, d1, p1); if (m2.hard.length || m2.soft.length) continue;
      const before = local(c, d1, p1, d2, p2, a, b);
      apply(c, d1, p1, d2, p2);
      const after = local(c, d1, p1, d2, p2, a, b);
      if (after < before || (after === before && rng() < 0.04)) { if (after < before) moves++; } else apply(c, d1, p1, d2, p2);
    }
  }
  return { grid, moves, iterations: it };
}
function scoreTone(s) { return s >= 80 ? [C.freeSoft, C.free] : s >= 60 ? [C.warnSoft, C.warn] : [C.clashSoft, C.clash]; }
function QualityPanel({ cfg, update, ask, compact }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const pr = qualityPrefs(cfg);
  const q = useMemo(() => qualityReport(cfg, cfg.grid), [cfg]);
  const th = CUR_TH || THEMES.teal;
  const setP = (k, v) => update((n) => { n.prefs = { ...(n.prefs || {}), [k]: v }; });
  const improve = () => ask("Improve teaching quality now? Ordinary lessons are swapped inside each class to reach your preferences. Locked, rule, common and combined periods stay where they are, and no clash is ever created. A safety copy is kept automatically.", () => {
    setBusy(true); setMsg("");
    setTimeout(() => {
      try {
        const before = qualityReport(cfg, cfg.grid).score;
        const res = polishGrid(cfg, cfg.grid, polishMovable(cfg, "all"), 3500);
        const after = qualityReport({ ...cfg, grid: res.grid }, res.grid).score;
        if (res.moves) update((n) => { n.grid = res.grid; });
        setMsg(res.moves ? `Made ${res.moves} improvement${res.moves === 1 ? "" : "s"} — quality ${before} → ${after}.` : "No better arrangement found without breaking a rule — the timetable is already as good as the rules allow.");
      } catch (e) { setMsg("Couldn't improve: " + ((e && e.message) || e)); }
      setBusy(false);
    }, 40);
  });
  const [bg, fg] = scoreTone(q.score);
  const items = [
    [pr.maxRun ? `Teacher-days with more than ${pr.maxRun} in a row` : "Periods in a row (off)", pr.maxRun ? q.runs : "—", pr.maxRun ? `of ${q.teacherDays}` : ""],
    ["Teacher-days with no free period", pr.dailyFree ? q.noFree : "—", pr.dailyFree ? `of ${q.teacherDays}` : ""],
    [pr.core.length ? `${pr.core.join(", ")} in the afternoon (AN)` : "Core subjects in the forenoon (none chosen)", pr.core.length ? q.afternoon : "—", pr.core.length ? `of ${q.coreLessons}` : ""],
    ["Short subjects on back-to-back days", pr.spread ? q.spread : "—", ""],
    ["Gaps between a teacher's lessons", q.gaps, "info"],
  ];
  const chip = (on) => ({ padding: "5px 11px", borderRadius: 20, fontSize: 12.5, fontWeight: 700, cursor: "pointer", border: `1.5px solid ${on ? th.accent : C.line}`, background: on ? th.accent : "#fff", color: on ? "#fff" : C.sub });
  const ScoreRing = (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ width: 64, height: 64, borderRadius: "50%", flexShrink: 0, display: "grid", placeItems: "center", background: `conic-gradient(${fg} ${q.score * 3.6}deg, #e9edf2 0deg)` }}>
        <div style={{ width: 50, height: 50, borderRadius: "50%", background: "#fff", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 18, color: fg }}>{q.score}</div>
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 800, color: C.ink }}>Teaching quality {q.score >= 80 ? "— very good" : q.score >= 60 ? "— good" : "— can be better"}</div>
        <div style={{ fontSize: 12, color: C.sub }}>Out of 100, from your preferences below. Clash-free is always guaranteed separately.</div>
      </div>
    </div>
  );
  if (compact) return (
    <div style={{ ...card, marginBottom: 14, padding: 12, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      {ScoreRing}
      <button className="tt-btn" disabled={busy} onClick={improve} style={{ ...solidBtn, marginLeft: "auto" }}>{busy ? "Improving…" : "✦ Improve quality"}</button>
      {msg && <div style={{ width: "100%", fontSize: 12.5, fontWeight: 600, color: C.free }}>{msg}</div>}
    </div>
  );
  return (
    <div style={{ ...card, marginBottom: 16 }}>
      <Panelhead text="Teaching quality — soft preferences" count={pr.on ? `score ${q.score}` : "off"} tone={pr.on && q.score >= 80 ? "free" : undefined} />
      <div style={{ padding: 14, display: "grid", gap: 14 }}>
        <div className="tt-callout">These are <b>“try to”</b> rules. The generator never breaks a hard rule or creates a clash for them — after placing everything it swaps lessons inside each class to get closer to these wishes. Turn them off for the old behaviour.</div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          {ScoreRing}
          <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 700, marginLeft: "auto", cursor: "pointer" }}><input type="checkbox" checked={pr.on} onChange={(e) => setP("on", e.target.checked)} /> Use preferences when generating</label>
          <button className="tt-btn" disabled={busy || !pr.on} onClick={improve} style={{ ...solidBtn, opacity: pr.on ? 1 : 0.5 }}>{busy ? "Improving…" : "✦ Improve current timetable"}</button>
        </div>
        {msg && <div style={{ fontSize: 12.5, fontWeight: 600, color: C.free }}>{msg}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, opacity: pr.on ? 1 : 0.55 }}>
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "grid", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 800 }}>Most periods in a row for a teacher</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{[[0, "No limit"], [2, "2"], [3, "3"], [4, "4"], [5, "5"]].map(([v, l]) => <button key={v} className="tt-btn" onClick={() => setP("maxRun", v)} style={chip(pr.maxRun === v)}>{l}</button>)}</div>
            <div style={{ fontSize: 11.5, color: C.sub }}>Gives teachers a break after this many periods.</div>
          </div>
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "grid", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 800 }}>Core subjects in the forenoon (FN)</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{cfg.subjects.map((sb) => { const on = pr.core.includes(sb); return <button key={sb} className="tt-btn" onClick={() => setP("core", on ? pr.core.filter((x) => x !== sb) : [...pr.core, sb])} style={{ ...chip(on), fontFamily: mono, padding: "4px 9px" }}>{sb}</button>; })}</div>
            <div style={{ fontSize: 11.5, color: C.sub }}>Tap subjects that should come in the forenoon (FN: P1–P{fnCount(cfg)}) where possible.</div>
          </div>
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "grid", gap: 10 }}>
            <label style={{ display: "flex", gap: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}><input type="checkbox" checked={pr.dailyFree} onChange={(e) => setP("dailyFree", e.target.checked)} /> At least one free period for every teacher each day</label>
            <label style={{ display: "flex", gap: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}><input type="checkbox" checked={pr.spread} onChange={(e) => setP("spread", e.target.checked)} /> Spread short subjects (2–3 a week) over non-adjacent days</label>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
          {items.map(([l, v, o]) => (
            <div key={l} style={{ padding: "9px 12px", borderRadius: 10, background: "#f8fafc", border: `1px solid ${C.line}` }}>
              <div style={{ fontSize: 11.5, color: C.sub }}>{l}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: o === "info" ? C.ink : v === 0 ? C.free : v === "—" ? C.sub : C.warn }}>{v} <span style={{ fontSize: 11.5, color: C.sub, fontWeight: 600 }}>{o !== "info" ? o : ""}</span></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RoomsPanel({ cfg, update, ask }) {
  const [name, setName] = useState("");
  const rooms = cfg.rooms || [];
  const th = CUR_TH || THEMES.teal;
  const usage = useMemo(() => {
    const out = [], st = qState(cfg, cfg.grid);
    for (const r of roomsOf(cfg)) for (let d = 0; d < st.D; d++) for (let p = 0; p < st.P; p++) if (st.rc[r.name][d][p] > r.cap) {
      const who = cfg.classes.filter((c) => { const sl = cfg.grid[c]?.[cfg.days[d]]?.[p]; return sl && r.subjects.includes(sl[1]); });
      out.push({ room: r.name, d: cfg.days[d], p, n: st.rc[r.name][d][p], cap: r.cap, who });
    }
    return out;
  }, [cfg]);
  const add = () => { const n0 = name.trim(); if (!n0 || rooms.some((r) => r.name.toLowerCase() === n0.toLowerCase())) return; update((n) => { n.rooms = [...(n.rooms || []), { name: n0, cap: 1, subjects: [] }]; }); setName(""); };
  const setR = (i, k, v) => update((n) => { n.rooms = (n.rooms || []).map((r, j) => (j === i ? { ...r, [k]: v } : r)); });
  return (
    <div style={{ ...card, marginBottom: 16 }}>
      <Panelhead text="Rooms & labs" count={rooms.length ? `${rooms.length} room${rooms.length === 1 ? "" : "s"}${usage.length ? ` · ${usage.length} over` : ""}` : "none"} tone={rooms.length && !usage.length ? "free" : undefined} />
      <div style={{ padding: 14, display: "grid", gap: 12 }}>
        <div className="tt-callout">Add a shared room such as the <b>IT lab</b> or <b>playground</b>, say how many classes fit at once, and tap the subjects that use it. The generator then never puts more classes there at the same time — even when different teachers take them.</div>
        {rooms.map((r, i) => (
          <div key={i} style={{ border: `1.5px solid ${th.accent}33`, borderRadius: 14, padding: 12, display: "grid", gap: 10, background: "#fbfdfd" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ width: 36, height: 36, borderRadius: 10, display: "grid", placeItems: "center", background: `linear-gradient(135deg, ${th.g1}, ${th.g2})`, color: "#fff", fontWeight: 800 }}>⌂</span>
              <input className="tt-in" value={r.name} onChange={(e) => setR(i, "name", e.target.value)} style={{ flex: "1 1 160px", maxWidth: 260, fontFamily: sans, fontWeight: 800, fontSize: 14, height: 36 }} />
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.sub, fontWeight: 700 }}>Classes at once
                <select className="tt-sel" value={r.cap || 1} onChange={(e) => setR(i, "cap", +e.target.value)} style={{ width: 64 }}>{[1, 2, 3, 4, 5, 6].map((x) => <option key={x}>{x}</option>)}</select>
              </label>
              <button className="tt-btn" onClick={() => ask(`Remove the room "${r.name}"?`, () => update((n) => { n.rooms = (n.rooms || []).filter((_, j) => j !== i); }))} style={{ ...ghostBtn, marginLeft: "auto", color: C.clash, padding: "5px 10px", fontSize: 12 }}>Remove</button>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: C.sub, fontWeight: 700, alignSelf: "center", marginRight: 4 }}>Used for:</span>
              {cfg.subjects.map((sb) => { const on = (r.subjects || []).includes(sb); return <button key={sb} className="tt-btn" onClick={() => setR(i, "subjects", on ? r.subjects.filter((x) => x !== sb) : [...(r.subjects || []), sb])} style={{ fontFamily: mono, fontWeight: 800, fontSize: 12, padding: "4px 9px", borderRadius: 8, cursor: "pointer", border: `1.5px solid ${on ? th.accent : C.line}`, background: on ? `${th.accent}16` : "#fff", color: on ? th.g2 : C.sub }}>{sb}</button>; })}
            </div>
            {!(r.subjects || []).length && <div style={{ fontSize: 12, color: C.warn, fontWeight: 600 }}>Tap at least one subject — until then this room is not used.</div>}
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="tt-in" placeholder="Room name, e.g. IT Lab" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} style={{ flex: "1 1 200px", maxWidth: 300, fontFamily: sans, fontSize: 13, height: 36 }} />
          <button className="tt-btn" onClick={add} style={solidBtn}>+ Add room</button>
        </div>
        {rooms.length > 0 && (usage.length ? (
          <div style={{ border: `1px solid ${C.clash}44`, background: C.clashSoft, borderRadius: 12, padding: 10, fontSize: 12.5 }}>
            <b style={{ color: C.clash }}>The current timetable over-fills a room {usage.length} time{usage.length === 1 ? "" : "s"}.</b> Generate again (Fill remaining or Regenerate) to fix it.
            <div style={{ marginTop: 6, display: "grid", gap: 3 }}>{usage.slice(0, 8).map((u, k) => <div key={k}>{u.room}: {DAY_FULL[u.d]} P{u.p + 1} — {u.n} classes ({u.who.join(", ")}), room takes {u.cap}</div>)}{usage.length > 8 && <div>…and {usage.length - 8} more</div>}</div>
          </div>
        ) : <div style={{ fontSize: 12.5, color: C.free, fontWeight: 700 }}>✓ The current timetable fits every room.</div>)}
      </div>
    </div>
  );
}

function SwapBoard({ cfg, update, cls, mobile }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(null);
  const [hover, setHover] = useState(null);
  const [msg, setMsg] = useState(null);
  const th = CUR_TH || THEMES.teal;
  const P = cfg.periods.length, lim = classPeriods(cfg, cls);
  const cm = {}; (cfg.combined || []).forEach((x) => (cm[x.name] = x));
  const check = (a, b) => (a && b && (a[0] !== b[0] || a[1] !== b[1]) ? swapCheck(cfg, cls, a[0], a[1], b[0], b[1]) : null);
  const preview = sel && hover ? check(sel, hover) : null;
  const doSwap = (a, b) => {
    const r = check(a, b); if (!r) return;
    if (r.hard.length) { setMsg({ ok: false, text: "Can't swap: " + r.hard.join(" · ") }); return; }
    const dA = cfg.days[a[0]], dB = cfg.days[b[0]];
    update((n) => { const x = n.grid[cls][dA][a[1]], y = n.grid[cls][dB][b[1]]; n.grid[cls][dA][a[1]] = y; n.grid[cls][dB][b[1]] = x; });
    setMsg({ ok: true, text: `Swapped ${DAY_FULL[dA].slice(0, 3)} P${a[1] + 1} and ${DAY_FULL[dB].slice(0, 3)} P${b[1] + 1}.` + (r.soft.length ? " Note: " + r.soft.join(" · ") : "") + " (Undo with ↶ if needed.)" });
    setSel(null); setHover(null);
  };
  const tap = (d, p) => { if (!sel) { setSel([d, p]); setMsg(null); return; } if (sel[0] === d && sel[1] === p) { setSel(null); return; } doSwap(sel, [d, p]); };
  if (!open) return (
    <div style={{ ...card, marginBottom: 14, padding: 12, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <span style={{ width: 38, height: 38, borderRadius: 11, display: "grid", placeItems: "center", background: `${th.accent}14`, color: th.accent, fontSize: 18, fontWeight: 800 }}>⇄</span>
      <div style={{ flex: "1 1 220px" }}><div style={{ fontSize: 14, fontWeight: 800 }}>Swap periods in {cls}</div><div style={{ fontSize: 12, color: C.sub }}>{mobile ? "Tap one period, then another." : "Drag a period onto another, or click two."} The app checks clashes before swapping.</div></div>
      <button className="tt-btn" onClick={() => setOpen(true)} style={solidBtn}>Open swap board</button>
    </div>
  );
  return (
    <div style={{ ...card, marginBottom: 14 }}>
      <Panelhead text={`Swap periods · ${cls}`} count={sel ? "pick the second period" : mobile ? "tap a period" : "drag or click"} />
      <div style={{ padding: 12, display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12, color: C.sub }}>
          <span><span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, background: C.freeSoft, border: `1px solid ${C.free}`, verticalAlign: "middle" }} /> can swap</span>
          <span><span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, background: C.warnSoft, border: `1px solid ${C.warn}`, verticalAlign: "middle" }} /> can swap, with a note</span>
          <span><span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, background: C.clashSoft, border: `1px solid ${C.clash}`, verticalAlign: "middle" }} /> would clash</span>
          <span>🔒 locked / rule · ◎ combined (can't move here)</span>
          <button className="tt-btn" onClick={() => { setOpen(false); setSel(null); }} style={{ ...ghostBtn, marginLeft: "auto", padding: "4px 10px", fontSize: 12 }}>Close</button>
        </div>
        {msg && <div style={{ fontSize: 12.5, fontWeight: 600, color: msg.ok ? C.free : C.clash }}>{msg.text}</div>}
        {sel && !mobile && preview && <div style={{ fontSize: 12, color: preview.hard.length ? C.clash : preview.soft.length ? C.warn : C.free, fontWeight: 600 }}>{preview.hard.length ? preview.hard.join(" · ") : preview.soft.length ? preview.soft.join(" · ") : "✓ This swap is fine"}</div>}
        <div className="tt-scroll" style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "separate", borderSpacing: 4, minWidth: 90 + P * (mobile ? 70 : 92) }}>
            <thead><tr><th />{cfg.periods.map((p, i) => <th key={i} style={{ fontSize: 11.5, color: C.sub, fontWeight: 800 }}>P{p}</th>)}</tr></thead>
            <tbody>{cfg.days.map((dc, d) => (
              <tr key={dc}>
                <td style={{ fontSize: 12, fontWeight: 800, color: C.sub, paddingRight: 6 }}>{DAY_FULL[dc].slice(0, 3)}</td>
                {cfg.periods.map((_, p) => {
                  if (p >= lim) return <td key={p}><div style={{ height: 50, borderRadius: 9, background: "#eef0f3" }} /></td>;
                  const sl = cfg.grid[cls]?.[dc]?.[p] || [null, null];
                  const locked = !polishMovable(cfg, "all")(cls, dc, p), comb = sl[0] && cm[combName(cm, sl[0])];
                  const isSel = sel && sel[0] === d && sel[1] === p;
                  let tone = null; if (sel && !isSel) { const r = check(sel, [d, p]); tone = !r ? null : r.hard.length ? "bad" : r.soft.length ? "warn" : "ok"; }
                  const bg = isSel ? th.accent : tone === "ok" ? C.freeSoft : tone === "warn" ? C.warnSoft : tone === "bad" ? C.clashSoft : sl[0] ? (tintOf(SUBJECT_BAR[sl[1]] || "#647189", 0.12)) : "#fafbfc";
                  const bd = isSel ? th.g2 : tone === "ok" ? C.free : tone === "warn" ? C.warn : tone === "bad" ? `${C.clash}88` : C.line;
                  const can = !locked && !comb;
                  return (
                    <td key={p}>
                      <div draggable={can && !mobile} onDragStart={(e) => { setSel([d, p]); try { e.dataTransfer.setData("text/plain", d + "," + p); e.dataTransfer.effectAllowed = "move"; } catch (er) { /* ignore */ } }}
                        onDragOver={(e) => { e.preventDefault(); if (!hover || hover[0] !== d || hover[1] !== p) setHover([d, p]); }} onDrop={(e) => { e.preventDefault(); if (sel) doSwap(sel, [d, p]); }} onDragEnd={() => setHover(null)}
                        onClick={() => can && tap(d, p)}
                        style={{ height: 50, borderRadius: 9, border: `1.5px solid ${bd}`, background: bg, color: isSel ? "#fff" : C.ink, display: "grid", placeItems: "center", textAlign: "center", cursor: can ? (mobile ? "pointer" : "grab") : "not-allowed", padding: "2px 3px", userSelect: "none", opacity: can ? 1 : 0.7, lineHeight: 1.15 }}>
                        {sl[0] ? <span><span style={{ display: "block", fontSize: 11.5, fontWeight: 800, color: isSel ? "#fff" : SUBJECT_BAR[sl[1]] || C.ink }}>{sl[1]}{locked ? " 🔒" : comb ? " ◎" : ""}</span><span style={{ display: "block", fontSize: 10.5, fontFamily: mono, fontWeight: 700, color: isSel ? "#fff" : C.sub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: mobile ? 62 : 84 }}>{comb ? comb.teachers.join(" ") : sl[0]}</span></span> : <span style={{ fontSize: 11, color: isSel ? "#fff" : "#b4bccb" }}>{locked ? "🔒" : "empty"}</span>}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
/* ---------------- Excel (.xlsx) writer — no library needed ---------------- */
var CRC_T = null;
function crc32(u) { if (!CRC_T) { CRC_T = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; } } let c = 0xffffffff; for (let i = 0; i < u.length; i++) c = CRC_T[(c ^ u[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipStore(files) {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const u16 = (v) => [v & 255, (v >>> 8) & 255], u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  for (const f of files) {
    const name = enc.encode(f.name), data = typeof f.data === "string" ? enc.encode(f.data) : f.data, crc = crc32(data);
    const head = [0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
    parts.push(new Uint8Array(head), name, data);
    central.push(new Uint8Array([0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), name);
    off += head.length + name.length + data.length;
  }
  const cdSize = central.reduce((a, x) => a + x.length, 0);
  const end = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(off), ...u16(0)]);
  return new Blob([...parts, ...central, end], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
function xEsc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""); }
function xCol(i) { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
// styles: 0 normal · 1 header · 2 title · 3 row head · 4 cell · 5 free · 6 off · 7 note · 8 number · 9 combined cell · 10 sub title
var XSTYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="6"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="15"/><color rgb="FF0A4F55"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF0A4F55"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF647189"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFD98A2B"/><name val="Calibri"/></font></fonts>' +
  '<fills count="8"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0E6B73"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE1F0F0"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC9EFD8"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF0F3"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFBF3E4"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF7FAFC"/></patternFill></fill></fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFB9D3D3"/></left><right style="thin"><color rgb="FFB9D3D3"/></right><top style="thin"><color rgb="FFB9D3D3"/></top><bottom style="thin"><color rgb="FFB9D3D3"/></bottom><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="11">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
function xSheet(sh) {
  let rows = "";
  sh.rows.forEach((r, ri) => {
    if (!r) return;
    const ht = sh.heights && sh.heights[ri] ? ` ht="${sh.heights[ri]}" customHeight="1"` : "";
    let cells = "";
    r.forEach((c, ci) => {
      if (c == null) return;
      const o = typeof c === "object" ? c : { v: c }, ref = xCol(ci) + (ri + 1), st = o.s ? ` s="${o.s}"` : "";
      if (o.v === "" || o.v == null) cells += `<c r="${ref}"${st}/>`;
      else if (typeof o.v === "number") cells += `<c r="${ref}"${st}><v>${o.v}</v></c>`;
      else cells += `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xEsc(o.v)}</t></is></c>`;
    });
    rows += `<row r="${ri + 1}"${ht}>${cells}</row>`;
  });
  const cols = sh.cols ? "<cols>" + sh.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("") + "</cols>" : "";
  const merges = sh.merges && sh.merges.length ? `<mergeCells count="${sh.merges.length}">` + sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join("") + "</mergeCells>" : "";
  const land = '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    (sh.freeze ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : "") +
    '<sheetFormatPr defaultRowHeight="16"/>' + cols + "<sheetData>" + rows + "</sheetData>" + merges + land + "</worksheet>";
}
function buildXlsx(sheets) {
  const used = new Set();
  const names = sheets.map((sh) => { let n = String(sh.name).replace(/[\[\]:*?\/\\]/g, "-").slice(0, 31) || "Sheet"; let k = 2; const base = n; while (used.has(n.toLowerCase())) n = (base.slice(0, 28) + " " + k++); used.add(n.toLowerCase()); return n; });
  const files = [
    { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") + "</Types>" },
    { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: "xl/workbook.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + names.map((n, i) => `<sheet name="${xEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + "</sheets></workbook>" },
    { name: "xl/_rels/workbook.xml.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: XSTYLES },
    ...sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xSheet(sh) })),
  ];
  return zipStore(files);
}
function ttWorkbook(cfg, o) {
  o = o || {};
  const P = cfg.periods.length, days = cfg.days, L = leisureData(cfg);
  const cm = {}; (cfg.combined || []).forEach((x) => (cm[x.name] = x));
  const who = (code) => (cm[code] ? cm[code].teachers.join(" ") : code);
  const stamp = new Date().toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  const head = [{ v: "Day", s: 1 }, ...cfg.periods.map((p) => ({ v: "P" + p, s: 1 }))];
  const cols = [14, ...cfg.periods.map(() => 15)];
  const classBlock = (c, rows, merges, heights) => {
    const r0 = rows.length;
    rows.push([{ v: `Class ${c}`, s: 2 }]); merges.push(`A${r0 + 1}:${xCol(P)}${r0 + 1}`);
    rows.push([{ v: `Class teacher: ${cfg.classTeacher[c] || "—"}${cfg.year ? " · " + cfg.year : ""}`, s: 7 }]);
    rows.push(head);
    for (const d of days) {
      const r = [{ v: DAY_FULL[d], s: 3 }];
      for (let p = 0; p < P; p++) { if (p >= classPeriods(cfg, c)) { r.push({ v: "", s: 6 }); continue; } const sl = cfg.grid[c]?.[d]?.[p]; r.push(sl && sl[0] ? { v: `${sl[1]}\n${who(sl[0])}`, s: cm[sl[0]] ? 9 : 4 } : { v: "", s: 4 }); }
      heights[rows.length] = 32; rows.push(r);
    }
  };
  const teacherBlock = (t, rows, merges, heights) => {
    const r0 = rows.length; let n = 0;
    rows.push([{ v: `Teacher ${t}`, s: 2 }]); merges.push(`A${r0 + 1}:${xCol(P)}${r0 + 1}`);
    const sub = rows.length; rows.push([]); rows.push(head);
    for (const d of days) {
      const r = [{ v: DAY_FULL[d], s: 3 }];
      for (let p = 0; p < P; p++) { const b = L.busy[t] && L.busy[t][d] ? L.busy[t][d][p] : null; if (b === "off") r.push({ v: "off", s: 6 }); else if (!b) r.push({ v: "free", s: 5 }); else { n++; r.push({ v: `${b.c}\n${b.sub}`, s: b.combined ? 9 : 4 }); } }
      heights[rows.length] = 32; rows.push(r);
    }
    rows[sub] = [{ v: `${n} periods a week · ${L.week[t]} free${cfg.year ? " · " + cfg.year : ""}`, s: 7 }];
  };
  const sheets = [];
  // summary
  { const rows = [[{ v: cfg.school || "School", s: 2 }], [{ v: `Timetable workbook${cfg.year ? " · " + cfg.year : ""} · made ${stamp}`, s: 7 }], [],
      [{ v: "Classes", s: 3 }, { v: cfg.classes.length, s: 8 }], [{ v: "Teachers", s: 3 }, { v: cfg.singles.length, s: 8 }], [{ v: "Working days", s: 3 }, { v: days.map((d) => DAY_FULL[d].slice(0, 3)).join(", "), s: 4 }], [{ v: "Periods a day", s: 3 }, { v: P, s: 8 }], [],
      [{ v: "Teacher", s: 1 }, { v: "Periods / week", s: 1 }, { v: "Free / week", s: 1 }, { v: "Working days", s: 1 }, { v: "Classes taught", s: 1 }]];
    for (const t of cfg.singles) { let n = 0; const cl = new Set(); for (const d of days) for (let p = 0; p < P; p++) { const b = L.busy[t] && L.busy[t][d] ? L.busy[t][d][p] : null; if (b && b !== "off") { n++; String(b.c).split(", ").forEach((x) => cl.add(x)); } } rows.push([{ v: t, s: 3 }, { v: n, s: 8 }, { v: L.week[t], s: 8 }, { v: teacherWorkDays(cfg, t).length, s: 8 }, { v: [...cl].sort(cmpClass).join(", "), s: 4 }]); }
    sheets.push({ name: "Summary", rows, cols: [22, 16, 14, 14, 60], merges: [] }); }
  // all classes / all teachers
  { const rows = [], merges = [], heights = {}; cfg.classes.forEach((c, i) => { if (i) rows.push([]); classBlock(c, rows, merges, heights); }); sheets.push({ name: "All classes", rows, merges, heights, cols }); }
  { const rows = [], merges = [], heights = {}; cfg.singles.forEach((t, i) => { if (i) rows.push([]); teacherBlock(t, rows, merges, heights); }); sheets.push({ name: "All teachers", rows, merges, heights, cols }); }
  // free by period (substitution chart)
  { const rows = [[{ v: "Free teachers by period", s: 2 }], [{ v: "Each box: number free, then the teacher codes", s: 7 }], head], heights = {};
    for (const d of days) { const r = [{ v: DAY_FULL[d], s: 3 }]; for (let p = 0; p < P; p++) { const l = L.free[d][p]; r.push({ v: `${l.length} free\n${l.join(", ")}`, s: 4 }); } heights[rows.length] = 90; rows.push(r); }
    sheets.push({ name: "Free by period", rows, heights, cols: [14, ...cfg.periods.map(() => 24)], merges: [`A1:${xCol(P)}1`] }); }
  if (o.each !== false) {
    for (const c of cfg.classes) { const rows = [], merges = [], heights = {}; classBlock(c, rows, merges, heights); sheets.push({ name: c, rows, merges, heights, cols }); }
    for (const t of cfg.singles) { const rows = [], merges = [], heights = {}; teacherBlock(t, rows, merges, heights); sheets.push({ name: "Tr " + t, rows, merges, heights, cols }); }
  }
  return sheets;
}
function exportXlsx(cfg, o) {
  const blob = buildXlsx(ttWorkbook(cfg, o));
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${(cfg.school || "timetable").replace(/[^\w-]+/g, "_")}${cfg.year ? "_" + String(cfg.year).replace(/[^\w-]+/g, "_") : ""}_timetable.xlsx`;
  document.body.appendChild(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 500);
}
function ExcelCard({ cfg }) {
  const [each, setEach] = useState(true);
  const [msg, setMsg] = useState("");
  const th = CUR_TH || THEMES.teal;
  const n = 4 + (each ? cfg.classes.length + cfg.singles.length : 0);
  return (
    <div style={{ ...card, padding: 18, position: "relative" }}>
      <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: `linear-gradient(180deg, ${th.g1}, ${th.g2})` }} />
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <span style={{ width: 40, height: 40, borderRadius: 12, display: "grid", placeItems: "center", background: "#e3f5ec", color: "#1d7a45", flexShrink: 0, fontWeight: 900, fontSize: 15 }}>X</span>
        <div style={{ fontSize: 15.5, fontWeight: 800, color: C.ink }}>Excel workbook (.xlsx)</div>
      </div>
      <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 12, lineHeight: 1.6 }}>Everything in one Excel file for the office or the education department: a summary with every teacher's load, all class timetables, all teacher timetables, and who is free in each period. Opens in Excel, Google Sheets and LibreOffice.</div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 600, cursor: "pointer" }}><input type="checkbox" checked={each} onChange={(e) => setEach(e.target.checked)} /> Also a separate sheet for every class and teacher</label>
        <span style={{ marginLeft: "auto" }}><PrintBtn onClick={() => { try { exportXlsx(cfg, { each }); setMsg(`Downloaded — ${n} sheets.`); } catch (e) { setMsg("Couldn't make the file: " + ((e && e.message) || e)); } }} icon="download" label="Download Excel file" sub={`${n} sheets`} /></span>
      </div>
      {msg && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, color: C.free }}>{msg}</div>}
    </div>
  );
}

/* ---------------- New academic year ---------------- */
function nextYearLabel(y) {
  const m = String(y || "").match(/(\d{4})\s*[-–\/]\s*(\d{2,4})/);
  if (m) { const a = +m[1] + 1, b = String(+m[2] + 1).slice(-m[2].length); return `${a}–${b.padStart(m[2].length, "0")}`; }
  const now = new Date(), a = now.getMonth() >= 2 ? now.getFullYear() : now.getFullYear() - 1;
  return `${a}–${String(a + 1).slice(-2)}`;
}
function YearCard({ cfg, update, askPw }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(nextYearLabel(cfg.year));
  const [o, setO] = useState({ grid: true, locks: true, subs: true, versions: false, backup: true });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const th = CUR_TH || THEMES.teal;
  const start = () => askPw(`Start the new academic year ${label}? The whole ${cfg.year || "current"} year is archived first (Import / Export → Safety copies), then the options you ticked are cleared. Classes, teachers, mapping, rules and combined subjects are kept.`, async () => {
    setBusy(true); setMsg(null);
    try {
      if (o.backup) { try { exportJSON(cfg); } catch (e) { /* ignore */ } }
      const rec = await makeSnapshot(cfg, `Academic year ${cfg.year || "(before " + label + ")"} — archive`, "archive");
      update((n) => {
        n.snapshots = pruneSnaps([...(n.snapshots || []), rec]);
        n.year = label;
        if (o.grid) for (const c of n.classes) { n.grid[c] = n.grid[c] || {}; for (const d of n.days) n.grid[c][d] = emptyDay(n.periods.length); }
        if (o.locks) n.locked = {};
        if (o.subs) delete n.subs;
        if (o.versions) n.versions = [];
      });
      setMsg({ ok: true, text: `Welcome to ${label}! The old year is archived — restore it any time from Import / Export → Safety copies.` }); setOpen(false);
    } catch (e) { setMsg({ ok: false, text: "Couldn't start the new year: " + ((e && e.message) || e) }); }
    setBusy(false);
  });
  const chk = { display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" };
  return (
    <div style={{ ...card, marginBottom: 16 }}>
      <Panelhead text="Academic year" count={cfg.year || "not set"} tone={cfg.year ? "free" : undefined} />
      <div style={{ padding: 14, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 700, color: C.sub }}>Current year
            <input className="tt-in" value={cfg.year || ""} onChange={(e) => update((n) => { if (e.target.value.trim()) n.year = e.target.value; else delete n.year; })} style={{ width: 130, fontFamily: sans, fontSize: 13.5, fontWeight: 700, height: 36 }} />
          </label>
          <span style={{ fontSize: 12, color: C.sub }}>Printed on PDFs and the Excel file.</span>
          {!open && <button className="tt-btn" onClick={() => { setLabel(nextYearLabel(cfg.year)); setOpen(true); }} style={{ ...solidBtn, marginLeft: "auto" }}>Start a new academic year…</button>}
        </div>
        {msg && <div style={{ fontSize: 12.5, fontWeight: 600, color: msg.ok ? C.free : C.clash }}>{msg.text}</div>}
        {open && (
          <div style={{ border: `1.5px solid ${th.accent}44`, borderRadius: 14, padding: 14, display: "grid", gap: 12, background: "#fbfdfd" }}>
            <div className="tt-callout">Your <b>classes, teachers, mapping, standard periods, rules, combined subjects, logo and signature</b> are kept. The current year is saved as an <b>archive</b> you can restore any time.</div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 700, color: C.sub }}>New year
              <input className="tt-in" value={label} onChange={(e) => setLabel(e.target.value)} style={{ width: 130, fontFamily: sans, fontSize: 14, fontWeight: 800, height: 36 }} />
            </label>
            <div style={{ display: "grid", gap: 8 }}>
              <label style={chk}><input type="checkbox" checked={o.grid} onChange={(e) => setO({ ...o, grid: e.target.checked })} /> Clear the timetable (start the new year blank)</label>
              <label style={chk}><input type="checkbox" checked={o.locks} onChange={(e) => setO({ ...o, locks: e.target.checked })} /> Remove frozen periods</label>
              <label style={chk}><input type="checkbox" checked={o.subs} onChange={(e) => setO({ ...o, subs: e.target.checked })} /> Clear the substitution record</label>
              <label style={chk}><input type="checkbox" checked={o.versions} onChange={(e) => setO({ ...o, versions: e.target.checked })} /> Delete saved timetable versions</label>
              <label style={chk}><input type="checkbox" checked={o.backup} onChange={(e) => setO({ ...o, backup: e.target.checked })} /> Also download a backup file of the old year (.json)</label>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="tt-btn" disabled={busy || !label.trim()} onClick={start} style={solidBtn}>{busy ? "Starting…" : `Archive & start ${label}`}</button>
              <button className="tt-btn" onClick={() => setOpen(false)} style={ghostBtn}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
/* ---------------- Teacher links (read-only page for each teacher) ---------------- */
/* QR code generator: qrcode-generator 1.4.4 by Kazuhiko Arase, MIT licence (https://github.com/kazuhikoarase/qrcode-generator) */
var QRGEN=(()=>{var $=(L,T)=>()=>(T||L((T={exports:{}}).exports,T),T.exports);var z=$((V,q)=>{var W=function(){var L=function(x,w){var g=236,l=17,n=x,s=O[w],t=null,r=0,h=null,i=[],v={},_=function(a,f){r=n*4+17,t=function(e){for(var u=new Array(e),o=0;o<e;o+=1){u[o]=new Array(e);for(var d=0;d<e;d+=1)u[o][d]=null}return u}(r),B(0,0),B(r-7,0),B(0,r-7),E(),C(),m(a,f),n>=7&&N(a),h==null&&(h=vr(n,s,i)),U(h,f)},B=function(a,f){for(var e=-1;e<=7;e+=1)if(!(a+e<=-1||r<=a+e))for(var u=-1;u<=7;u+=1)f+u<=-1||r<=f+u||(0<=e&&e<=6&&(u==0||u==6)||0<=u&&u<=6&&(e==0||e==6)||2<=e&&e<=4&&2<=u&&u<=4?t[a+e][f+u]=!0:t[a+e][f+u]=!1)},y=function(){for(var a=0,f=0,e=0;e<8;e+=1){_(!0,e);var u=P.getLostPoint(v);(e==0||a>u)&&(a=u,f=e)}return f},C=function(){for(var a=8;a<r-8;a+=1)t[a][6]==null&&(t[a][6]=a%2==0);for(var f=8;f<r-8;f+=1)t[6][f]==null&&(t[6][f]=f%2==0)},E=function(){for(var a=P.getPatternPosition(n),f=0;f<a.length;f+=1)for(var e=0;e<a.length;e+=1){var u=a[f],o=a[e];if(t[u][o]==null)for(var d=-2;d<=2;d+=1)for(var c=-2;c<=2;c+=1)d==-2||d==2||c==-2||c==2||d==0&&c==0?t[u+d][o+c]=!0:t[u+d][o+c]=!1}},N=function(a){for(var f=P.getBCHTypeNumber(n),e=0;e<18;e+=1){var u=!a&&(f>>e&1)==1;t[Math.floor(e/3)][e%3+r-8-3]=u}for(var e=0;e<18;e+=1){var u=!a&&(f>>e&1)==1;t[e%3+r-8-3][Math.floor(e/3)]=u}},m=function(a,f){for(var e=s<<3|f,u=P.getBCHTypeInfo(e),o=0;o<15;o+=1){var d=!a&&(u>>o&1)==1;o<6?t[o][8]=d:o<8?t[o+1][8]=d:t[r-15+o][8]=d}for(var o=0;o<15;o+=1){var d=!a&&(u>>o&1)==1;o<8?t[8][r-o-1]=d:o<9?t[8][15-o-1+1]=d:t[8][15-o-1]=d}t[r-8][8]=!a},U=function(a,f){for(var e=-1,u=r-1,o=7,d=0,c=P.getMaskFunction(f),p=r-1;p>0;p-=2)for(p==6&&(p-=1);;){for(var b=0;b<2;b+=1)if(t[u][p-b]==null){var D=!1;d<a.length&&(D=(a[d]>>>o&1)==1);var A=c(u,p-b);A&&(D=!D),t[u][p-b]=D,o-=1,o==-1&&(d+=1,o=7)}if(u+=e,u<0||r<=u){u-=e,e=-e;break}}},H=function(a,f){for(var e=0,u=0,o=0,d=new Array(f.length),c=new Array(f.length),p=0;p<f.length;p+=1){var b=f[p].dataCount,D=f[p].totalCount-b;u=Math.max(u,b),o=Math.max(o,D),d[p]=new Array(b);for(var A=0;A<d[p].length;A+=1)d[p][A]=255&a.getBuffer()[A+e];e+=b;var R=P.getErrorCorrectPolynomial(D),I=K(d[p],R.getLength()-1),S=I.mod(R);c[p]=new Array(R.getLength()-1);for(var A=0;A<c[p].length;A+=1){var X=A+S.getLength()-c[p].length;c[p][A]=X>=0?S.getAt(X):0}}for(var Z=0,A=0;A<f.length;A+=1)Z+=f[A].totalCount;for(var J=new Array(Z),Q=0,A=0;A<u;A+=1)for(var p=0;p<f.length;p+=1)A<d[p].length&&(J[Q]=d[p][A],Q+=1);for(var A=0;A<o;A+=1)for(var p=0;p<f.length;p+=1)A<c[p].length&&(J[Q]=c[p][A],Q+=1);return J},vr=function(a,f,e){for(var u=Y.getRSBlocks(a,f),o=G(),d=0;d<e.length;d+=1){var c=e[d];o.put(c.getMode(),4),o.put(c.getLength(),P.getLengthInBits(c.getMode(),a)),c.write(o)}for(var p=0,d=0;d<u.length;d+=1)p+=u[d].dataCount;if(o.getLengthInBits()>p*8)throw"code length overflow. ("+o.getLengthInBits()+">"+p*8+")";for(o.getLengthInBits()+4<=p*8&&o.put(0,4);o.getLengthInBits()%8!=0;)o.putBit(!1);for(;!(o.getLengthInBits()>=p*8||(o.put(g,8),o.getLengthInBits()>=p*8));)o.put(l,8);return H(o,u)};v.addData=function(a,f){f=f||"Byte";var e=null;switch(f){case"Numeric":e=tr(a);break;case"Alphanumeric":e=er(a);break;case"Byte":e=nr(a);break;case"Kanji":e=ar(a);break;default:throw"mode:"+f}i.push(e),h=null},v.isDark=function(a,f){if(a<0||r<=a||f<0||r<=f)throw a+","+f;return t[a][f]},v.getModuleCount=function(){return r},v.make=function(){if(n<1){for(var a=1;a<40;a++){for(var f=Y.getRSBlocks(a,s),e=G(),u=0;u<i.length;u++){var o=i[u];e.put(o.getMode(),4),e.put(o.getLength(),P.getLengthInBits(o.getMode(),a)),o.write(e)}for(var d=0,u=0;u<f.length;u++)d+=f[u].dataCount;if(e.getLengthInBits()<=d*8)break}n=a}_(!1,y())},v.createTableTag=function(a,f){a=a||2,f=typeof f>"u"?a*4:f;var e="";e+='<table style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: "+f+"px;",e+='">',e+="<tbody>";for(var u=0;u<v.getModuleCount();u+=1){e+="<tr>";for(var o=0;o<v.getModuleCount();o+=1)e+='<td style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: 0px;",e+=" width: "+a+"px;",e+=" height: "+a+"px;",e+=" background-color: ",e+=v.isDark(u,o)?"#000000":"#ffffff",e+=";",e+='"/>';e+="</tr>"}return e+="</tbody>",e+="</table>",e},v.createSvgTag=function(a,f,e,u){var o={};typeof arguments[0]=="object"&&(o=arguments[0],a=o.cellSize,f=o.margin,e=o.alt,u=o.title),a=a||2,f=typeof f>"u"?a*4:f,e=typeof e=="string"?{text:e}:e||{},e.text=e.text||null,e.id=e.text?e.id||"qrcode-description":null,u=typeof u=="string"?{text:u}:u||{},u.text=u.text||null,u.id=u.text?u.id||"qrcode-title":null;var d=v.getModuleCount()*a+f*2,c,p,b,D,A="",R;for(R="l"+a+",0 0,"+a+" -"+a+",0 0,-"+a+"z ",A+='<svg version="1.1" xmlns="http://www.w3.org/2000/svg"',A+=o.scalable?"":' width="'+d+'px" height="'+d+'px"',A+=' viewBox="0 0 '+d+" "+d+'" ',A+=' preserveAspectRatio="xMinYMin meet"',A+=u.text||e.text?' role="img" aria-labelledby="'+F([u.id,e.id].join(" ").trim())+'"':"",A+=">",A+=u.text?'<title id="'+F(u.id)+'">'+F(u.text)+"</title>":"",A+=e.text?'<description id="'+F(e.id)+'">'+F(e.text)+"</description>":"",A+='<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>',A+='<path d="',b=0;b<v.getModuleCount();b+=1)for(D=b*a+f,c=0;c<v.getModuleCount();c+=1)v.isDark(b,c)&&(p=c*a+f,A+="M"+p+","+D+R);return A+='" stroke="transparent" fill="black"/>',A+="</svg>",A},v.createDataURL=function(a,f){a=a||2,f=typeof f>"u"?a*4:f;var e=v.getModuleCount()*a+f*2,u=f,o=e-f;return or(e,e,function(d,c){if(u<=d&&d<o&&u<=c&&c<o){var p=Math.floor((d-u)/a),b=Math.floor((c-u)/a);return v.isDark(b,p)?0:1}else return 1})},v.createImgTag=function(a,f,e){a=a||2,f=typeof f>"u"?a*4:f;var u=v.getModuleCount()*a+f*2,o="";return o+="<img",o+=' src="',o+=v.createDataURL(a,f),o+='"',o+=' width="',o+=u,o+='"',o+=' height="',o+=u,o+='"',e&&(o+=' alt="',o+=F(e),o+='"'),o+="/>",o};var F=function(a){for(var f="",e=0;e<a.length;e+=1){var u=a.charAt(e);switch(u){case"<":f+="&lt;";break;case">":f+="&gt;";break;case"&":f+="&amp;";break;case'"':f+="&quot;";break;default:f+=u;break}}return f},sr=function(a){var f=1;a=typeof a>"u"?f*2:a;var e=v.getModuleCount()*f+a*2,u=a,o=e-a,d,c,p,b,D,A={"\u2588\u2588":"\u2588","\u2588 ":"\u2580"," \u2588":"\u2584","  ":" "},R={"\u2588\u2588":"\u2580","\u2588 ":"\u2580"," \u2588":" ","  ":" "},I="";for(d=0;d<e;d+=2){for(p=Math.floor((d-u)/f),b=Math.floor((d+1-u)/f),c=0;c<e;c+=1)D="\u2588",u<=c&&c<o&&u<=d&&d<o&&v.isDark(p,Math.floor((c-u)/f))&&(D=" "),u<=c&&c<o&&u<=d+1&&d+1<o&&v.isDark(b,Math.floor((c-u)/f))?D+=" ":D+="\u2588",I+=a<1&&d+1>=o?R[D]:A[D];I+=`
`}return e%2&&a>0?I.substring(0,I.length-e-1)+Array(e+1).join("\u2580"):I.substring(0,I.length-1)};return v.createASCII=function(a,f){if(a=a||1,a<2)return sr(f);a-=1,f=typeof f>"u"?a*2:f;var e=v.getModuleCount()*a+f*2,u=f,o=e-f,d,c,p,b,D=Array(a+1).join("\u2588\u2588"),A=Array(a+1).join("  "),R="",I="";for(d=0;d<e;d+=1){for(p=Math.floor((d-u)/a),I="",c=0;c<e;c+=1)b=1,u<=c&&c<o&&u<=d&&d<o&&v.isDark(p,Math.floor((c-u)/a))&&(b=0),I+=b?D:A;for(p=0;p<a;p+=1)R+=I+`
`}return R.substring(0,R.length-1)},v.renderTo2dContext=function(a,f){f=f||2;for(var e=v.getModuleCount(),u=0;u<e;u++)for(var o=0;o<e;o++)a.fillStyle=v.isDark(u,o)?"black":"white",a.fillRect(u*f,o*f,f,f)},v};L.stringToBytesFuncs={default:function(x){for(var w=[],g=0;g<x.length;g+=1){var l=x.charCodeAt(g);w.push(l&255)}return w}},L.stringToBytes=L.stringToBytesFuncs.default,L.createStringToBytes=function(x,w){var g=function(){for(var n=ir(x),s=function(){var C=n.read();if(C==-1)throw"eof";return C},t=0,r={};;){var h=n.read();if(h==-1)break;var i=s(),v=s(),_=s(),B=String.fromCharCode(h<<8|i),y=v<<8|_;r[B]=y,t+=1}if(t!=w)throw t+" != "+w;return r}(),l=63;return function(n){for(var s=[],t=0;t<n.length;t+=1){var r=n.charCodeAt(t);if(r<128)s.push(r);else{var h=g[n.charAt(t)];typeof h=="number"?(h&255)==h?s.push(h):(s.push(h>>>8),s.push(h&255)):s.push(l)}}return s}};var T={MODE_NUMBER:1,MODE_ALPHA_NUM:2,MODE_8BIT_BYTE:4,MODE_KANJI:8},O={L:1,M:0,Q:3,H:2},k={PATTERN000:0,PATTERN001:1,PATTERN010:2,PATTERN011:3,PATTERN100:4,PATTERN101:5,PATTERN110:6,PATTERN111:7},P=function(){var x=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],w=1335,g=7973,l=21522,n={},s=function(t){for(var r=0;t!=0;)r+=1,t>>>=1;return r};return n.getBCHTypeInfo=function(t){for(var r=t<<10;s(r)-s(w)>=0;)r^=w<<s(r)-s(w);return(t<<10|r)^l},n.getBCHTypeNumber=function(t){for(var r=t<<12;s(r)-s(g)>=0;)r^=g<<s(r)-s(g);return t<<12|r},n.getPatternPosition=function(t){return x[t-1]},n.getMaskFunction=function(t){switch(t){case k.PATTERN000:return function(r,h){return(r+h)%2==0};case k.PATTERN001:return function(r,h){return r%2==0};case k.PATTERN010:return function(r,h){return h%3==0};case k.PATTERN011:return function(r,h){return(r+h)%3==0};case k.PATTERN100:return function(r,h){return(Math.floor(r/2)+Math.floor(h/3))%2==0};case k.PATTERN101:return function(r,h){return r*h%2+r*h%3==0};case k.PATTERN110:return function(r,h){return(r*h%2+r*h%3)%2==0};case k.PATTERN111:return function(r,h){return(r*h%3+(r+h)%2)%2==0};default:throw"bad maskPattern:"+t}},n.getErrorCorrectPolynomial=function(t){for(var r=K([1],0),h=0;h<t;h+=1)r=r.multiply(K([1,M.gexp(h)],0));return r},n.getLengthInBits=function(t,r){if(1<=r&&r<10)switch(t){case T.MODE_NUMBER:return 10;case T.MODE_ALPHA_NUM:return 9;case T.MODE_8BIT_BYTE:return 8;case T.MODE_KANJI:return 8;default:throw"mode:"+t}else if(r<27)switch(t){case T.MODE_NUMBER:return 12;case T.MODE_ALPHA_NUM:return 11;case T.MODE_8BIT_BYTE:return 16;case T.MODE_KANJI:return 10;default:throw"mode:"+t}else if(r<41)switch(t){case T.MODE_NUMBER:return 14;case T.MODE_ALPHA_NUM:return 13;case T.MODE_8BIT_BYTE:return 16;case T.MODE_KANJI:return 12;default:throw"mode:"+t}else throw"type:"+r},n.getLostPoint=function(t){for(var r=t.getModuleCount(),h=0,i=0;i<r;i+=1)for(var v=0;v<r;v+=1){for(var _=0,B=t.isDark(i,v),y=-1;y<=1;y+=1)if(!(i+y<0||r<=i+y))for(var C=-1;C<=1;C+=1)v+C<0||r<=v+C||y==0&&C==0||B==t.isDark(i+y,v+C)&&(_+=1);_>5&&(h+=3+_-5)}for(var i=0;i<r-1;i+=1)for(var v=0;v<r-1;v+=1){var E=0;t.isDark(i,v)&&(E+=1),t.isDark(i+1,v)&&(E+=1),t.isDark(i,v+1)&&(E+=1),t.isDark(i+1,v+1)&&(E+=1),(E==0||E==4)&&(h+=3)}for(var i=0;i<r;i+=1)for(var v=0;v<r-6;v+=1)t.isDark(i,v)&&!t.isDark(i,v+1)&&t.isDark(i,v+2)&&t.isDark(i,v+3)&&t.isDark(i,v+4)&&!t.isDark(i,v+5)&&t.isDark(i,v+6)&&(h+=40);for(var v=0;v<r;v+=1)for(var i=0;i<r-6;i+=1)t.isDark(i,v)&&!t.isDark(i+1,v)&&t.isDark(i+2,v)&&t.isDark(i+3,v)&&t.isDark(i+4,v)&&!t.isDark(i+5,v)&&t.isDark(i+6,v)&&(h+=40);for(var N=0,v=0;v<r;v+=1)for(var i=0;i<r;i+=1)t.isDark(i,v)&&(N+=1);var m=Math.abs(100*N/r/r-50)/5;return h+=m*10,h},n}(),M=function(){for(var x=new Array(256),w=new Array(256),g=0;g<8;g+=1)x[g]=1<<g;for(var g=8;g<256;g+=1)x[g]=x[g-4]^x[g-5]^x[g-6]^x[g-8];for(var g=0;g<255;g+=1)w[x[g]]=g;var l={};return l.glog=function(n){if(n<1)throw"glog("+n+")";return w[n]},l.gexp=function(n){for(;n<0;)n+=255;for(;n>=256;)n-=255;return x[n]},l}();function K(x,w){if(typeof x.length>"u")throw x.length+"/"+w;var g=function(){for(var n=0;n<x.length&&x[n]==0;)n+=1;for(var s=new Array(x.length-n+w),t=0;t<x.length-n;t+=1)s[t]=x[t+n];return s}(),l={};return l.getAt=function(n){return g[n]},l.getLength=function(){return g.length},l.multiply=function(n){for(var s=new Array(l.getLength()+n.getLength()-1),t=0;t<l.getLength();t+=1)for(var r=0;r<n.getLength();r+=1)s[t+r]^=M.gexp(M.glog(l.getAt(t))+M.glog(n.getAt(r)));return K(s,0)},l.mod=function(n){if(l.getLength()-n.getLength()<0)return l;for(var s=M.glog(l.getAt(0))-M.glog(n.getAt(0)),t=new Array(l.getLength()),r=0;r<l.getLength();r+=1)t[r]=l.getAt(r);for(var r=0;r<n.getLength();r+=1)t[r]^=M.gexp(M.glog(n.getAt(r))+s);return K(t,0).mod(n)},l}var Y=function(){var x=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],w=function(n,s){var t={};return t.totalCount=n,t.dataCount=s,t},g={},l=function(n,s){switch(s){case O.L:return x[(n-1)*4+0];case O.M:return x[(n-1)*4+1];case O.Q:return x[(n-1)*4+2];case O.H:return x[(n-1)*4+3];default:return}};return g.getRSBlocks=function(n,s){var t=l(n,s);if(typeof t>"u")throw"bad rs block @ typeNumber:"+n+"/errorCorrectionLevel:"+s;for(var r=t.length/3,h=[],i=0;i<r;i+=1)for(var v=t[i*3+0],_=t[i*3+1],B=t[i*3+2],y=0;y<v;y+=1)h.push(w(_,B));return h},g}(),G=function(){var x=[],w=0,g={};return g.getBuffer=function(){return x},g.getAt=function(l){var n=Math.floor(l/8);return(x[n]>>>7-l%8&1)==1},g.put=function(l,n){for(var s=0;s<n;s+=1)g.putBit((l>>>n-s-1&1)==1)},g.getLengthInBits=function(){return w},g.putBit=function(l){var n=Math.floor(w/8);x.length<=n&&x.push(0),l&&(x[n]|=128>>>w%8),w+=1},g},tr=function(x){var w=T.MODE_NUMBER,g=x,l={};l.getMode=function(){return w},l.getLength=function(t){return g.length},l.write=function(t){for(var r=g,h=0;h+2<r.length;)t.put(n(r.substring(h,h+3)),10),h+=3;h<r.length&&(r.length-h==1?t.put(n(r.substring(h,h+1)),4):r.length-h==2&&t.put(n(r.substring(h,h+2)),7))};var n=function(t){for(var r=0,h=0;h<t.length;h+=1)r=r*10+s(t.charAt(h));return r},s=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-48;throw"illegal char :"+t};return l},er=function(x){var w=T.MODE_ALPHA_NUM,g=x,l={};l.getMode=function(){return w},l.getLength=function(s){return g.length},l.write=function(s){for(var t=g,r=0;r+1<t.length;)s.put(n(t.charAt(r))*45+n(t.charAt(r+1)),11),r+=2;r<t.length&&s.put(n(t.charAt(r)),6)};var n=function(s){if("0"<=s&&s<="9")return s.charCodeAt(0)-48;if("A"<=s&&s<="Z")return s.charCodeAt(0)-65+10;switch(s){case" ":return 36;case"$":return 37;case"%":return 38;case"*":return 39;case"+":return 40;case"-":return 41;case".":return 42;case"/":return 43;case":":return 44;default:throw"illegal char :"+s}};return l},nr=function(x){var w=T.MODE_8BIT_BYTE,g=x,l=L.stringToBytes(x),n={};return n.getMode=function(){return w},n.getLength=function(s){return l.length},n.write=function(s){for(var t=0;t<l.length;t+=1)s.put(l[t],8)},n},ar=function(x){var w=T.MODE_KANJI,g=x,l=L.stringToBytesFuncs.SJIS;if(!l)throw"sjis not supported.";(function(t,r){var h=l(t);if(h.length!=2||(h[0]<<8|h[1])!=r)throw"sjis not supported."})("\u53CB",38726);var n=l(x),s={};return s.getMode=function(){return w},s.getLength=function(t){return~~(n.length/2)},s.write=function(t){for(var r=n,h=0;h+1<r.length;){var i=(255&r[h])<<8|255&r[h+1];if(33088<=i&&i<=40956)i-=33088;else if(57408<=i&&i<=60351)i-=49472;else throw"illegal char at "+(h+1)+"/"+i;i=(i>>>8&255)*192+(i&255),t.put(i,13),h+=2}if(h<r.length)throw"illegal char at "+(h+1)},s},j=function(){var x=[],w={};return w.writeByte=function(g){x.push(g&255)},w.writeShort=function(g){w.writeByte(g),w.writeByte(g>>>8)},w.writeBytes=function(g,l,n){l=l||0,n=n||g.length;for(var s=0;s<n;s+=1)w.writeByte(g[s+l])},w.writeString=function(g){for(var l=0;l<g.length;l+=1)w.writeByte(g.charCodeAt(l))},w.toByteArray=function(){return x},w.toString=function(){var g="";g+="[";for(var l=0;l<x.length;l+=1)l>0&&(g+=","),g+=x[l];return g+="]",g},w},fr=function(){var x=0,w=0,g=0,l="",n={},s=function(r){l+=String.fromCharCode(t(r&63))},t=function(r){if(!(r<0)){if(r<26)return 65+r;if(r<52)return 97+(r-26);if(r<62)return 48+(r-52);if(r==62)return 43;if(r==63)return 47}throw"n:"+r};return n.writeByte=function(r){for(x=x<<8|r&255,w+=8,g+=1;w>=6;)s(x>>>w-6),w-=6},n.flush=function(){if(w>0&&(s(x<<6-w),x=0,w=0),g%3!=0)for(var r=3-g%3,h=0;h<r;h+=1)l+="="},n.toString=function(){return l},n},ir=function(x){var w=x,g=0,l=0,n=0,s={};s.read=function(){for(;n<8;){if(g>=w.length){if(n==0)return-1;throw"unexpected end of file./"+n}var r=w.charAt(g);if(g+=1,r=="=")return n=0,-1;if(r.match(/^\s$/))continue;l=l<<6|t(r.charCodeAt(0)),n+=6}var h=l>>>n-8&255;return n-=8,h};var t=function(r){if(65<=r&&r<=90)return r-65;if(97<=r&&r<=122)return r-97+26;if(48<=r&&r<=57)return r-48+52;if(r==43)return 62;if(r==47)return 63;throw"c:"+r};return s},ur=function(x,w){var g=x,l=w,n=new Array(x*w),s={};s.setPixel=function(i,v,_){n[v*g+i]=_},s.write=function(i){i.writeString("GIF87a"),i.writeShort(g),i.writeShort(l),i.writeByte(128),i.writeByte(0),i.writeByte(0),i.writeByte(0),i.writeByte(0),i.writeByte(0),i.writeByte(255),i.writeByte(255),i.writeByte(255),i.writeString(","),i.writeShort(0),i.writeShort(0),i.writeShort(g),i.writeShort(l),i.writeByte(0);var v=2,_=r(v);i.writeByte(v);for(var B=0;_.length-B>255;)i.writeByte(255),i.writeBytes(_,B,255),B+=255;i.writeByte(_.length-B),i.writeBytes(_,B,_.length-B),i.writeByte(0),i.writeString(";")};var t=function(i){var v=i,_=0,B=0,y={};return y.write=function(C,E){if(C>>>E)throw"length over";for(;_+E>=8;)v.writeByte(255&(C<<_|B)),E-=8-_,C>>>=8-_,B=0,_=0;B=C<<_|B,_=_+E},y.flush=function(){_>0&&v.writeByte(B)},y},r=function(i){for(var v=1<<i,_=(1<<i)+1,B=i+1,y=h(),C=0;C<v;C+=1)y.add(String.fromCharCode(C));y.add(String.fromCharCode(v)),y.add(String.fromCharCode(_));var E=j(),N=t(E);N.write(v,B);var m=0,U=String.fromCharCode(n[m]);for(m+=1;m<n.length;){var H=String.fromCharCode(n[m]);m+=1,y.contains(U+H)?U=U+H:(N.write(y.indexOf(U),B),y.size()<4095&&(y.size()==1<<B&&(B+=1),y.add(U+H)),U=H)}return N.write(y.indexOf(U),B),N.write(_,B),N.flush(),E.toByteArray()},h=function(){var i={},v=0,_={};return _.add=function(B){if(_.contains(B))throw"dup key:"+B;i[B]=v,v+=1},_.size=function(){return v},_.indexOf=function(B){return i[B]},_.contains=function(B){return typeof i[B]<"u"},_};return s},or=function(x,w,g){for(var l=ur(x,w),n=0;n<w;n+=1)for(var s=0;s<x;s+=1)l.setPixel(s,n,g(s,n));var t=j();l.write(t);for(var r=fr(),h=t.toByteArray(),i=0;i<h.length;i+=1)r.writeByte(h[i]);return r.flush(),"data:image/gif;base64,"+r};return L}();(function(){W.stringToBytesFuncs["UTF-8"]=function(L){function T(O){for(var k=[],P=0;P<O.length;P++){var M=O.charCodeAt(P);M<128?k.push(M):M<2048?k.push(192|M>>6,128|M&63):M<55296||M>=57344?k.push(224|M>>12,128|M>>6&63,128|M&63):(P++,M=65536+((M&1023)<<10|O.charCodeAt(P)&1023),k.push(240|M>>18,128|M>>12&63,128|M>>6&63,128|M&63))}return k}return T(L)}})();(function(L){typeof define=="function"&&define.amd?define([],L):typeof V=="object"&&(q.exports=L())})(function(){return W})});var hr=$((lr,rr)=>{rr.exports=z()});return hr();})();
function qrSvg(text, cell) {
  try { const q = QRGEN(0, "M"); q.addData(text); q.make(); return q.createSvgTag({ cellSize: cell || 4, margin: 2, scalable: true }); } catch (e) { return ""; }
}
function newToken() {
  const a = "abcdefghijkmnpqrstuvwxyz23456789"; let s = "";
  try { const u = new Uint8Array(10); crypto.getRandomValues(u); u.forEach((x) => (s += a[x % a.length])); } catch (e) { for (let i = 0; i < 10; i++) s += a[Math.floor(Math.random() * a.length)]; }
  return s;
}
function teacherLinkBase() { try { return window.location.origin.startsWith("http") ? window.location.origin : "https://your-app.vercel.app"; } catch (e) { return "https://your-app.vercel.app"; } }
function teacherLink(cfg, t) { const tk = ((cfg.teacherLinks || {}).tokens || {})[t]; return tk ? `${teacherLinkBase()}/?t=${tk}` : ""; }
function buildTeacherPages(cfg) {
  const L = leisureData(cfg), tk = (cfg.teacherLinks || {}).tokens || {};
  const today = isoToday(), dates = Array.from({ length: 8 }, (_, i) => isoShift(today, i));
  const by = {};
  const ent = (t, dt) => ((by[t] || (by[t] = {}))[dt] || (by[t][dt] = { cover: [], coveredBy: [] }));
  for (const dt of dates) {
    const rec = (cfg.subs || {})[dt]; if (!rec) continue;
    const a = rec.assign || {};
    for (const t of Object.keys(rec.absent || {})) ent(t, dt).absent = rec.absent[t];
    for (const n of subsNeeds(cfg, dt)) { const u = a[n.key]; ent(n.t, dt).coveredBy.push({ p: n.p, cls: n.cls, sub: n.sub, by: u || null }); if (u) ent(u, dt).cover.push({ p: n.p, cls: n.cls, sub: n.sub, for: n.t }); }
  }
  const rows = [{ token: "_school", data: { school: cfg.school || "", year: cfg.year || "", logo: cfg.logoIcon || cfg.logo || "", days: cfg.days, periods: cfg.periods, dayNames: Object.fromEntries(cfg.days.map((d) => [d, DAY_FULL[d] || d])), fn: fnCount(cfg) } }];
  for (const t of cfg.singles) {
    const token = tk[t]; if (!token) continue;
    const week = {}; let load = 0;
    for (const d of cfg.days) week[d] = cfg.periods.map((_, p) => { const b = L.busy[t] && L.busy[t][d] ? L.busy[t][d][p] : null; if (b === "off") return "off"; if (!b) return null; load++; return { c: b.c, s: b.sub, k: b.combined ? 1 : 0 }; });
    rows.push({ token, data: { t, ct: cfg.classes.filter((c) => cfg.classTeacher[c] === t), week, load, free: L.week[t], subs: by[t] || {} } });
  }
  return rows;
}
function exportQrCardsPDF(cfg, list) {
  const css = "@page{size:A4 portrait;margin:10mm} *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box} body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#16213a}" +
    " .g{display:grid;grid-template-columns:repeat(3,1fr);gap:6mm} .cd{border:1.5px dashed #9fb7bb;border-radius:4mm;padding:4mm;text-align:center;page-break-inside:avoid;height:84mm;display:flex;flex-direction:column;align-items:center;justify-content:space-between}" +
    " .sc{font-size:9.5px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#0a4f55;display:flex;align-items:center;gap:5px} .sc img{height:16px} .t{font-family:'Courier New',monospace;font-size:22px;font-weight:800;color:#0a3d42} .q svg{width:44mm;height:44mm} .h{font-size:10px;color:#4b5870}";
  const cards = list.map((t) => { const url = teacherLink(cfg, t); return `<div class="cd"><div class="sc">${cfg.logo ? `<img src="${cfg.logo}" alt="">` : ""}${esc(cfg.school || "")}</div><div class="t">${esc(t)}</div><div class="q">${qrSvg(url, 4)}</div><div class="h">Scan to see your timetable<br>and substitutions</div></div>`; }).join("");
  openPrint(esc(cfg.school) + " - Teacher QR cards", css, `<div class="g">${cards}</div>`);
}
function ShareLinkButton({ cfg, t }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const url = teacherLink(cfg, t);
  if (!(cfg.teacherLinks || {}).on || !url) return null;
  const copy = async () => { try { await navigator.clipboard.writeText(url); setMsg("Link copied"); } catch (e) { setMsg("Couldn't copy"); } };
  return (
    <span style={{ position: "relative" }}>
      <PrintBtn onClick={() => setOpen(!open)} icon="download" light label="Share link" sub={`${t}'s own page`} />
      {open && (
        <div style={{ position: "absolute", right: 0, top: "110%", zIndex: 40, width: 280, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 14, boxShadow: "0 12px 30px rgba(0,0,0,.18)", padding: 14, textAlign: "center" }}>
          <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>{t}'s timetable link</div>
          <div dangerouslySetInnerHTML={{ __html: qrSvg(url, 4) }} style={{ width: 160, height: 160, margin: "0 auto" }} />
          <div style={{ fontSize: 11, color: C.sub, wordBreak: "break-all", margin: "6px 0 10px" }}>{url}</div>
          <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
            <button className="tt-btn" onClick={copy} style={{ ...ghostBtn, padding: "5px 10px", fontSize: 12 }}>Copy</button>
            <button className="tt-btn" onClick={() => { try { window.open("https://wa.me/?text=" + encodeURIComponent(`Your timetable (${cfg.school || ""}): ${url}`), "_blank"); } catch (e) { /* ignore */ } }} style={{ ...ghostBtn, padding: "5px 10px", fontSize: 12, color: "#128c4b" }}>WhatsApp</button>
            <button className="tt-btn" onClick={() => setOpen(false)} style={{ ...ghostBtn, padding: "5px 10px", fontSize: 12 }}>Close</button>
          </div>
          {msg && <div style={{ fontSize: 12, color: C.free, fontWeight: 700, marginTop: 6 }}>{msg}</div>}
        </div>
      )}
    </span>
  );
}
const TEACHER_SQL = `-- Teacher links: run once in Supabase → SQL Editor → New query → Run
create table if not exists public.teacher_pages (
  token text primary key, data jsonb not null, updated_at timestamptz not null default now()
);
alter table public.teacher_pages enable row level security;
drop policy if exists "staff manage teacher pages" on public.teacher_pages;
create policy "staff manage teacher pages" on public.teacher_pages
  for all to authenticated using (true) with check (true);
create or replace function public.get_teacher_page(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select data || jsonb_build_object('_at', updated_at) from public.teacher_pages where token = p_token
$$;
revoke all on function public.get_teacher_page(text) from public;
grant execute on function public.get_teacher_page(text) to anon, authenticated;`;
function TeacherLinksPanel({ cfg, update, ask, pubState, publishNow, mobile }) {
  const [q, setQ] = useState("");
  const [qr, setQr] = useState("");
  const [msg, setMsg] = useState("");
  const th = CUR_TH || THEMES.teal;
  const on = !!(cfg.teacherLinks || {}).on;
  const list = cfg.singles.filter((t) => !q.trim() || t.toLowerCase().includes(q.trim().toLowerCase()));
  const turnOn = () => update((n) => { const tk = { ...((n.teacherLinks || {}).tokens || {}) }; n.singles.forEach((t) => { if (!tk[t]) tk[t] = newToken(); }); n.teacherLinks = { on: true, tokens: tk }; });
  const turnOff = () => ask("Turn teacher links off? Every teacher's link stops working until you turn them on again (the same links come back).", () => { update((n) => { n.teacherLinks = { ...(n.teacherLinks || {}), on: false }; }); publishNow([]); });
  const renew = (t) => ask(`Make a new link for ${t}? The old link stops working — send ${t} the new one.`, () => update((n) => { n.teacherLinks = { ...(n.teacherLinks || {}), tokens: { ...((n.teacherLinks || {}).tokens || {}), [t]: newToken() } }; }));
  const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); setMsg(`${what} copied.`); } catch (e) { setMsg("Couldn't copy on this device."); } };
  const allText = cfg.singles.map((t) => `${t}: ${teacherLink(cfg, t)}`).join("\n");
  const fmt = (x) => new Date(x).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return (
    <div style={{ ...card, padding: 18, position: "relative" }}>
      <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: `linear-gradient(180deg, ${th.g1}, ${th.g2})` }} />
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ width: 40, height: 40, borderRadius: 12, display: "grid", placeItems: "center", background: `${th.accent}14`, color: th.accent, flexShrink: 0 }}><Icon name="teachers" size={19} /></span>
        <div style={{ fontSize: 15.5, fontWeight: 800, color: C.ink }}>Teacher links — each teacher's own timetable page</div>
        <span style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 700, padding: "2px 10px", borderRadius: 20, background: on ? C.freeSoft : "#eef1f5", color: on ? C.free : C.sub }}>{on ? "on" : "off"}</span>
      </div>
      <div className="tt-callout" style={{ marginBottom: 12 }}>Every teacher gets a private link (and QR code) that opens <b>only their timetable, today's periods and their substitution duties</b> — on any phone, with no login and nothing to install. It is read-only and updates by itself a few seconds after you save. It costs nothing on your free Supabase and Vercel plans.</div>
      {!on ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 800 }}>One-time setup</div>
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.8, color: C.ink }}>
            <li>Open <b>supabase.com</b> → your project → <b>SQL Editor</b> → <b>New query</b>, paste the code below and press <b>Run</b>.</li>
            <li>Make sure the new <b>main.jsx</b>, <b>TeacherPage.jsx</b> and <b>storage.js</b> are in your <b>src</b> folder and redeployed.</li>
            <li>Press <b>Turn on teacher links</b>.</li>
          </ol>
          <pre style={{ margin: 0, background: "#0f1b2d", color: "#d6f5ee", padding: 12, borderRadius: 10, fontSize: 11.5, overflowX: "auto", maxHeight: 200 }}>{TEACHER_SQL}</pre>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="tt-btn" onClick={() => copy(TEACHER_SQL, "SQL")} style={ghostBtn}>Copy SQL</button>
            <button className="tt-btn" onClick={turnOn} style={solidBtn}>Turn on teacher links</button>
          </div>
          {msg && <div style={{ fontSize: 12.5, color: C.free, fontWeight: 600 }}>{msg}</div>}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12.5 }}>
            {pubState ? (pubState.ok ? <span style={{ color: C.free, fontWeight: 700 }}>✓ Pages up to date ({fmt(pubState.at)}{pubState.sent ? ` · ${pubState.sent} updated` : ""})</span>
              : <span style={{ color: C.clash, fontWeight: 700 }}>Couldn't publish: {pubState.error}. {/teacher_pages|function|schema|relation/i.test(pubState.error || "") ? "Run the setup SQL in Supabase first." : ""}</span>) : <span style={{ color: C.sub }}>Pages are published a few seconds after each save.</span>}
            <button className="tt-btn" onClick={() => publishNow()} style={{ ...ghostBtn, padding: "5px 10px", fontSize: 12 }}>Publish now</button>
            <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
              <PrintBtn onClick={() => exportQrCardsPDF(cfg, cfg.singles)} icon="pdf" label="Print QR cards" sub="A4 · 9 per page" />
              <button className="tt-btn" onClick={() => copy(allText, "All links")} style={ghostBtn}>Copy all links</button>
              <button className="tt-btn" onClick={turnOff} style={{ ...ghostBtn, color: C.clash }}>Turn off</button>
            </span>
          </div>
          {msg && <div style={{ fontSize: 12.5, color: C.free, fontWeight: 600 }}>{msg}</div>}
          <input className="tt-in" placeholder="Search teacher" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260, fontFamily: sans, fontSize: 13, height: 34 }} />
          <div className="tt-scroll" style={{ maxHeight: 420, overflowY: "auto", display: "grid", gap: 6 }}>
            {list.map((t) => { const url = teacherLink(cfg, t); return (
              <div key={t} style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: "8px 10px", display: "grid", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <b style={{ fontFamily: mono, minWidth: 64 }}>{t}</b>
                  <span style={{ flex: "1 1 200px", minWidth: 0, fontSize: 12, color: C.sub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: mobile ? "normal" : "nowrap", wordBreak: "break-all" }}>{url}</span>
                  <span style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    <button className="tt-btn" onClick={() => copy(url, `${t}'s link`)} style={{ ...ghostBtn, padding: "4px 9px", fontSize: 12 }}>Copy</button>
                    <button className="tt-btn" onClick={() => { try { window.open("https://wa.me/?text=" + encodeURIComponent(`Your timetable (${cfg.school || ""}): ${url}`), "_blank"); } catch (e) { /* ignore */ } }} style={{ ...ghostBtn, padding: "4px 9px", fontSize: 12, color: "#128c4b" }}>WhatsApp</button>
                    <button className="tt-btn" onClick={() => setQr(qr === t ? "" : t)} style={{ ...ghostBtn, padding: "4px 9px", fontSize: 12 }}>{qr === t ? "Hide QR" : "QR"}</button>
                    <button className="tt-btn" onClick={() => window.open(url, "_blank")} style={{ ...ghostBtn, padding: "4px 9px", fontSize: 12 }}>Open</button>
                    <button className="tt-btn" onClick={() => renew(t)} title="Make a new link (the old one stops working)" style={{ ...ghostBtn, padding: "4px 9px", fontSize: 12, color: C.sub }}>New link</button>
                  </span>
                </div>
                {qr === t && <div dangerouslySetInnerHTML={{ __html: qrSvg(url, 4) }} style={{ width: 170, height: 170 }} />}
              </div>); })}
          </div>
        </div>
      )}
    </div>
  );
}
/* ---------------- Crop before upload ---------------- */
function fnCount(cfg) { const P = cfg.periods.length, v = Number(cfg.fnCount); return P <= 1 ? P : Math.max(1, Math.min(P - 1, v > 0 ? v : Math.ceil(P / 2))); }
function fnCss(cfg) { const n = fnCount(cfg); return n > 0 && n < cfg.periods.length ? ` tr>*:nth-child(${n + 2}){border-left:3px solid #d98a2b!important}` : ""; }
function rotateDataUrl(src, deg) {
  return loadImg(src).then((img) => {
    const w = img.naturalWidth, h = img.naturalHeight, cv = document.createElement("canvas");
    cv.width = deg % 180 ? h : w; cv.height = deg % 180 ? w : h;
    const x = cv.getContext("2d"); x.translate(cv.width / 2, cv.height / 2); x.rotate((deg * Math.PI) / 180); x.drawImage(img, -w / 2, -h / 2);
    return cv.toDataURL("image/png");
  });
}
function CropModal({ src: src0, title, square, onDone, onCancel }) {
  const [src, setSrc] = useState(src0);
  const [nat, setNat] = useState(null);       // natural size
  const [box, setBox] = useState(null);       // crop box in image pixels {x,y,w,h}
  const [aspect, setAspect] = useState(square ? "sq" : "free");
  const wrapRef = useRef(null);
  const drag = useRef(null);
  const th = CUR_TH || THEMES.teal;
  useEffect(() => { let ok = true; loadImg(src).then((img) => { if (!ok) return; const w = img.naturalWidth, h = img.naturalHeight; setNat({ w, h }); const m = Math.round(Math.min(w, h) * 0.04); let b = { x: m, y: m, w: w - 2 * m, h: h - 2 * m }; if (aspect === "sq") { const s = Math.min(b.w, b.h); b = { x: (w - s) / 2, y: (h - s) / 2, w: s, h: s }; } setBox(b); }).catch(() => onCancel()); return () => { ok = false; }; }, [src]);
  const maxW = Math.min(typeof window !== "undefined" ? window.innerWidth - 56 : 600, 640), maxH = typeof window !== "undefined" ? Math.round(window.innerHeight * 0.55) : 420;
  const sc = nat ? Math.min(maxW / nat.w, maxH / nat.h, 1.5) : 1;
  const dw = nat ? nat.w * sc : 0, dh = nat ? nat.h * sc : 0;
  const clampBox = (b) => { const minS = Math.max(12, 24 / sc); let { x, y, w, h } = b; w = Math.max(minS, Math.min(w, nat.w)); h = Math.max(minS, Math.min(h, nat.h)); x = Math.max(0, Math.min(x, nat.w - w)); y = Math.max(0, Math.min(y, nat.h - h)); return { x, y, w, h }; };
  const start = (mode) => (e) => { e.preventDefault(); e.stopPropagation(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ } drag.current = { mode, sx: e.clientX, sy: e.clientY, b: { ...box } }; };
  const move = (e) => {
    const g = drag.current; if (!g || !nat) return;
    const dx = (e.clientX - g.sx) / sc, dy = (e.clientY - g.sy) / sc; let { x, y, w, h } = g.b;
    if (g.mode === "move") { x += dx; y += dy; }
    else {
      if (g.mode.includes("l")) { x += dx; w -= dx; } if (g.mode.includes("r")) w += dx;
      if (g.mode.includes("t")) { y += dy; h -= dy; } if (g.mode.includes("b")) h += dy;
      if (aspect === "sq") { const s = Math.max(w, h); if (g.mode.includes("l")) x -= s - w; if (g.mode.includes("t")) y -= s - h; w = s; h = s; }
    }
    setBox(clampBox({ x, y, w, h }));
  };
  const end = () => { drag.current = null; };
  const setSq = (v) => { setAspect(v); if (v === "sq" && box) { const s = Math.min(box.w, box.h); setBox(clampBox({ x: box.x + (box.w - s) / 2, y: box.y + (box.h - s) / 2, w: s, h: s })); } };
  const rotate = async () => { try { const r = await rotateDataUrl(src, 90); setBox(null); setNat(null); setSrc(r); } catch (e) { /* ignore */ } };
  const finish = async (whole) => {
    try {
      const img = await loadImg(src), b = whole || !box ? { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight } : box;
      const cv = document.createElement("canvas"); cv.width = Math.round(b.w); cv.height = Math.round(b.h);
      cv.getContext("2d").drawImage(img, b.x, b.y, b.w, b.h, 0, 0, cv.width, cv.height);
      onDone(cv.toDataURL("image/png"));
    } catch (e) { onCancel(); }
  };
  const handle = (pos, cur) => {
    const s = 22, st = { position: "absolute", width: s, height: s, background: "#fff", border: `3px solid ${th.accent}`, borderRadius: 6, touchAction: "none", cursor: cur, boxShadow: "0 1px 4px rgba(0,0,0,.3)" };
    if (pos.includes("t")) st.top = -s / 2; if (pos.includes("b")) st.bottom = -s / 2; if (pos.includes("l")) st.left = -s / 2; if (pos.includes("r")) st.right = -s / 2;
    return <span key={pos} onPointerDown={start(pos)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} style={st} />;
  };
  const seg = (on) => ({ border: "none", padding: "6px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", background: on ? th.accent : "transparent", color: on ? "#fff" : C.sub });
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(16,25,40,.6)", zIndex: 120, display: "grid", placeItems: "center", padding: 10 }}>
      <div style={{ background: "#fff", borderRadius: 16, padding: 16, width: "min(680px, 96vw)", maxHeight: "96vh", overflow: "auto", display: "grid", gap: 12, boxShadow: "0 20px 50px rgba(0,0,0,.35)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Crop {title}</div>
          <span style={{ fontSize: 12, color: C.sub }}>Drag the box or its corners to keep only the part you need.</span>
        </div>
        <div style={{ display: "grid", placeItems: "center", background: "repeating-conic-gradient(#eef1f5 0 25%, #ffffff 0 50%) 0 0 / 16px 16px", borderRadius: 12, padding: 14, minHeight: 160 }}>
          {!nat || !box ? <span style={{ display: "inline-flex", gap: 8, alignItems: "center", color: C.sub, fontSize: 13 }}><span className="tt-spin" />Loading…</span> : (
            <div ref={wrapRef} style={{ position: "relative", width: dw, height: dh, userSelect: "none", touchAction: "none" }}>
              <img src={src} alt="" draggable={false} style={{ width: dw, height: dh, display: "block", pointerEvents: "none" }} />
              <div onPointerDown={start("move")} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
                style={{ position: "absolute", left: box.x * sc, top: box.y * sc, width: box.w * sc, height: box.h * sc, border: `2px solid ${th.accent}`, boxShadow: "0 0 0 9999px rgba(16,25,40,.5)", cursor: "move", touchAction: "none",
                  backgroundImage: "linear-gradient(rgba(255,255,255,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.35) 1px, transparent 1px)", backgroundSize: `${(box.w * sc) / 3}px ${(box.h * sc) / 3}px` }}>
                {handle("tl", "nwse-resize")}{handle("tr", "nesw-resize")}{handle("bl", "nesw-resize")}{handle("br", "nwse-resize")}
              </div>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
            <button className="tt-btn" onClick={() => setSq("free")} style={seg(aspect === "free")}>Free</button>
            <button className="tt-btn" onClick={() => setSq("sq")} style={seg(aspect === "sq")}>Square</button>
          </div>
          <button className="tt-btn" onClick={rotate} style={{ ...ghostBtn, padding: "6px 12px" }}>⟳ Rotate</button>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", flex: "1 1 auto", minWidth: 0 }}>
            <button className="tt-btn" onClick={onCancel} style={ghostBtn}>Cancel</button>
            <button className="tt-btn" onClick={() => finish(true)} style={ghostBtn}>Use whole image</button>
            <button className="tt-btn" onClick={() => finish(false)} style={solidBtn}>✓ Crop & use</button>
          </span>
        </div>
      </div>
    </div>
  );
}
function readAsDataUrl(f) { return new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = () => rej(new Error("Couldn't read this file.")); rd.readAsDataURL(f); }); }
/* ---------------- Extra duties: classes outside this timetable, non-teaching work ---------------- */
var DUTY_KINDS = { class: "Class outside this timetable", duty: "Non-teaching duty" };
function extraAt(cfg, t, d, p) { const L = cfg.extraDuties || []; for (let i = 0; i < L.length; i++) { const x = L[i]; if (x.t === t && (x.slots || []).some((s) => s[0] === d && +s[1] === p)) return x; } return null; }
function extraCount(cfg, t) { let n = 0; const wd = teacherWorkDays(cfg, t); for (const x of cfg.extraDuties || []) if (x.t === t) for (const s of x.slots || []) if (wd.includes(s[0]) && +s[1] < cfg.periods.length) n++; return n; }
function extraConflicts(cfg, x) {
  const out = [];
  for (const [dc, p] of x.slots || []) { for (const c of cfg.classes) { const sl = cfg.grid[c] && cfg.grid[c][dc] && cfg.grid[c][dc][p]; if (!sl || !sl[0]) continue; const cm = (cfg.combined || []).find((s) => s.name === sl[0]); const tk = cm ? cm.teachers : String(sl[0]).split(" "); if (tk.includes(x.t)) out.push({ c, d: dc, p, sub: sl[1], comb: !!cm }); } }
  return out;
}
function ExtraDutiesPanel({ cfg, update, ask, mobile }) {
  const th = CUR_TH || THEMES.teal;
  const blank = { t: cfg.singles[0] || "", kind: "class", label: "", slots: [] };
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState("");
  const list = cfg.extraDuties || [];
  const save = () => {
    if (!form.t || !form.label.trim() || !form.slots.length) { setMsg("Choose a teacher, write what it is, and tap at least one period."); return; }
    update((n) => { const L = [...(n.extraDuties || [])]; const x = { ...form, label: form.label.trim(), id: form.id || "x" + Date.now() }; const i = L.findIndex((y) => y.id === x.id); if (i >= 0) L[i] = x; else L.push(x); n.extraDuties = L; });
    setForm(null); setMsg("Saved. The generator keeps these periods free for the teacher, and substitution never picks them then.");
  };
  const toggle = (dc, p) => setForm((f) => { const has = f.slots.some((s) => s[0] === dc && s[1] === p); return { ...f, slots: has ? f.slots.filter((s) => !(s[0] === dc && s[1] === p)) : [...f.slots, [dc, p]] }; });
  const freeConflicts = (x) => { const cf = extraConflicts(cfg, x); ask(`Take out the ${cf.length} lesson${cf.length === 1 ? "" : "s"} that clash with "${x.label}"? Then press Fill remaining on the Assign tab to place them at other times.`, () => update((n) => { for (const k of cf) { if (k.comb) { const nm = n.grid[k.c][k.d][k.p][0]; for (const c of n.classes) if (n.grid[c]?.[k.d]?.[k.p]?.[0] === nm) n.grid[c][k.d][k.p] = [null, null]; } else n.grid[k.c][k.d][k.p] = [null, null]; } })); };
  const slotTxt = (x) => x.slots.slice().sort((a, b) => cfg.days.indexOf(a[0]) - cfg.days.indexOf(b[0]) || a[1] - b[1]).map(([dc, p]) => `${(DAY_FULL[dc] || dc).slice(0, 3)} P${p + 1}`).join(", ");
  const byT = {}; list.forEach((x) => (byT[x.t] || (byT[x.t] = [])).push(x));
  return (
    <div style={{ ...card, marginBottom: 16 }}>
      <Panelhead text="Extra duties — lower-section classes & non-teaching work" count={list.length ? `${list.length} dut${list.length === 1 ? "y" : "ies"}` : "none"} />
      <div style={{ padding: 14, display: "grid", gap: 12 }}>
        <div className="tt-callout">Some teachers also take classes that are <b>not in this timetable</b> (for example LP section) or have <b>weekly non-teaching work</b> (library, office, PTA). Add those periods here: the generator never puts a lesson there, they count as busy in the leisure reports, and Daily substitution never picks the teacher then. If the teacher is absent, a lower-section class is also listed for cover.</div>
        {Object.keys(byT).sort().map((t) => (
          <div key={t} style={{ border: `1px solid ${C.line}`, borderRadius: 14, padding: 10, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 32, height: 32, borderRadius: 10, display: "grid", placeItems: "center", background: `linear-gradient(135deg, ${th.g1}, ${th.g2})`, color: "#fff", fontFamily: mono, fontWeight: 800, fontSize: 11 }}>{t.slice(0, 3)}</span><b style={{ fontFamily: mono }}>{t}</b><span style={{ fontSize: 12, color: C.sub }}>{byT[t].reduce((a, x) => a + x.slots.length, 0)} period(s) a week outside the timetable</span></div>
            {byT[t].map((x) => { const cf = extraConflicts(cfg, x); return (
              <div key={x.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "8px 10px", borderRadius: 10, background: x.kind === "class" ? "#f4effb" : "#f6f8fa" }}>
                <span style={{ fontSize: 10.5, fontWeight: 800, padding: "2px 8px", borderRadius: 10, background: x.kind === "class" ? "#7c3aed" : "#647189", color: "#fff", textTransform: "uppercase", letterSpacing: 0.4 }}>{x.kind === "class" ? "Class" : "Duty"}</span>
                <div style={{ minWidth: 0, flex: "1 1 200px" }}>
                  <div style={{ fontWeight: 800, fontSize: 13.5 }}>{x.label}</div>
                  <div style={{ fontSize: 12, color: C.sub }}>{slotTxt(x)}</div>
                  {cf.length > 0 && <div style={{ fontSize: 12, color: C.clash, fontWeight: 600 }}>Clashes with the timetable: {cf.map((k) => `${k.c} ${(DAY_FULL[k.d] || k.d).slice(0, 3)} P${k.p + 1}`).join(", ")}</div>}
                </div>
                {cf.length > 0 && <button className="tt-btn" onClick={() => freeConflicts(x)} style={{ ...ghostBtn, padding: "4px 10px", fontSize: 12, color: C.clash }}>Free these periods</button>}
                <button className="tt-btn" onClick={() => { setForm({ ...x, slots: x.slots.map((s) => [s[0], +s[1]]) }); setMsg(""); }} style={{ ...ghostBtn, padding: "4px 10px", fontSize: 12 }}>Edit</button>
                <button className="tt-btn" onClick={() => ask(`Remove "${x.label}" for ${x.t}?`, () => update((n) => { n.extraDuties = (n.extraDuties || []).filter((y) => y.id !== x.id); }))} style={{ ...ghostBtn, padding: "4px 10px", fontSize: 12, color: C.clash }}>Remove</button>
              </div>); })}
          </div>
        ))}
        {!form && <div><button className="tt-btn" onClick={() => { setForm(blank); setMsg(""); }} style={solidBtn}>+ Add an extra duty</button></div>}
        {form && (
          <div style={{ border: `1.5px solid ${th.accent}55`, borderRadius: 14, padding: 12, display: "grid", gap: 10, background: "#fbfdfd" }}>
            <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "160px 220px 1fr", gap: 10 }}>
              <label style={{ display: "grid", gap: 4, fontSize: 11, fontWeight: 700, color: C.sub, textTransform: "uppercase" }}>Teacher
                <select className="tt-sel" value={form.t} onChange={(e) => setForm({ ...form, t: e.target.value })} style={{ height: 36 }}>{cfg.singles.map((t) => <option key={t}>{t}</option>)}</select>
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 11, fontWeight: 700, color: C.sub, textTransform: "uppercase" }}>Type
                <select className="tt-sel" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} style={{ height: 36, fontFamily: sans }}>{Object.entries(DUTY_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 11, fontWeight: 700, color: C.sub, textTransform: "uppercase" }}>What is it
                <input className="tt-in" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={form.kind === "class" ? "e.g. LP 3 B — Maths" : "e.g. Library duty"} style={{ height: 36, fontFamily: sans, fontSize: 13 }} />
              </label>
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.sub }}>Tap the periods every week:</div>
            <div className="tt-scroll" style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "separate", borderSpacing: 3 }}>
                <thead><tr><th />{cfg.periods.map((p, i) => <th key={i} style={{ fontSize: 11, color: C.sub }}>P{p}</th>)}</tr></thead>
                <tbody>{cfg.days.map((dc) => (
                  <tr key={dc}><td style={{ fontSize: 11.5, fontWeight: 800, color: C.sub, paddingRight: 6 }}>{(DAY_FULL[dc] || dc).slice(0, 3)}</td>
                    {cfg.periods.map((_, p) => { const on = form.slots.some((s) => s[0] === dc && s[1] === p); const busy = !on && (() => { for (const c of cfg.classes) { const sl = cfg.grid[c]?.[dc]?.[p]; if (sl && sl[0]) { const cm = (cfg.combined || []).find((s) => s.name === sl[0]); if ((cm ? cm.teachers : String(sl[0]).split(" ")).includes(form.t)) return c; } } return null; })();
                      return <td key={p}><button className="tt-btn" onClick={() => toggle(dc, p)} title={busy ? `${form.t} teaches ${busy} now` : ""} style={{ width: 44, height: 32, borderRadius: 8, cursor: "pointer", fontSize: 11, fontWeight: 800, border: `1.5px solid ${on ? "#7c3aed" : busy ? `${C.warn}88` : C.line}`, background: on ? "#7c3aed" : busy ? C.warnSoft : "#fff", color: on ? "#fff" : busy ? "#94620b" : "#b4bccb" }}>{on ? "✓" : busy ? busy.replace(" ", "") : "·"}</button></td>; })}
                  </tr>))}</tbody>
              </table>
            </div>
            <div style={{ fontSize: 11.5, color: C.sub }}>Amber boxes show where {form.t} already teaches in this timetable — choosing one creates a clash you can free afterwards.</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button className="tt-btn" onClick={save} style={solidBtn}>Save duty</button><button className="tt-btn" onClick={() => setForm(null)} style={ghostBtn}>Cancel</button></div>
          </div>
        )}
        {msg && <div style={{ fontSize: 12.5, fontWeight: 600, color: msg.startsWith("Saved") ? C.free : C.clash }}>{msg}</div>}
      </div>
    </div>
  );
}
function fillSubs(n, date) {
  const r = n.subs && n.subs[date]; if (!r) return 0;
  r.assign = r.assign || {};
  const cnt = subCounts(n, date); let k = 0;
  for (const nd of subsNeeds(n, date)) {
    if (r.assign[nd.key]) continue;
    const c = subCandidates(n, date, nd, cnt)[0];
    if (c) { r.assign[nd.key] = c.u; k++; cnt.month[c.u] = (cnt.month[c.u] || 0) + 1; cnt.rot[c.u] = (cnt.rot[c.u] || 0) + 1; if (n.subsOwed && n.subsOwed[c.u] > 0) { n.subsOwed = { ...n.subsOwed }; n.subsOwed[c.u]--; if (!n.subsOwed[c.u]) delete n.subsOwed[c.u]; } }
  }
  return k;
}
var ABS_REASONS = ["Leave", "On duty", "Training", "Exam duty", "Other"];
/* ---------------- Undo & safety copies ---------------- */
var SNAP_SKIP = ["logo", "logoIcon", "hmSign", "seal", "versions", "snapshots", "adminPw", "subs"];
var SNAP_HINT = { text: "", at: 0 };
function setSnapHint(text) {
  const t = String(text || "");
  const known = [[/^restoring/i, null], [/new academic year/i, "New academic year"], [/improve teaching quality/i, "Improve quality"], [/master reset/i, "Master reset"], [/regenerat|fresh, clash-free|replace all/i, "Regenerate"], [/fill (the )?remaining|fill remaining/i, "Fill remaining"], [/^reset/i, "Reset"], [/clear all mapping|clear .*mapping/i, "Clear all mapping"], [/clear every|clear all/i, "Clear all"], [/fix all clashes/i, "Fix all clashes"], [/^use (version|saved|current)|^use /i, "Using a version"], [/import|replace the timetable/i, "Import"], [/restore the safety copy/i, "Restore"]];
  let label = ""; for (const [re, l] of known) if (re.test(t)) { label = l === null ? t.replace(/^restoring\s*/i, "Restore of ") : l; break; }
  if (!label) { label = t.split(/[.?!—(,:]/)[0].trim(); if (label.length > 48) label = label.slice(0, 48).replace(/\s+\S*$/, "") + "…"; }
  SNAP_HINT = { text: label, at: Date.now() };
}
function bigChange(a, b) {
  if (!a || !b) return null;
  const parts = [];
  if ((a.classes || []).length !== (b.classes || []).length || (a.singles || []).length !== (b.singles || []).length || (a.subjects || []).length !== (b.subjects || []).length) parts.push("classes / teachers / subjects changed");
  let g = 0;
  for (const c of a.classes || []) for (const d of a.days || []) {
    const x = (a.grid && a.grid[c] && a.grid[c][d]) || [], y = (b.grid && b.grid[c] && b.grid[c][d]) || [];
    const n = Math.max(x.length, y.length);
    for (let p = 0; p < n; p++) if (((x[p] && x[p][0]) || "") !== ((y[p] && y[p][0]) || "")) g++;
  }
  if (g >= 20) parts.push(`${g} periods changed`);
  let m = 0; const ks = new Set([...Object.keys(a.bkey || {}), ...Object.keys(b.bkey || {})]);
  for (const k of ks) if (JSON.stringify((a.bkey || {})[k] || []) !== JSON.stringify((b.bkey || {})[k] || [])) m++;
  if (m >= 3) parts.push(`mapping of ${m} classes changed`);
  if (Object.keys(a.locked || {}).length - Object.keys(b.locked || {}).length >= 25) parts.push("frozen periods removed");
  return parts.length ? parts.join(" · ") : null;
}
function snapSummary(c) {
  let f = 0; for (const k of c.classes || []) for (const d of c.days || []) for (const sl of (c.grid && c.grid[k] && c.grid[k][d]) || []) if (sl && sl[0]) f++;
  return { classes: (c.classes || []).length, teachers: (c.singles || []).length, filled: f };
}
function b64FromBuf(buf) { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
function bufFromB64(b) { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
async function makeSnapshot(c, label, kind) {
  const o = {}; for (const k of Object.keys(c)) if (!SNAP_SKIP.includes(k)) o[k] = c[k];
  const js = JSON.stringify(o);
  const rec = { id: "sn" + Date.now() + Math.random().toString(36).slice(2, 6), at: Date.now(), label: label || "Safety copy", kind: kind || "auto", sum: snapSummary(c) };
  try {
    if (typeof CompressionStream === "undefined") throw new Error("no gzip");
    const st = new Blob([js]).stream().pipeThrough(new CompressionStream("gzip"));
    rec.z = b64FromBuf(await new Response(st).arrayBuffer());
  } catch (e) { rec.j = js; }
  return rec;
}
async function readSnapshot(rec) {
  if (rec.j) return JSON.parse(rec.j);
  const st = new Blob([bufFromB64(rec.z)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(st).text());
}
function pruneSnaps(list) {
  const arc = list.filter((x) => x.kind === "archive").sort((a, b) => b.at - a.at).slice(0, 6);
  const man = list.filter((x) => x.kind === "manual").sort((a, b) => b.at - a.at).slice(0, 6);
  const aut = list.filter((x) => x.kind !== "manual" && x.kind !== "archive").sort((a, b) => b.at - a.at).slice(0, 8);
  return [...arc, ...man, ...aut].sort((a, b) => b.at - a.at);
}
function SafetyPanel({ cfg, update, ask }) {
  const [name, setName] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState("");
  const list = (cfg.snapshots || []).slice().sort((a, b) => b.at - a.at);
  const fmt = (t) => new Date(t).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const saveNow = async () => {
    setBusy("save");
    try { const rec = await makeSnapshot(cfg, name.trim() || "Saved by hand", "manual"); update((n) => { n.snapshots = pruneSnaps([...(n.snapshots || []), rec]); }); setName(""); setMsg({ ok: true, text: "Safety copy saved." }); }
    catch (e) { setMsg({ ok: false, text: "Couldn't save: " + ((e && e.message) || e) }); }
    setBusy("");
  };
  const restore = (rec) => ask(`Restore the safety copy "${rec.label}" from ${fmt(rec.at)}? Classes, teachers, mapping, rules and the whole timetable go back to how they were then. (Your logo, signature, seal, saved versions and substitution record are kept. The current state is saved as a safety copy first, so you can come back.)`, async () => {
    setBusy(rec.id);
    try {
      const data = await readSnapshot(rec);
      setSnapHint(`restoring the copy from ${fmt(rec.at)}`);
      update((n) => { for (const k of Object.keys(n)) if (!SNAP_SKIP.includes(k)) delete n[k]; for (const k of Object.keys(data)) if (!SNAP_SKIP.includes(k)) n[k] = data[k]; });
      setMsg({ ok: true, text: `Restored "${rec.label}".` });
    } catch (e) { setMsg({ ok: false, text: "Couldn't restore: " + ((e && e.message) || e) }); }
    setBusy("");
  });
  const download = async (rec) => {
    try { const data = await readSnapshot(rec); downloadText(`timetable_safety_copy_${new Date(rec.at).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`, JSON.stringify(data, null, 1), "application/json"); }
    catch (e) { setMsg({ ok: false, text: "Couldn't download: " + ((e && e.message) || e) }); }
  };
  const del = (rec) => ask(`Delete the safety copy "${rec.label}"?`, () => update((n) => { n.snapshots = (n.snapshots || []).filter((x) => x.id !== rec.id); }));
  const th = CUR_TH || THEMES.teal;
  return (
    <div style={{ ...card, padding: 18, position: "relative" }}>
      <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: `linear-gradient(180deg, ${th.g1}, ${th.g2})` }} />
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <span style={{ width: 40, height: 40, borderRadius: 12, display: "grid", placeItems: "center", background: `${th.accent}14`, color: th.accent, flexShrink: 0, fontSize: 18 }}>⟲</span>
        <div style={{ fontSize: 15.5, fontWeight: 800, color: C.ink }}>Safety copies & undo</div>
        <span style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 700, padding: "2px 10px", borderRadius: 20, background: C.freeSoft, color: C.free }}>{list.length} kept</span>
      </div>
      <div className="tt-callout" style={{ marginBottom: 12 }}>Before every big change — Auto-generate, Reset, Master reset, Clear all, imports, Fix clashes, using a version — the app <b>automatically keeps a copy</b> of everything as it was. Restore any copy here with one click. For small slips use <b>↶ Undo</b> at the top of the screen (Ctrl+Z on a computer). Copies are saved with your timetable, so they work on every device.</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <input className="tt-in" style={{ flex: "1 1 220px", maxWidth: 360, fontFamily: sans, fontSize: 13, height: 36 }} placeholder="Name this copy (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <PrintBtn onClick={saveNow} icon="download" label={busy === "save" ? "Saving…" : "Save a safety copy now"} sub="kept until you delete it" />
      </div>
      {msg && <div style={{ fontSize: 12.5, fontWeight: 600, color: msg.ok ? C.free : C.clash, marginBottom: 10 }}>{msg.text}</div>}
      {list.length === 0 ? <div style={{ fontSize: 12.5, color: C.sub }}>No safety copies yet — one is made automatically before the next big change.</div> : (
        <div style={{ display: "grid", gap: 8 }}>
          {list.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "9px 12px", border: `1px solid ${r.kind === "manual" ? `${th.accent}55` : C.line}`, borderRadius: 12, background: r.kind === "manual" ? `${th.accent}08` : "#fff" }}>
              <span style={{ fontSize: 10.5, fontWeight: 800, padding: "2px 8px", borderRadius: 10, background: r.kind === "manual" ? th.accent : r.kind === "archive" ? C.accent : "#eef1f5", color: r.kind === "manual" || r.kind === "archive" ? "#fff" : C.sub, textTransform: "uppercase", letterSpacing: 0.4 }}>{r.kind === "manual" ? "Saved" : r.kind === "archive" ? "Year" : "Auto"}</span>
              <div style={{ minWidth: 0, flex: "1 1 220px" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, wordBreak: "break-word" }}>{r.label}</div>
                <div style={{ fontSize: 11.5, color: C.sub }}>{fmt(r.at)}{r.sum ? ` · ${r.sum.classes} classes · ${r.sum.teachers} teachers · ${r.sum.filled} periods filled` : ""}</div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="tt-btn" onClick={() => download(r)} style={{ ...ghostBtn, padding: "5px 10px", fontSize: 12 }}>Download</button>
                <button className="tt-btn" onClick={() => del(r)} style={{ ...ghostBtn, padding: "5px 10px", fontSize: 12, color: C.clash }}>Delete</button>
                <button className="tt-btn" disabled={busy === r.id} onClick={() => restore(r)} style={{ ...solidBtn, padding: "5px 12px", fontSize: 12 }}>{busy === r.id ? "Restoring…" : "Restore"}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Daily substitution register ---------------- */
const WD = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
function isoToday() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function isoShift(iso, n) { const [y, m, d] = iso.split("-").map(Number); const t = new Date(y, m - 1, d + n); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; }
function isoDay(iso) { const [y, m, d] = iso.split("-").map(Number); return WD[new Date(y, m - 1, d).getDay()]; }
function isoNice(iso, long) { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, long ? { weekday: "long", day: "numeric", month: "long", year: "numeric" } : { weekday: "short", day: "numeric", month: "short" }); }
function partPeriods(cfg, part) { if (typeof part === "string" && part.startsWith("p:")) return part.slice(2).split(",").filter((x) => x !== "").map(Number).filter((x) => x >= 0 && x < cfg.periods.length); const h = fnCount(cfg); return cfg.periods.map((_, i) => i).filter((i) => part === "am" ? i < h : part === "pm" ? i >= h : true); }
function subsNeeds(cfg, date) {
  const rec = (cfg.subs || {})[date] || {}, abs = rec.absent || {}, d = isoDay(date), out = [];
  if (!cfg.days.includes(d)) return out;
  for (const t of Object.keys(abs)) {
    if (!cfg.singles.includes(t)) continue;
    for (const p of partPeriods(cfg, abs[t])) { const r = teacherAt(cfg, t, d, p); if (r && !(r.extra && r.kind !== "class")) out.push({ key: `${t}|${p}`, t, p, cls: r.c, sub: r.sub, combined: !!r.combined }); }
  }
  return out.sort((a, b) => a.p - b.p || cmpClass(a.cls, b.cls));
}
function absentAt(cfg, date, u, p) { const a = (((cfg.subs || {})[date] || {}).absent || {})[u]; return !!a && partPeriods(cfg, a).includes(p); }
function subCounts(cfg, date) {
  const mon = date.slice(0, 7), month = {}, total = {}, last = {}, rot = {};
  const start = cfg.subsRotationStart || "0000-00-00";
  for (const [dt, r] of Object.entries(cfg.subs || {})) for (const u of Object.values(r.assign || {})) {
    if (!u) continue;
    total[u] = (total[u] || 0) + 1;
    if (dt.slice(0, 7) === mon) month[u] = (month[u] || 0) + 1;
    if (!last[u] || dt > last[u]) last[u] = dt;
    if (dt >= start) rot[u] = (rot[u] || 0) + 1;
  }
  const rk = rotationRank(cfg);
  return { month, total, last, rot, rank: rk.rank, leisure: rk.leisure, start };
}
// turn order: most leisure (free) periods in the week first
function rotationRank(cfg) {
  const leisure = {};
  for (const t of cfg.singles) { let f = 0; for (const d of teacherWorkDays(cfg, t)) for (let p = 0; p < cfg.periods.length; p++) if (!teacherAt(cfg, t, d, p)) f++; leisure[t] = f; }
  const order = cfg.singles.slice().sort((a, b) => leisure[b] - leisure[a] || a.localeCompare(b));
  const rank = {}; order.forEach((t, i) => (rank[t] = i + 1));
  return { order, rank, leisure };
}
// a teacher who missed turns (leave, busy, or replaced by hand) is owed them — but never more than one round behind
function rotEff(counts, u) { const vals = Object.values(counts.rot); const mx = vals.length ? Math.max(...vals) : 0; return Math.max(counts.rot[u] || 0, mx - 1); }
// pointer = furthest rank that has already taken this round's turn; teachers before it who haven't are "passed over"
function rotPointer(cfg, counts, round) { let pt = 0; for (const t of cfg.singles) if ((counts.rot[t] || 0) >= round && (counts.rank[t] || 0) > pt) pt = counts.rank[t]; return pt; }
function rotKey(cfg, counts, u, done, round, pointer) {
  const v = Object.values(counts.rot), mx = v.length ? Math.max(...v) : 0, eff = Math.max(done, mx - 1);
  const owed = ((cfg.subsOwed || {})[u] || 0) > 0, passed = (counts.rank[u] || 0) < pointer && done < round;
  return { eff, owed, passed, key: eff * 1000 - (owed ? 600 : 0) - (passed ? 300 : 0) + (counts.rank[u] || 99) };
}
function rotRound(cfg, counts) { const act = cfg.singles.filter((t) => counts.leisure[t] > 0); if (!act.length) return 1; return Math.min(...act.map((t) => rotEff(counts, t))) + 1; }
function subCandidates(cfg, date, need, counts) {
  const d = isoDay(date), rec = (cfg.subs || {})[date] || {}, assign = rec.assign || {};
  const mode = cfg.subsMode || "rotation";
  const takenAt = new Set(Object.entries(assign).filter(([k, u]) => u && +k.split("|")[1] === need.p && k !== need.key).map(([, u]) => u));
  const today = {}; Object.entries(assign).forEach(([k, u]) => { if (u && k !== need.key) today[u] = (today[u] || 0) + 1; });
  const cls = String(need.cls).split(", ");
  const own = assign[need.key];
  const round = rotRound(cfg, counts), pointer = rotPointer(cfg, counts, round);
  const out = [];
  for (const u of cfg.singles) {
    if (u === need.t || isOffDay(cfg, u, d) || absentAt(cfg, date, u, need.p) || takenAt.has(u)) continue;
    if (teacherAt(cfg, u, d, need.p)) continue;
    let freeToday = 0; for (let p = 0; p < cfg.periods.length; p++) if (!teacherAt(cfg, u, d, p) && !absentAt(cfg, date, u, p)) freeToday++;
    const knows = cls.some((c) => cfg.classTeacher[c] === u || (cfg.bkey[c] || []).some((r) => String(r.teacher || "").split(" ").includes(u)));
    const ct = cls.some((c) => cfg.classTeacher[c] === u);
    const sameSub = cls.some((c) => (cfg.bkey[c] || []).some((r) => r.sub === need.sub && String(r.teacher || "").split(" ").includes(u)));
    const m = counts.month[u] || 0, td = today[u] || 0;
    const done = (counts.rot[u] || 0) - (own === u ? 1 : 0), rk = rotKey(cfg, counts, u, done, round, pointer), eff = rk.eff;
    const score = mode === "rotation"
      ? -rk.key - td * 100
      : (ct ? 40 : knows ? 30 : 0) + (sameSub ? 10 : 0) - m * 6 - td * 12 + Math.min(freeToday, 5) * 3;
    const why = mode === "rotation"
      ? [own === u ? null : rk.owed ? "missed a turn — first in line" : rk.passed ? "skipped earlier — owed" : null, `rank ${counts.rank[u]}`, `${done} turn${done === 1 ? "" : "s"} done`, ct ? "class teacher" : knows ? `teaches ${cls[0]}` : null].filter(Boolean)
      : [ct ? "class teacher" : knows ? `teaches ${cls[0]}` : null, sameSub ? `teaches ${need.sub}` : null, `${freeToday} free today`, `${m} this month`].filter(Boolean);
    out.push({ u, score, why, m, freeToday, eff, done });
  }
  return out.sort((a, b) => b.score - a.score || a.m - b.m || a.u.localeCompare(b.u));
}
function RotationPanel({ cfg, update, date, counts, ask, limited }) {
  const th = CUR_TH || THEMES.teal;
  const order = cfg.singles.slice().sort((a, b) => (counts.rank[a] || 99) - (counts.rank[b] || 99));
  const round = rotRound(cfg, counts);
  const pointer = rotPointer(cfg, counts, round);
  const next = order.filter((t) => counts.leisure[t] > 0).map((t) => ({ t, k: rotKey(cfg, counts, t, counts.rot[t] || 0, round, pointer) })).sort((a, b) => a.k.key - b.k.key);
  const upNext = next.slice(0, 5).map((x) => x.t);
  return (
    <div style={card}>
      <Panelhead text={`Rotation — round ${round}`} count={cfg.subsRotationStart ? `since ${isoNice(cfg.subsRotationStart)}` : "since the start"} />
      <div style={{ padding: 12, display: "grid", gap: 10 }}>
        <div className="tt-callout">Teachers take substitution turns in order of their <b>leisure periods</b> (most free periods first). When everyone has had a turn, round {round + 1} starts in the same order. A teacher who misses a turn — on leave, busy that period, or replaced by hand — keeps it and comes first next time (at most one round behind).</div>
        <div style={{ fontSize: 12.5 }}><b>Next up:</b> {upNext.map((t, i) => <span key={t} style={{ display: "inline-block", fontFamily: mono, fontWeight: 800, padding: "2px 8px", borderRadius: 8, margin: "2px 4px 2px 0", background: i === 0 ? th.accent : `${th.accent}14`, color: i === 0 ? "#fff" : th.g2 }}>{t}</span>)}</div>
        <div className="tt-scroll" style={{ maxHeight: 300, overflowY: "auto" }}>
          <table style={{ ...tbl, tableLayout: "auto" }}>
            <thead><tr><th style={th0}>#</th><th style={{ ...th0, textAlign: "left" }}>Teacher</th><th style={th0}>Leisure / week</th><th style={th0}>Turns done</th><th style={th0}>Status</th></tr></thead>
            <tbody>{order.map((t) => { const done = counts.rot[t] || 0, eff = rotEff(counts, t), owed = eff > done ? 0 : eff < round - 1 ? 0 : (round - 1) - done; const inRound = done >= round; return (
              <tr key={t}>
                <td style={{ ...cellTd, height: 30, fontFamily: mono, color: C.sub }}>{counts.rank[t]}</td>
                <td style={{ ...cellTd, height: 30, textAlign: "left", fontFamily: mono, fontWeight: 800 }}>{t}</td>
                <td style={{ ...cellTd, height: 30, fontFamily: mono }}>{counts.leisure[t]}</td>
                <td style={{ ...cellTd, height: 30, fontFamily: mono, fontWeight: 700 }}>{done}</td>
                <td style={{ ...cellTd, height: 30, fontSize: 11.5 }}>{!counts.leisure[t] ? <span style={{ color: C.sub }}>no free periods</span> : upNext[0] === t ? <b style={{ color: th.accent }}>next</b> : ((cfg.subsOwed || {})[t] || 0) > 0 && !inRound ? <span style={{ color: C.warn, fontWeight: 700 }}>missed a turn — first in line</span> : inRound ? <span style={{ color: C.free }}>done this round</span> : done < round - 1 ? <span style={{ color: C.warn, fontWeight: 700 }}>owed {round - 1 - done}</span> : <span style={{ color: C.sub }}>waiting</span>}</td>
              </tr>); })}</tbody>
          </table>
        </div>
        {!limited && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button className="tt-btn" onClick={() => ask("Start a new rotation from today? Everyone's turn count goes back to 0 (past substitutions stay in the record).", () => update((n) => { n.subsRotationStart = date; delete n.subsOwed; }))} style={{ ...ghostBtn, fontSize: 12 }}>Start a new rotation from {isoNice(date)}</button>
          {cfg.subsRotationStart && <button className="tt-btn" onClick={() => update((n) => { delete n.subsRotationStart; })} style={{ ...ghostBtn, fontSize: 12 }}>Count from the beginning</button>}</div>}
      </div>
    </div>
  );
}
const th0 = { padding: "8px 8px", fontSize: 11, fontWeight: 800, color: "#647189", textTransform: "uppercase", letterSpacing: 0.4, background: "#f6f8fa", borderBottom: "1px solid #e4e8ef", textAlign: "center" };
function StaffAccessCard({ cfg, update, me }) {
  const [name, setName] = useState("");
  const th = CUR_TH || THEMES.teal;
  const roles = cfg.roles || {};
  const add = () => { const n0 = name.trim().toLowerCase().replace(/@.*$/, ""); if (!n0) return; update((n) => { n.roles = { ...(n.roles || {}), [n0]: n0 === me ? "full" : "subs" }; }); setName(""); };
  return (
    <div style={{ ...card, marginBottom: 16 }}>
      <Panelhead text="Staff access — who can see what" count={Object.values(roles).filter((r) => r === "subs").length ? `${Object.values(roles).filter((r) => r === "subs").length} substitution-only` : "everyone full"} />
      <div style={{ padding: 14, display: "grid", gap: 12 }}>
        <div className="tt-callout">Give a teacher the duty of marking absentees: they sign in with their own username and see <b>only Daily substitution</b> — no timetable editing, no setup, no reset. Everyone not listed here keeps full access.{me ? <> You are signed in as <b>{me}</b>.</> : null}</div>
        {Object.keys(roles).length > 0 && (
          <div style={{ display: "grid", gap: 6 }}>
            {Object.entries(roles).map(([u, r]) => (
              <div key={u} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 10px", border: `1px solid ${C.line}`, borderRadius: 12 }}>
                <span style={{ width: 32, height: 32, borderRadius: 10, display: "grid", placeItems: "center", background: r === "subs" ? C.accentSoft : `${th.accent}14`, color: r === "subs" ? "#94620b" : th.accent, fontWeight: 800 }}>{u.slice(0, 2).toUpperCase()}</span>
                <b style={{ fontFamily: mono, minWidth: 90 }}>{u}</b>
                <select className="tt-sel" value={r} disabled={u === me} onChange={(e) => update((n) => { n.roles = { ...(n.roles || {}), [u]: e.target.value }; })} style={{ width: 220, fontFamily: sans, fontSize: 13 }}>
                  <option value="subs">Daily substitution only</option><option value="full">Full access</option>
                </select>
                {u === me && <span style={{ fontSize: 11.5, color: C.sub }}>(you — can't limit yourself)</span>}
                <button className="tt-btn" onClick={() => update((n) => { const x = { ...(n.roles || {}) }; delete x[u]; n.roles = x; })} style={{ ...ghostBtn, marginLeft: "auto", padding: "4px 10px", fontSize: 12, color: C.clash }}>Remove</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="tt-in" placeholder="Login username, e.g. sreeja" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} style={{ flex: "1 1 200px", maxWidth: 280, fontFamily: sans, fontSize: 13, height: 36 }} />
          <button className="tt-btn" onClick={add} style={solidBtn}>+ Add as substitution-only</button>
        </div>
        <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.6 }}><b>To create the login:</b> Supabase → <b>Authentication</b> → <b>Users</b> → <b>Add user</b> → email <span style={{ fontFamily: mono }}>username@amups.local</span>, a password, tick <b>Auto Confirm User</b>. Then add the same username here. The limit is in the app's screens; give this login only to staff you trust with the timetable data.</div>
      </div>
    </div>
  );
}
function subsText(cfg, date) {
  const needs = subsNeeds(cfg, date), a = (((cfg.subs || {})[date] || {}).assign) || {};
  const L = [`*${cfg.school || "School"} — Substitution*`, `${isoNice(date, true)}`, ""];
  if (!needs.length) L.push("No substitutions needed.");
  for (const n of needs) L.push(`P${cfg.periods[n.p]} · ${n.cls} · ${n.sub} — ${n.t} absent → *${a[n.key] || "not covered"}*`);
  return L.join("\n");
}
function exportSubSlipPDF(cfg, date) {
  const needs = subsNeeds(cfg, date), rec = (cfg.subs || {})[date] || {}, a = rec.assign || {}, abs = rec.absent || {};
  const css = "@page{size:A4 portrait;margin:1cm} *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box} html,body{margin:0} body{font-family:Arial,Helvetica,sans-serif;color:#16213a}" + lhCss() +
    " table{border-collapse:collapse;width:100%;border:2px solid #0e6b73} th,td{border:1px solid #b9d3d3;padding:7px 8px;font-size:13px;text-align:center} thead th{background:#0e6b73;color:#fff;font-weight:800} td.l{text-align:left} td.p{font-weight:800;font-size:15px;color:#0a4f55;background:#e1f0f0;width:16mm}" +
    " .sub{font-family:'Courier New',monospace;font-weight:800;font-size:15px;color:#0a3d42} .nc{color:#b3261e;font-weight:800} .ab{margin:6px 0 10px;font-size:12.5px} .ab span{display:inline-block;margin:2px 6px 2px 0;padding:2px 9px;border-radius:12px;background:#fbe0dd;color:#8a1f17;font-weight:700} td.sg{width:34mm} .nt{margin-top:8px;font-size:12px;color:#33415c}";
  const part = (x) => x === "am" ? " (FN)" : x === "pm" ? " (AN)" : String(x).startsWith("p:") ? ` (${partPeriods(cfg, x).map((p) => "P" + cfg.periods[p]).join(", ") || "no periods"})` : "";
  const why = (t) => ((rec.reason || {})[t] && rec.reason[t] !== "Leave" ? ` — ${rec.reason[t]}` : "");
  const rows = needs.map((n) => `<tr><td class="p">P${cfg.periods[n.p]}</td><td><b>${esc(n.cls)}</b></td><td>${esc(n.sub)}</td><td>${esc(n.t)}</td><td>${a[n.key] ? `<span class="sub">${esc(a[n.key])}</span>` : '<span class="nc">not covered</span>'}</td><td class="sg"></td></tr>`).join("");
  const body = pdfLetterhead(cfg, "Substitution", isoNice(date, true), `${Object.keys(abs).length} absent · ${needs.length} period${needs.length === 1 ? "" : "s"} to cover`) +
    `<div class="ab"><b>Absent:</b> ${Object.keys(abs).map((t) => `<span>${esc(t)}${part(abs[t])}${esc(why(t))}</span>`).join("") || "none"}</div>` +
    `<table><thead><tr><th>Period</th><th>Class</th><th>Subject</th><th>Absent teacher</th><th>Substitute</th><th>Substitute's sign</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No substitutions needed.</td></tr>'}</tbody></table>` +
    (rec.note ? `<div class="nt"><b>Note:</b> ${esc(rec.note)}</div>` : "") + pdfFooter(esc(cfg.school || "") + " &middot; Substitution " + esc(date), ["Headmaster"], cfg, "class");
  openPrint(esc(cfg.school) + " - Substitution " + date, css, body);
}
function exportSubMonthPDF(cfg, month) {
  const dates = Object.keys(cfg.subs || {}).filter((d) => d.slice(0, 7) === month).sort();
  const counts = {}; let rows = "";
  for (const dt of dates) for (const n of subsNeeds(cfg, dt)) { const u = ((cfg.subs[dt] || {}).assign || {})[n.key]; if (u) counts[u] = (counts[u] || 0) + 1; rows += `<tr><td>${esc(isoNice(dt))}</td><td>P${cfg.periods[n.p]}</td><td>${esc(n.cls)}</td><td>${esc(n.sub)}</td><td>${esc(n.t)}</td><td><b>${esc(u || "—")}</b></td></tr>`; }
  const css = "@page{size:A4 portrait;margin:1cm} *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box} html,body{margin:0} body{font-family:Arial,Helvetica,sans-serif;color:#16213a}" + lhCss() +
    " table{border-collapse:collapse;width:100%;border:2px solid #0e6b73;margin-bottom:10px} th,td{border:1px solid #b9d3d3;padding:4px 6px;font-size:11.5px;text-align:center} thead th{background:#0e6b73;color:#fff} thead{display:table-header-group} tr{page-break-inside:avoid} h3{font-size:14px;color:#0a4f55;margin:10px 0 6px}";
  const [y, m] = month.split("-").map(Number), title = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const tally = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([u, n]) => `<tr><td style="font-family:'Courier New',monospace;font-weight:800">${esc(u)}</td><td>${n}</td></tr>`).join("");
  openPrint(esc(cfg.school) + " - Substitution record " + month, css, pdfLetterhead(cfg, "Substitution record", title, `${dates.length} day(s) with absences`) +
    `<h3>Substitutions taken by each teacher</h3><table style="width:60%"><thead><tr><th>Teacher</th><th>Substitutions</th></tr></thead><tbody>${tally || '<tr><td colspan="2">None</td></tr>'}</tbody></table>` +
    `<h3>All substitutions</h3><table><thead><tr><th>Date</th><th>Period</th><th>Class</th><th>Subject</th><th>Absent</th><th>Substitute</th></tr></thead><tbody>${rows || '<tr><td colspan="6">None</td></tr>'}</tbody></table>` +
    pdfFooter(esc(cfg.school || ""), ["Headmaster"], cfg, "class"));
}
function SubsView({ cfg, update, mobile, ask, limited }) {
  const [date, setDate] = useState(isoToday());
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const th = CUR_TH || THEMES.teal;
  const d = isoDay(date), working = cfg.days.includes(d);
  const rec = (cfg.subs || {})[date] || {}, abs = rec.absent || {}, assign = rec.assign || {};
  const needs = useMemo(() => subsNeeds(cfg, date), [cfg, date]);
  const counts = useMemo(() => subCounts(cfg, date), [cfg, date]);
  const covered = needs.filter((n) => assign[n.key]).length;
  const edit = (fn, auto) => update((n) => {
    n.subs = n.subs || {}; const r = n.subs[date] || (n.subs[date] = { absent: {}, assign: {} }); r.absent = r.absent || {}; r.assign = r.assign || {};
    fn(r, n);
    // tidy: drop assignments that are no longer needed, empty days, and records older than ~13 months
    const keys = new Set(subsNeeds(n, date).map((x) => x.key)); for (const k of Object.keys(r.assign)) if (!keys.has(k) || !r.assign[k]) delete r.assign[k];
    if (!Object.keys(r.absent).length && !Object.keys(r.assign).length && !r.note) delete n.subs[date];
    const cut = isoShift(isoToday(), -400); for (const k of Object.keys(n.subs)) if (k < cut) delete n.subs[k];
    if (auto && n.subsAuto !== false && n.subs[date]) fillSubs(n, date);
  });
  const toggleAbs = (t) => edit((r) => { if (r.absent[t]) { delete r.absent[t]; if (r.reason) delete r.reason[t]; } else r.absent[t] = "full"; }, true);
  const setPart = (t, p) => edit((r) => { r.absent[t] = p === "some" ? "p:" : p; }, true);
  const togglePeriod = (t, p) => edit((r) => { const cur = new Set(partPeriods(cfg, r.absent[t])); if (cur.has(p)) cur.delete(p); else cur.add(p); r.absent[t] = "p:" + [...cur].sort((a, b) => a - b).join(","); }, true);
  const setReason = (t, v) => edit((r) => { r.reason = { ...(r.reason || {}) }; if (v === "Leave") delete r.reason[t]; else r.reason[t] = v; });
  const pick = (key, u) => edit((r, n) => {
    const prev = r.assign[key];
    n.subsOwed = { ...(n.subsOwed || {}) };
    if (prev && u && prev !== u) n.subsOwed[prev] = (n.subsOwed[prev] || 0) + 1;   // replaced by hand: keeps the turn
    if (u && n.subsOwed[u] > 0) { n.subsOwed[u]--; }
    for (const k of Object.keys(n.subsOwed)) if (!n.subsOwed[k]) delete n.subsOwed[k];
    if (u) r.assign[key] = u; else delete r.assign[key];
  });
  const autoAll = () => {
    update((n) => {
      n.subs = n.subs || {}; const r = n.subs[date] || (n.subs[date] = { absent: {}, assign: {} }); r.assign = r.assign || {};
      const cnt = subCounts(n, date);
      for (const nd of subsNeeds(n, date)) { if (r.assign[nd.key]) continue; const c = subCandidates(n, date, nd, cnt)[0]; if (c) { r.assign[nd.key] = c.u; cnt.month[c.u] = (cnt.month[c.u] || 0) + 1; cnt.rot[c.u] = (cnt.rot[c.u] || 0) + 1; if (n.subsOwed && n.subsOwed[c.u] > 0) { n.subsOwed = { ...n.subsOwed }; n.subsOwed[c.u]--; if (!n.subsOwed[c.u]) delete n.subsOwed[c.u]; } } }
    });
    setMsg((cfg.subsMode || "rotation") === "rotation" ? "Filled in by turn (rotation). Change any of them from the lists — a replaced teacher keeps their turn." : "Best substitutes filled in. Change any of them from the lists.");
  };
  const share = () => { const t = subsText(cfg, date); try { window.open("https://wa.me/?text=" + encodeURIComponent(t), "_blank"); } catch (e) { /* ignore */ } };
  const copy = async () => { try { await navigator.clipboard.writeText(subsText(cfg, date)); setMsg("Copied — paste it in WhatsApp or anywhere."); } catch (e) { setMsg("Couldn't copy on this device."); } };
  const list = cfg.singles.filter((t) => !q.trim() || t.toLowerCase().includes(q.trim().toLowerCase()));
  const absList = Object.keys(abs).filter((t) => cfg.singles.includes(t));
  const history = Object.entries(cfg.subs || {}).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 14);
  const month = date.slice(0, 7);
  const tally = cfg.singles.map((u) => ({ u, m: counts.month[u] || 0, t: counts.total[u] || 0 })).filter((x) => x.t).sort((a, b) => b.m - a.m || b.t - a.t);
  const navBtn = { ...ghostBtn, padding: "6px 11px", fontSize: 13, fontWeight: 800 };
  return (
    <div>
      <ViewHeader title="Daily substitution" note="Mark who is absent — the app lists every period that needs cover and suggests the fairest free teacher for each."
        meta={[["Absent", absList.length, absList.length ? "warn" : undefined], ["To cover", needs.length], ["Covered", `${covered}/${needs.length}`, needs.length && covered === needs.length ? "ok" : needs.length ? "warn" : undefined]]}
        right={<><PrintBtn onClick={() => exportSubSlipPDF(cfg, date)} icon="print" label="Print slip" sub="A4 · with HM signature" /></>} />

      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: 14 }}>
          <button className="tt-btn" onClick={() => setDate(isoShift(date, -1))} style={navBtn} aria-label="Previous day">‹</button>
          <input type="date" className="tt-in" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: 160, fontFamily: sans, fontSize: 13.5, height: 36 }} />
          <button className="tt-btn" onClick={() => setDate(isoShift(date, 1))} style={navBtn} aria-label="Next day">›</button>
          {date !== isoToday() && <button className="tt-btn" onClick={() => setDate(isoToday())} style={{ ...ghostBtn, fontSize: 12.5 }}>Today</button>}
          <span style={{ fontSize: 15, fontWeight: 800, color: th.g2, marginLeft: 6 }}>{isoNice(date, true)}</span>
          {!working && <span style={{ fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: C.warnSoft, color: C.warn }}>Not a working day in the timetable</span>}
        </div>
      </div>

      {working && <div style={{ display: "grid", gridTemplateColumns: mobile ? "minmax(0,1fr)" : "minmax(0, 340px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <div style={{ ...card }}>
          <Panelhead text="1 · Who is absent?" count={absList.length ? `${absList.length} absent` : "none"} />
          <div style={{ padding: 12, display: "grid", gap: 10 }}>
            {absList.length > 0 && (
              <div style={{ display: "grid", gap: 6 }}>
                {absList.map((t) => { const some = String(abs[t]).startsWith("p:"), sel = some ? new Set(partPeriods(cfg, abs[t])) : null; return (
                  <div key={t} style={{ display: "grid", gap: 6, padding: "6px 8px", borderRadius: 10, background: C.clashSoft, border: `1px solid ${C.clash}33` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <b style={{ fontFamily: mono, color: "#8a1f17", minWidth: 50 }}>{t}</b>
                      <select className="tt-sel" value={some ? "some" : abs[t]} onChange={(e) => setPart(t, e.target.value)} style={{ width: "auto", flex: "1 1 120px", fontFamily: sans, fontSize: 12.5 }}>
                        <option value="full">Whole day</option><option value="am">Forenoon — FN (P1–P{fnCount(cfg)})</option><option value="pm">Afternoon — AN (P{fnCount(cfg) + 1}–P{cfg.periods.length})</option><option value="some">Some periods…</option>
                      </select>
                      <select className="tt-sel" value={(rec.reason || {})[t] || "Leave"} onChange={(e) => setReason(t, e.target.value)} style={{ width: "auto", flex: "0 1 110px", fontFamily: sans, fontSize: 12.5 }}>{ABS_REASONS.map((x) => <option key={x}>{x}</option>)}</select>
                      <button className="tt-btn" onClick={() => toggleAbs(t)} aria-label={`Remove ${t}`} style={{ border: "none", background: "#fff", borderRadius: 20, width: 24, height: 24, cursor: "pointer", color: C.clash, fontWeight: 800 }}>×</button>
                    </div>
                    {some && <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{cfg.periods.map((pn, p) => <button key={p} className="tt-btn" onClick={() => togglePeriod(t, p)} style={{ minWidth: 38, padding: "4px 6px", borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: "pointer", border: `1.5px solid ${sel.has(p) ? C.clash : C.line}`, background: sel.has(p) ? C.clash : "#fff", color: sel.has(p) ? "#fff" : C.sub }}>P{pn}</button>)}</div>}
                  </div>); })}
              </div>
            )}
            <input className="tt-in" placeholder="Search teacher" value={q} onChange={(e) => setQ(e.target.value)} style={{ fontFamily: sans, fontSize: 13, height: 34 }} />
            <div className="tt-scroll" style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: mobile ? 220 : 380, overflowY: "auto" }}>
              {list.map((t) => { const on = !!abs[t], off = isOffDay(cfg, t, d); return (
                <button key={t} className="tt-btn" disabled={off} onClick={() => toggleAbs(t)} title={off ? "Not working this day" : on ? "Marked absent — tap to undo" : "Tap to mark absent"}
                  style={{ fontFamily: mono, fontWeight: 800, fontSize: 12.5, padding: "6px 10px", borderRadius: 9, cursor: off ? "default" : "pointer", border: `1.5px solid ${on ? C.clash : C.line}`, background: on ? C.clash : off ? "#f3f4f6" : "#fff", color: on ? "#fff" : off ? "#b4bccb" : C.ink, textDecoration: off ? "line-through" : "none" }}>{t}</button>
              ); })}
            </div>
            <textarea className="tt-in" placeholder="Note for the slip (optional)" value={rec.note || ""} onChange={(e) => edit((r) => { if (e.target.value) r.note = e.target.value; else delete r.note; })} style={{ fontFamily: sans, fontSize: 12.5, minHeight: 54, resize: "vertical" }} />
          </div>
        </div>

        <div style={{ ...card }}>
          <Panelhead text="2 · Periods to cover" count={needs.length ? `${covered} of ${needs.length} covered` : "nothing to cover"} tone={needs.length && covered === needs.length ? "free" : undefined} />
          <div style={{ padding: 12, display: "grid", gap: 10 }}>
            {needs.length === 0 ? <div style={{ padding: "18px 6px", textAlign: "center", fontSize: 13, color: C.sub }}>{absList.length ? "The absent teachers have no periods in this part of the day." : "Tap the absent teachers on the left. Their periods appear here."}</div> : (
              <>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className="tt-btn" onClick={autoAll} style={solidBtn}>✦ Suggest for all</button>
                  <label title="Substitutes are chosen by themselves as soon as a teacher is marked absent" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: C.ink, cursor: "pointer" }}><input type="checkbox" checked={cfg.subsAuto !== false} onChange={(e) => update((n) => { n.subsAuto = e.target.checked; })} /> Fill automatically</label>
                  <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
                    {[["rotation", "By turn (rotation)"], ["fit", "Best fit for the class"]].map(([k, l]) => <button key={k} className="tt-btn" onClick={() => update((n) => { n.subsMode = k; })} style={{ border: "none", padding: "6px 11px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: (cfg.subsMode || "rotation") === k ? C.primary : "#fff", color: (cfg.subsMode || "rotation") === k ? "#fff" : C.sub }}>{l}</button>)}
                  </div>
                  <button className="tt-btn" onClick={() => edit((r) => { r.assign = {}; })} style={ghostBtn}>Clear choices</button>
                  <span style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="tt-btn" onClick={share} style={{ ...ghostBtn, color: "#128c4b", borderColor: "#128c4b55" }}>WhatsApp</button>
                    <button className="tt-btn" onClick={copy} style={ghostBtn}>Copy text</button>
                  </span>
                </div>
                {msg && <div style={{ fontSize: 12.5, fontWeight: 600, color: C.free }}>{msg}</div>}
                {needs.map((n) => {
                  const cands = subCandidates(cfg, date, n, counts), cur = assign[n.key], best = cands[0];
                  const curC = cands.find((c) => c.u === cur);
                  return (
                    <div key={n.key} style={{ display: "grid", gridTemplateColumns: mobile ? "auto minmax(0,1fr)" : "auto minmax(0,1fr) minmax(0, 300px)", gap: 10, alignItems: "center", padding: "10px 12px", borderRadius: 12, border: `1.5px solid ${cur ? `${C.free}55` : `${C.warn}66`}`, background: cur ? "#f6fcf8" : "#fffaf0" }}>
                      <span style={{ width: 44, height: 44, borderRadius: 12, display: "grid", placeItems: "center", background: `linear-gradient(135deg, ${th.g1}, ${th.g2})`, color: "#fff", fontWeight: 800, fontSize: 15 }}>P{cfg.periods[n.p]}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 800, color: C.ink }}>{n.cls} · <span style={{ color: SUBJECT_BAR[n.sub] || C.ink }}>{n.sub}</span>{n.combined && <span style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}> · combined</span>}</div>
                        <div style={{ fontSize: 12, color: C.sub }}>for <b style={{ color: "#8a1f17", fontFamily: mono }}>{n.t}</b>{curC ? <> · {curC.why.join(" · ")}</> : best ? <> · best: <b style={{ fontFamily: mono, color: C.ink }}>{best.u}</b> ({best.why.slice(0, 2).join(", ")})</> : <span style={{ color: C.clash }}> · nobody is free this period</span>}</div>
                      </div>
                      <div style={{ gridColumn: mobile ? "1 / -1" : "auto", display: "flex", gap: 6 }}>
                        <select className="tt-sel" value={cur || ""} onChange={(e) => pick(n.key, e.target.value)} style={{ flex: 1, fontFamily: sans, fontSize: 13, height: 36, borderColor: cur ? C.free : undefined, fontWeight: cur ? 700 : 500 }}>
                          <option value="">— choose substitute —</option>
                          {cands.map((c, i) => <option key={c.u} value={c.u}>{i === 0 ? "★ " : ""}{c.u} — {c.why.join(", ")}</option>)}
                        </select>
                        {!cur && best && <button className="tt-btn" onClick={() => pick(n.key, best.u)} style={{ ...solidBtn, padding: "6px 12px" }}>Use {best.u}</button>}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      </div>}

      <div style={{ marginTop: 16 }}><RotationPanel cfg={cfg} update={update} date={date} counts={counts} ask={ask} limited={limited} /></div>
      <div style={{ display: "grid", gridTemplateColumns: mobile ? "minmax(0,1fr)" : "repeat(2, minmax(0,1fr))", gap: 16, marginTop: 16 }}>
        <div style={card}>
          <Panelhead text={`Fair share — substitutions taken (${new Date(date + "T00:00").toLocaleDateString(undefined, { month: "long" })})`} count={`${tally.reduce((a, x) => a + x.m, 0)} this month`} />
          <div style={{ padding: 12 }}>
            {tally.length === 0 ? <div style={{ fontSize: 12.5, color: C.sub }}>No substitutions recorded yet.</div> : (
              <div style={{ display: "grid", gap: 5 }}>
                {tally.slice(0, 14).map((x) => { const mx = Math.max(1, ...tally.map((y) => y.m)); return (
                  <div key={x.u} style={{ display: "grid", gridTemplateColumns: "64px 1fr 70px", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                    <b style={{ fontFamily: mono }}>{x.u}</b>
                    <span style={{ height: 10, borderRadius: 6, background: "#eef1f5", overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${(x.m / mx) * 100}%`, background: `linear-gradient(90deg, ${th.g1}, ${th.g2})` }} /></span>
                    <span style={{ color: C.sub, textAlign: "right" }}><b style={{ color: C.ink }}>{x.m}</b> · {x.t} total</span>
                  </div>); })}
              </div>
            )}
            <div style={{ marginTop: 12 }}><PrintBtn onClick={() => exportSubMonthPDF(cfg, month)} icon="pdf" light label="Monthly record" sub="A4 · every substitution this month" /></div>
          </div>
        </div>
        <div style={card}>
          <Panelhead text="Recent days" count={`${Object.keys(cfg.subs || {}).length} recorded`} />
          <div style={{ padding: 8 }}>
            {history.length === 0 ? <div style={{ padding: 6, fontSize: 12.5, color: C.sub }}>Nothing recorded yet.</div> : history.map(([dt, r]) => {
              const nd = subsNeeds(cfg, dt), cv = nd.filter((x) => (r.assign || {})[x.key]).length;
              return (
                <button key={dt} className="tt-btn" onClick={() => setDate(dt)} style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, padding: "8px 10px", border: "none", borderRadius: 10, cursor: "pointer", background: dt === date ? `${th.accent}12` : "transparent", textAlign: "left" }}>
                  <span style={{ fontWeight: 800, fontSize: 13, color: C.ink, minWidth: 120 }}>{isoNice(dt)}</span>
                  <span style={{ fontSize: 12, color: C.sub, flex: 1 }}>{Object.keys(r.absent || {}).join(", ") || "—"}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: cv === nd.length ? C.freeSoft : C.warnSoft, color: cv === nd.length ? C.free : C.warn }}>{cv}/{nd.length}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Analysis & pre-generation checks ---------------- */
function TeacherAssignments({ cfg }) {
  const [t, setT] = useState(cfg.singles[0] || "");
  const rows = [];
  const cov = combCover(cfg);
  for (const c of cfg.classes) for (const r of (cfg.bkey[c] || [])) if (r.teacher === t) { const own = Math.max(0, periodsFor(cfg, c, r.sub) - (cov[c + "|" + r.sub] || 0)); if (own) rows.push({ c: c, sub: r.sub, per: own }); }
  for (const g of Object.values(combGroups(cfg))) if (g.teachers.has(t)) rows.push({ c: [...new Set(g.sessions.filter((x) => x.teachers.includes(t)).flatMap((x) => x.divisions))].sort(cmpClass).join(", "), sub: `${g.sub} (combined “${g.name}”)`, per: g.need });
  const tot = rows.reduce((a, r) => a + r.per, 0);
  return (
    <div style={{ ...card, marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderBottom: `1px solid ${C.line}` }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Teacher assignments — subjects & classes</span>
        <select className="tt-sel" style={{ width: 130, marginLeft: "auto" }} value={t} onChange={(e) => setT(e.target.value)}>{cfg.singles.map((x) => <option key={x}>{x}</option>)}</select>
      </div>
      <div className="tt-scroll" style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto" }}>
        <table style={tbl}>
          <thead><tr><th style={{ ...th, textAlign: "left", paddingLeft: 12 }}>Class</th><th style={{ ...th, textAlign: "left" }}>Subject</th><th style={th}>Periods</th></tr></thead>
          <tbody>{rows.length ? rows.map((r, i) => (<tr key={i}><td style={{ ...cellTd, textAlign: "left", paddingLeft: 12, fontFamily: mono, fontWeight: 700, height: 32 }}>{r.c}</td><td style={{ ...cellTd, textAlign: "left", height: 32 }}>{r.sub}</td><td style={{ ...cellTd, height: 32, fontFamily: mono }}>{r.per}</td></tr>)) : <tr><td colSpan={3} style={{ ...cellTd, color: C.sub, height: 40 }}>Not assigned to any class.</td></tr>}</tbody>
        </table>
      </div>
      <div className="tt-note">{t}: {rows.length} class assignment(s), {tot} periods/week.</div>
    </div>
  );
}

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
    const wd = teacherWorkDays(cfg, t).length;
    const avail = wd * cfg.periods.length - forb.size * wd;
    return { t, subs: tSubs[t] ? [...tSubs[t]].join(", ") : "—", req, avail, diff: avail - req, forb: forb.size };
  }).sort((a, b) => a.diff - b.diff);

  const shortages = tRows.filter((r) => r.diff < 0);
  const tooMany = [];
  for (const st of standardsOf(cfg)) for (const [sub, v] of Object.entries(cfg.stdPeriods?.[st] || {})) if (+v > cfg.days.length && !cfg.twice?.[st]?.[sub]) tooMany.push(`${sub} in Std ${st} (${v} periods, ${cfg.days.length} days)`);

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
      <ViewHeader title="Analysis & pre-generation checks" note="Calculations and feasibility checks. Run these before Auto-generate." right={<PrintBtn onClick={printNow} label="Print / PDF" sub="This page, with letterhead" />} />

      <div style={{ ...card, marginBottom: 16, padding: 14, display: "flex", flexWrap: "wrap", gap: 10 }}>
        <PrintBtn onClick={() => exportClassesPDF(cfg)} icon="pdf" label="All class timetables" sub="A4 landscape · one class per page" />
        <PrintBtn onClick={() => exportTeachersPDF(cfg)} icon="pdf" label="All teacher timetables" sub="A4 landscape · one teacher per page" />
        <PrintBtn onClick={() => exportFreeReportPDF(cfg)} icon="pdf" light label="Teacher free-period report" sub="A4 portrait · counts & period numbers" />
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
        <div className="tt-note">
          “Available” = weekly slots ({cap}) minus the periods that subject is forbidden from (e.g. PET not in P1 removes {cfg.days.length} slots per forbidden period). A negative difference means that teacher can’t fit all their periods under the current rules — reduce restrictions, or combine classes for that subject to cut the requirement.
        </div>
      </div>

      {tooMany.length > 0 && <Banner tone="warn">More periods than working days: {tooMany.join("; ")}. The generator will put these twice on as few days as possible. To choose that yourself, switch on “twice a day” for them in Scheduling rules.</Banner>}
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

      <TeacherAssignments cfg={cfg} />
      <TeacherFreeReport cfg={cfg} teacherLoad={teacherLoad} />
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div style={{ ...card, padding: "14px 16px" }}>
      <div style={{ fontSize: 26, fontWeight: 800, color: tone === "bad" ? C.clash : tone === "warn" ? C.warn : tone === "good" ? C.free : tone === "accent" ? C.accent : C.primary, letterSpacing: -0.5 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: C.sub, fontWeight: 600, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function TeacherFreeReport({ cfg }) {
  const [paper, setPaper] = useState("A4");
  const [orient, setOrient] = useState("portrait");
  const [showP, setShowP] = useState(true);
  const [showTot, setShowTot] = useState(true);
  const [showSum, setShowSum] = useState(true);
  const data = useMemo(() => cfg.singles.map((t) => ({ t, days: cfg.days.map((d) => freeOf(cfg, t, d)) })), [cfg]);
  const toneOf = (n) => n === 0 ? [C.clashSoft, C.clash] : n === 1 ? [C.warnSoft, C.warn] : [C.freeSoft, C.free];
  const dayTot = cfg.days.map((_, i) => data.reduce((a, r) => a + (r.days[i] ? r.days[i].length : 0), 0));
  return (
    <div className="tt-printarea" style={{ ...card, marginTop: 16 }}>
      <Panelhead text="Teacher free-period report — free periods per day" count={`${cfg.singles.length} teachers`} />
      <div className="tt-noprint" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", padding: "10px 14px", borderBottom: `1px solid ${C.line}`, background: "#fafbfc" }}>
        <select className="tt-sel" value={paper} onChange={(e) => setPaper(e.target.value)} style={{ width: 90 }}>{["A4", "A3", "Letter", "Legal"].map((x) => <option key={x}>{x}</option>)}</select>
        <select className="tt-sel" value={orient} onChange={(e) => setOrient(e.target.value)} style={{ width: 118 }}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}><input type="checkbox" checked={showP} onChange={(e) => setShowP(e.target.checked)} /> Show free period numbers</label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}><input type="checkbox" checked={showTot} onChange={(e) => setShowTot(e.target.checked)} /> "Total free" column</label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}><input type="checkbox" checked={showSum} onChange={(e) => setShowSum(e.target.checked)} /> "All teachers" total row</label>
        <span style={{ marginLeft: "auto" }}><PrintBtn onClick={() => exportFreeReportPDF(cfg, paper, { showP, orient, showTot, showSum })} icon="download" label="Download PDF" sub={`${paper} · ${orient}`} /></span>
      </div>
      <div className="tt-scroll" style={{ overflowX: "auto" }}>
        <table style={{ ...tbl, minWidth: 130 + cfg.days.length * 92 }}>
          <thead><tr>
            <th style={{ ...th, textAlign: "left", paddingLeft: 12 }}>Teacher</th>
            {cfg.days.map((d) => <th key={d} style={th}>{DAY_FULL[d].slice(0, 3)}</th>)}
            {showTot && <th style={th}>Total free</th>}
          </tr></thead>
          <tbody>
            {data.map(({ t, days }) => {
              const totalFree = days.reduce((a, f) => a + (f ? f.length : 0), 0);
              return (
                <tr key={t} className="tt-row">
                  <td style={{ ...cellTd, height: 34, textAlign: "left", paddingLeft: 12, fontFamily: mono, fontWeight: 700 }}>{t}</td>
                  {days.map((f, i) => {
                    if (f === null) return <td key={i} style={{ ...cellTd, height: 34, color: C.sub, background: "#f1f3f6", fontSize: 11, fontWeight: 700 }}>OFF</td>;
                    const [bg, fg] = toneOf(f.length);
                    return (
                      <td key={i} style={{ ...cellTd, height: 34, padding: "3px 4px" }}>
                        <span style={{ display: "inline-block", minWidth: 24, padding: "1px 7px", borderRadius: 10, background: bg, color: fg, fontWeight: 800, fontFamily: mono, fontSize: 12.5 }}>{f.length}</span>
                        {showP && <span style={{ display: "block", fontSize: 10.5, color: C.sub, fontWeight: 600, marginTop: 2, fontFamily: mono }}>{f.length ? "P" + f.join(" P") : "—"}</span>}
                      </td>
                    );
                  })}
                  {showTot && <td style={{ ...cellTd, height: 34, fontFamily: mono, fontWeight: 800, color: C.free, background: C.freeSoft }}>{totalFree}</td>}
                </tr>
              );
            })}
            {showSum && <tr>
              <td style={{ ...cellTd, textAlign: "left", paddingLeft: 12, fontWeight: 800, background: C.accentSoft }}>All teachers</td>
              {dayTot.map((x, i) => <td key={i} style={{ ...cellTd, fontWeight: 800, fontFamily: mono, background: C.accentSoft }}>{x}</td>)}
              {showTot && <td style={{ ...cellTd, fontWeight: 800, fontFamily: mono, background: C.accentSoft }}>{dayTot.reduce((a, b) => a + b, 0)}</td>}
            </tr>}
          </tbody>
        </table>
      </div>
      <div className="tt-note">The coloured number is how many free (leisure) periods the teacher has that day; below it are the free period numbers. Combined subjects are counted. OFF = the teacher doesn't work that day.</div>
    </div>
  );
}

/* ---------------- Classes & setup ---------------- */
/* ---------------- Classes, class teachers & teachers import ---------------- */
function parseClassTeacherImport(cfg, rows) {
  const out = { classes: [], teachers: [], newClasses: [], newTeachers: [], ctTwice: [], ctReplaced: [], error: "" };
  const hi = rows.findIndex((r) => r.some((x) => /class|teacher|staff/i.test(x)));
  if (hi < 0) { out.error = "No header row found. The first row must be: Class, Class Teacher, Teacher"; return out; }
  const h = rows[hi].map((x) => x.toLowerCase().replace(/[\s_.-]+/g, " ").trim());
  const ci = h.findIndex((x) => /^(class|div|division|class (and|&) div|class div)$/.test(x));
  const cti = h.findIndex((x) => /^(class teacher|ct|class tr|teacher in charge|cls teacher)$/.test(x));
  const ti = h.findIndex((x, k) => k !== cti && /^(teachers?|staff|tr|teacher code|code|name)$/.test(x));
  if (ci < 0 && ti < 0) { out.error = "Couldn't find a Class column or a Teacher column in the header."; return out; }
  const clsMap = {}; cfg.classes.forEach((c) => (clsMap[impKey(c)] = c));
  const tSet = new Set(cfg.singles.map((t) => t.toUpperCase()));
  const tCase = {}; cfg.singles.forEach((t) => (tCase[t.toUpperCase()] = t));
  const seenT = new Set(), seenC = new Set(), ctOf = {};
  const addT = (raw) => { const U = String(raw || "").trim().toUpperCase(); if (!U || seenT.has(U)) return U ? tCase[U] || U : null; seenT.add(U); const t = tCase[U] || U; out.teachers.push(t); if (!tSet.has(U)) out.newTeachers.push(t); return t; };
  for (const r of rows.slice(hi + 1)) {
    if (ti >= 0 && r[ti]) String(r[ti]).split(/[;,/|]+/).forEach((x) => addT(x));
    if (ci < 0 || !r[ci]) continue;
    const k = impKey(r[ci]); if (!k || seenC.has(k)) continue; seenC.add(k);
    const cls = clsMap[k] || impClassName(r[ci]);
    if (!clsMap[k]) out.newClasses.push(cls);
    const ct = cti >= 0 && r[cti] ? addT(r[cti]) : null;
    out.classes.push({ cls, ct });
    if (ct) { (ctOf[ct] ||= []).push(cls); const cur = cfg.classTeacher[cls]; if (cur && cur !== ct) out.ctReplaced.push(`${cls}: ${cur} → ${ct}`); }
  }
  out.ctTwice = Object.entries(ctOf).filter(([, cs]) => cs.length > 1).map(([t, cs]) => `${t} (${cs.join(", ")})`);
  return out;
}

function applyClassTeacherImport(n, parsed) {
  for (const t of parsed.newTeachers) if (!n.singles.includes(t)) n.singles.push(t);
  n.singles.sort();
  for (const { cls, ct } of parsed.classes) {
    if (!n.classes.includes(cls)) {
      n.classes.push(cls); n.classTeacher[cls] = null;
      n.grid[cls] = {}; n.days.forEach((d) => (n.grid[cls][d] = emptyDay(n.periods.length)));
      const s = stdOf(cls);
      if (!n.stdPeriods[s]) { const prior = Object.keys(n.stdPeriods).sort(); n.stdPeriods[s] = prior.length ? clone(n.stdPeriods[prior[prior.length - 1]]) : {}; }
    }
    if (ct) { for (const c of Object.keys(n.classTeacher)) if (c !== cls && n.classTeacher[c] === ct) n.classTeacher[c] = null; n.classTeacher[cls] = ct; }
  }
}

function exportClassTeacherCSV(cfg) {
  const L = ["Class,Class Teacher,Teacher"];
  const n = Math.max(cfg.classes.length, cfg.singles.length);
  for (let i = 0; i < n; i++) { const c = cfg.classes[i] || ""; L.push([c, c ? cfg.classTeacher[c] || "" : "", cfg.singles[i] || ""].join(",")); }
  const blob = new Blob([L.join("\n") + "\n"], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "classes_and_teachers.csv"; a.click();
}

function ClassTeacherImport({ cfg, update, ask }) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null);
  const [done, setDone] = useState("");
  const fileRef = useRef(null);
  const read = (t) => { setDone(""); const s = String(t || "").trim(); if (!s) { setParsed(null); return; } setParsed(parseClassTeacherImport(cfg, parseDelimited(s))); };
  const onFile = async (f) => { if (!f) return; if (/\.xlsx?$/i.test(f.name)) { setParsed({ error: "Excel files: select the cells in Excel, copy, and paste them in the box — or save the sheet as CSV." }); return; } const t = await f.text(); setText(t); read(t); };
  const apply = () => ask(`Import ${parsed.classes.length} class(es) and ${parsed.teachers.length} teacher(s)? New ones are added; existing classes keep their mapping and timetable${parsed.ctReplaced.length ? `, and ${parsed.ctReplaced.length} class teacher(s) change` : ""}.`, () => {
    update((n) => applyClassTeacherImport(n, parsed));
    setDone(`Imported: ${parsed.newClasses.length} new class(es), ${parsed.newTeachers.length} new teacher(s), ${parsed.classes.filter((x) => x.ct).length} class teacher(s) set.`);
    setParsed(null); setText("");
  });
  return (
    <div style={{ ...card, marginBottom: 16 }}>
      <Panelhead text="Import classes, class teachers & teachers (CSV)" />
      <div style={{ padding: 14, display: "grid", gap: 10 }}>
        <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.6 }}>
          Columns: <code style={{ fontFamily: mono }}>Class, Class Teacher, Teacher</code>. Each row can have a class with its class teacher, a teacher code, or both — the Teacher column is just the list of all teachers, it doesn't have to line up with the classes. Paste cells copied from Excel / Google Sheets, or choose a CSV file.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" style={{ display: "none" }} onChange={(e) => { onFile(e.target.files && e.target.files[0]); e.target.value = ""; }} />
          <button className="tt-btn" onClick={() => fileRef.current && fileRef.current.click()} style={ghostBtn}>Choose file…</button>
          <button className="tt-btn" onClick={() => exportClassTeacherCSV(cfg)} style={ghostBtn}>Download current list (CSV template)</button>
        </div>
        <textarea className="tt-in" value={text} onChange={(e) => setText(e.target.value)} placeholder={"Class,Class Teacher,Teacher\n5 A,MFK,MFK\n5 B,KPH,KPH\n5 C,KPM,DN\n,,ITT"} style={{ width: "100%", minHeight: 100, fontFamily: mono, resize: "vertical" }} />
        <div><button className="tt-btn" onClick={() => read(text)} style={solidBtn} disabled={!text.trim()}>Read & check</button></div>
        {done && <Banner tone="primary">{done}</Banner>}
        {parsed && parsed.error && <Banner tone="warn">{parsed.error}</Banner>}
        {parsed && !parsed.error && (
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, display: "grid", gap: 6, fontSize: 12.5, lineHeight: 1.6 }}>
            <div><b>{parsed.classes.length}</b> class(es) · <b>{parsed.classes.filter((x) => x.ct).length}</b> with a class teacher · <b>{parsed.teachers.length}</b> teacher(s)</div>
            {parsed.newClasses.length > 0 && <div>New classes: <b style={{ fontFamily: mono }}>{parsed.newClasses.sort(cmpClass).join(", ")}</b></div>}
            {parsed.newTeachers.length > 0 && <div>New teachers: <b style={{ fontFamily: mono }}>{parsed.newTeachers.join(", ")}</b></div>}
            {parsed.ctReplaced.length > 0 && <div style={{ color: C.warn }}>Class teacher changes: <span style={{ fontFamily: mono }}>{parsed.ctReplaced.join("; ")}</span></div>}
            {parsed.ctTwice.length > 0 && <div style={{ color: C.clash }}>Class teacher of more than one class (only the last one is kept): <b style={{ fontFamily: mono }}>{parsed.ctTwice.join("; ")}</b></div>}
            {!parsed.newClasses.length && !parsed.newTeachers.length && !parsed.ctReplaced.length && <div style={{ color: C.free }}>Everything already matches the app — nothing new to add.</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button className="tt-btn" onClick={apply} style={solidBtn}>Import</button>
              <button className="tt-btn" onClick={() => setParsed(null)} style={ghostBtn}>Cancel</button>
            </div>
            <div style={{ fontSize: 11.5, color: C.sub }}>Nothing is removed: classes and teachers not in the file stay. New classes start with an empty timetable; set their subjects in Mapping.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function TeacherAvailability({ cfg, update, ask, teacherLoad = {}, mobile }) {
  const [q, setQ] = useState("");
  const [show, setShow] = useState("all");
  const TD = cfg.teacherDays || {};
  const th = CUR_TH || THEMES.teal;
  const isOn = (t, d) => { const a = TD[t]; return !a || !a.length || a.includes(d); };
  const daysOf = (t) => cfg.days.filter((d) => isOn(t, d));
  const setDays = (n, t, a) => { a = n.days.filter((x) => a.includes(x)); if (a.length === n.days.length || a.length === 0) delete n.teacherDays[t]; else n.teacherDays[t] = a; };
  const toggle = (t, d) => update((n) => {
    n.teacherDays = n.teacherDays || {};
    let a = n.teacherDays[t] && n.teacherDays[t].length ? [...n.teacherDays[t]] : [...n.days];
    a = a.includes(d) ? a.filter((x) => x !== d) : [...a, d];
    if (!a.length) return; // at least one working day
    setDays(n, t, a);
  });
  const fullWeek = (t) => update((n) => { if (n.teacherDays) delete n.teacherDays[t]; });
  const limited = cfg.singles.filter((t) => TD[t] && TD[t].length && TD[t].length < cfg.days.length);
  const need = (t) => (teacherLoad[t] || {}).target || 0;
  const over = cfg.singles.filter((t) => need(t) > teacherCap(cfg, t));
  const list = cfg.singles.filter((t) => (!q.trim() || t.toLowerCase().includes(q.trim().toLowerCase())) && (show === "all" || (show === "limited" ? limited.includes(t) : over.includes(t))));
  const short = (d) => (DAY_FULL[d] ? DAY_FULL[d].slice(0, 3) : d);
  const chip = (on) => ({ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 20, fontSize: 12.5, fontWeight: 700, cursor: "pointer", border: `1.5px solid ${on ? th.accent : C.line}`, background: on ? th.accent : "#fff", color: on ? "#fff" : C.sub });
  return (
    <div style={{ ...card, marginBottom: 16 }}>
      <Panelhead text="Teacher availability (working days)" count={limited.length ? `${limited.length} part-week` : "all full week"} tone={limited.length ? undefined : "free"} />
      <div style={{ padding: 14, display: "grid", gap: 12 }}>
        <div className="tt-callout">Tap a day to switch it <b>off</b> for that teacher — the generator never gives them a period on an off day. Use this for part-time teachers or teachers shared with another school.</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ position: "relative", flex: mobile ? "1 1 100%" : "0 0 240px" }}>
            <span aria-hidden="true" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: C.sub, fontSize: 13 }}>⌕</span>
            <input className="tt-in" style={{ paddingLeft: 28, fontFamily: sans, fontSize: 13, height: 34 }} placeholder="Search teacher" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button className="tt-btn" onClick={() => setShow("all")} style={chip(show === "all")}>All <span style={{ opacity: 0.8 }}>{cfg.singles.length}</span></button>
          <button className="tt-btn" onClick={() => setShow("limited")} style={chip(show === "limited")}>Part-week <span style={{ opacity: 0.8 }}>{limited.length}</span></button>
          <button className="tt-btn" onClick={() => setShow("over")} style={{ ...chip(show === "over"), ...(over.length && show !== "over" ? { color: C.clash, borderColor: `${C.clash}66` } : {}) }}>Over capacity <span style={{ opacity: 0.8 }}>{over.length}</span></button>
          {limited.length > 0 && <button className="tt-btn" onClick={() => ask(`Give all ${limited.length} part-week teachers the full week again?`, () => update((n) => { n.teacherDays = {}; }))} style={{ ...ghostBtn, marginLeft: "auto", fontSize: 12, padding: "5px 11px" }}>Reset all to full week</button>}
        </div>
        <div className="tt-scroll" style={{ maxHeight: mobile ? 520 : 470, overflowY: "auto", paddingRight: 2 }}>
          {list.length === 0 && <div style={{ padding: 20, textAlign: "center", fontSize: 13, color: C.sub }}>No teacher matches.</div>}
          <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "repeat(auto-fill, minmax(330px, 1fr))", gap: 10 }}>
            {list.map((t) => {
              const on = daysOf(t), part = on.length < cfg.days.length, cap = teacherCap(cfg, t), nd = need(t), bad = nd > cap;
              return (
                <div key={t} style={{ border: `1.5px solid ${bad ? `${C.clash}55` : part ? `${C.accent}66` : C.line}`, borderRadius: 14, padding: "10px 12px", background: bad ? "#fff8f7" : part ? "#fffcf6" : "#fff", display: "grid", gap: 9 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: "grid", placeItems: "center", fontFamily: mono, fontWeight: 800, fontSize: t.length > 4 ? 10.5 : 12.5, color: "#fff", background: part ? `linear-gradient(135deg, ${C.accent}, #b8701c)` : `linear-gradient(135deg, ${th.g1}, ${th.g2})` }}>{t.replace(/[^A-Za-z0-9]/g, "").slice(0, 3)}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontFamily: mono, fontWeight: 800, fontSize: 14.5, color: C.ink, wordBreak: "break-word", lineHeight: 1.2 }}>{t}</div>
                      <div style={{ fontSize: 11.5, color: C.sub, marginTop: 2 }}>
                        <b style={{ color: part ? "#94620b" : C.free }}>{part ? `${on.length} of ${cfg.days.length} days` : "Full week"}</b> · up to {cap} periods{nd ? <> · needs <b style={{ color: bad ? C.clash : C.ink }}>{nd}</b></> : null}
                      </div>
                    </div>
                    {part && <button className="tt-btn" onClick={() => fullWeek(t)} title="Give this teacher the full week" style={{ ...ghostBtn, padding: "3px 9px", fontSize: 11.5 }}>Full week</button>}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {cfg.days.map((d) => { const o = isOn(t, d); return (
                      <button key={d} className="tt-btn" onClick={() => toggle(t, d)} title={`${DAY_FULL[d] || d}: ${o ? "working — tap to switch off" : "off — tap to switch on"}`}
                        style={{ flex: mobile ? "1 1 0" : "0 0 auto", minWidth: 46, height: 32, borderRadius: 9, fontSize: 12, fontWeight: 800, cursor: "pointer", border: `1.5px solid ${o ? th.accent : C.line}`, background: o ? `${th.accent}16` : "#f3f4f6", color: o ? th.g2 : "#a3abb9", textDecoration: o ? "none" : "line-through" }}>{short(d)}</button>
                    ); })}
                  </div>
                  {bad && <div style={{ fontSize: 11.5, color: C.clash, fontWeight: 600 }}>Needs {nd} periods but can take only {cap} on these days — switch a day on or move some periods to another teacher.</div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function SetupView({ cfg, update, ask, askPw, mobile, teacherLoad, me }) {
  const [name, setName] = useState("");
  const [ct, setCt] = useState("");
  const [clonefrom, setClonefrom] = useState(cfg.classes[0]);
  const [newSub, setNewSub] = useState("");
  const [newTch, setNewTch] = useState("");
  const [err, setErr] = useState("");
  const [renFrom, setRenFrom] = useState("");
  const [renTo, setRenTo] = useState("");

  const [pmStd, setPmStd] = useState(standardsOf(cfg)[0] || "");
  const [pmN, setPmN] = useState(String(cfg.periods.length));
  const setClassMax = (list, v) => {
    const N = cfg.periods.length;
    const lose = []; for (const c of list) { const lim = Math.min(N, v); for (const d of cfg.days) for (let p = lim; p < N; p++) if (cfg.grid[c]?.[d]?.[p]?.[0]) { lose.push(c); break; } }
    const run = () => update((n) => { n.classMaxP = n.classMaxP || {}; for (const c of list) { if (v >= N) delete n.classMaxP[c]; else { n.classMaxP[c] = v; for (const d of n.days) for (let p = v; p < N; p++) { if (n.grid[c]?.[d]?.[p]) n.grid[c][d][p] = [null, null]; delete n.locked?.[`${c}|${d}|${p}`]; } } } });
    const uniq = [...new Set(lose)];
    if (uniq.length) ask(`Set ${list.length > 1 ? `${list.length} classes` : list[0]} to ${v} periods a day? Lessons already in periods ${v + 1}–${N} of ${uniq.join(", ")} will be removed.`, run); else run();
  };
  const [pwCur, setPwCur] = useState(""); const [pwNew, setPwNew] = useState(""); const [pwNew2, setPwNew2] = useState(""); const [pwMsg, setPwMsg] = useState(null);
  const changePw = async (remove) => {
    setPwMsg(null);
    if (cfg.adminPw) { const h = await hashPw(pwCur); if (h !== cfg.adminPw) { setPwMsg({ ok: false, text: "The current password is wrong." }); return; } }
    if (remove) { update((n) => { delete n.adminPw; }); setPwCur(""); setPwMsg({ ok: true, text: "Password removed. Reset and Clear all no longer ask for it — they will ask you to set one." }); return; }
    if (pwNew.length < 4) { setPwMsg({ ok: false, text: "Use at least 4 characters." }); return; }
    if (pwNew !== pwNew2) { setPwMsg({ ok: false, text: "The two new passwords don't match." }); return; }
    const h = await hashPw(pwNew); update((n) => { n.adminPw = h; });
    setPwCur(""); setPwNew(""); setPwNew2(""); setPwMsg({ ok: true, text: "Password saved." });
  };
  const setPeriods = (val) => update((n) => { const N = Math.max(1, Math.min(12, parseInt(val, 10) || 8)); n.periods = Array.from({ length: N }, (_, i) => i + 1); for (const c of n.classes) for (const d of n.days) { const a = n.grid[c][d] || []; while (a.length < N) a.push([null, null]); a.length = N; n.grid[c][d] = a; } });
  const toggleDay = (d) => update((n) => {
    if (n.days.includes(d)) {
      n.days = n.days.filter((x) => x !== d);
      for (const c of n.classes) delete n.grid[c][d];
    } else {
      n.days = WEEK_ORDER.filter((x) => n.days.includes(x) || x === d);
      for (const c of n.classes) n.grid[c][d] = emptyDay(n.periods.length);
    }
  });

  const addClass = () => {
    const nm = name.trim(); if (!nm) return;
    if (cfg.classes.includes(nm)) { setErr(`Class ${nm} already exists.`); return; }
    setErr("");
    update((n) => {
      n.classes.push(nm);
      n.classTeacher[nm] = ct || null;
      n.grid[nm] = {}; n.days.forEach((d) => (n.grid[nm][d] = emptyDay(n.periods.length)));
      if (clonefrom && n.bkey[clonefrom]) n.bkey[nm] = clone(n.bkey[clonefrom]);
      const s = stdOf(nm);
      if (!n.stdPeriods[s]) {
        const prior = Object.keys(n.stdPeriods).sort();
        n.stdPeriods[s] = prior.length ? clone(n.stdPeriods[prior[prior.length - 1]]) : {};
      }
    });
    setName(""); setCt("");
  };
  const delClass = (c) => ask(`Remove class ${c}, along with its timetable and mapping?`, () => update((n) => {
    n.classes = n.classes.filter((x) => x !== c); delete n.grid[c]; delete n.bkey[c]; delete n.classTeacher[c];
  }));
  const addSubject = () => { const s = newSub.trim().toUpperCase(); if (!s || cfg.subjects.includes(s)) return; update((n) => n.subjects.push(s)); setNewSub(""); };
  const delSubject = (s) => ask(`Remove subject ${s} from the list? Existing mapping rows using it stay until you change them.`, () => update((n) => { n.subjects = n.subjects.filter((x) => x !== s); }));
  const addTeacher = () => { const t = newTch.trim().toUpperCase(); if (!t || cfg.singles.includes(t)) return; update((n) => { n.singles.push(t); n.singles.sort(); }); setNewTch(""); };
  const delTeacher = (t) => ask(`Remove teacher ${t}? They’ll be cleared as class teacher where set; mapping/timetable entries using them stay until you change them.`, () => update((n) => {
    n.singles = n.singles.filter((x) => x !== t);
    for (const c of n.classes) if (n.classTeacher[c] === t) n.classTeacher[c] = null;
  }));
  const doRename = () => { const oldN = renFrom, newN = renTo.trim().toUpperCase(); if (!oldN || !newN || oldN === newN) return; update((n) => {
    n.singles = [...new Set(n.singles.map((t) => t === oldN ? newN : t))];
    for (const c of n.classes) { if (n.classTeacher[c] === oldN) n.classTeacher[c] = newN; (n.bkey[c] || []).forEach((r) => { if (r.teacher === oldN) r.teacher = newN; }); for (const d of n.days) (n.grid[c][d] || []).forEach((sl) => { if (sl[0] === oldN) sl[0] = newN; }); }
    (n.combined || []).forEach((se) => { se.teachers = se.teachers.map((t) => t === oldN ? newN : t); });
    if (n.teacherDays && n.teacherDays[oldN]) { n.teacherDays[newN] = n.teacherDays[oldN]; delete n.teacherDays[oldN]; }
  }); setRenFrom(""); setRenTo(""); };

  return (
    <div>
      <ViewHeader title="Classes & setup" note="Add or remove classes each academic year, choose the working days, and maintain the subject and teacher lists." />

      <div style={{ ...card, marginBottom: 16 }}>
        <Panelhead text="School name" />
        <div style={{ padding: 14 }}>
          <input className="tt-in" style={{ maxWidth: 380, fontSize: 14, padding: "9px 11px" }} value={cfg.school} onChange={(e) => update((n) => { n.school = e.target.value; })} placeholder="Your school name" />
        </div>
      </div>
      <YearCard cfg={cfg} update={update} askPw={askPw} />
      <StaffAccessCard cfg={cfg} update={update} me={me} />
      <LogoCard cfg={cfg} update={update} />
      <StampCard cfg={cfg} update={update} mobile={mobile} />

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

      <div style={{ ...card, marginBottom: 16 }}>
        <Panelhead text="Periods per day" />
        <div style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: C.sub }}>Number of periods each day:</span>
          <select className="tt-sel" style={{ width: 90, textAlign: "center", fontWeight: 700 }} value={cfg.periods.length} onChange={(e) => { const v = +e.target.value; if (v < cfg.periods.length) ask(`Reduce to ${v} periods a day? Periods ${v + 1}–${cfg.periods.length} will be removed from every class timetable.`, () => setPeriods(v)); else setPeriods(v); }}>{Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</select>
          <span style={{ fontSize: 12, color: C.sub }}>e.g. 6, 7 or 8. Changing this adds or trims period columns across every class.</span>
        </div>
        {cfg.periods.length > 1 && (
          <div style={{ padding: "0 14px 14px", display: "grid", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: C.sub }}>Forenoon (FN) periods:</span>
              <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
                {cfg.periods.slice(0, -1).map((_, i) => { const v = i + 1, on = fnCount(cfg) === v; return <button key={v} className="tt-btn" onClick={() => update((n) => { n.fnCount = v; })} style={{ border: "none", padding: "6px 12px", fontSize: 13, fontWeight: 800, cursor: "pointer", background: on ? C.primary : "#fff", color: on ? "#fff" : C.sub }}>{v}</button>; })}
              </div>
              {cfg.fnCount && <button className="tt-btn" onClick={() => update((n) => { delete n.fnCount; })} style={{ ...ghostBtn, padding: "5px 10px", fontSize: 12 }}>Back to default ({Math.ceil(cfg.periods.length / 2)})</button>}
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
              {cfg.periods.map((p, i) => (
                <React.Fragment key={i}>
                  {i === fnCount(cfg) && <span style={{ fontSize: 10.5, fontWeight: 800, color: C.accent, padding: "0 6px", letterSpacing: 0.5 }}>LUNCH</span>}
                  <span style={{ minWidth: 40, textAlign: "center", padding: "6px 8px", borderRadius: 8, fontSize: 12.5, fontWeight: 800, background: i < fnCount(cfg) ? "#e8f2ff" : C.accentSoft, color: i < fnCount(cfg) ? "#2b5fa8" : "#94620b" }}>P{p}</span>
                </React.Fragment>
              ))}
              <span style={{ fontSize: 12, color: C.sub, marginLeft: 8 }}><b style={{ color: "#2b5fa8" }}>FN</b> P1–P{fnCount(cfg)} · <b style={{ color: "#94620b" }}>AN</b> P{fnCount(cfg) + 1}–P{cfg.periods.length}</span>
            </div>
            <div style={{ fontSize: 11.5, color: C.sub }}>Used for half-day leave in Daily substitution, "core subjects in the forenoon", the teacher pages and the FN / AN marks on printed timetables.</div>
          </div>
        )}
      </div>
      <div style={{ ...card, marginBottom: 16 }}>
        <Panelhead text="Periods per day — classes that have fewer" count={Object.keys(cfg.classMaxP || {}).filter((c) => classPeriods(cfg, c) < cfg.periods.length).length || undefined} />
        <div style={{ padding: 14, display: "grid", gap: 12 }}>
          <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.6 }}>The number above ({cfg.periods.length}) is the default for every class. If some classes have fewer periods a day, set them here — their last periods are left empty and the generator never uses them.</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12.5, color: C.sub }}>
            <span style={{ fontWeight: 700 }}>Whole standard:</span>
            <select className="tt-sel" style={{ width: 80 }} value={pmStd} onChange={(e) => setPmStd(e.target.value)}>{standardsOf(cfg).map((x) => <option key={x} value={x}>Std {x}</option>)}</select>
            <select className="tt-sel" style={{ width: 120 }} value={pmN} onChange={(e) => setPmN(e.target.value)}>{cfg.periods.map((p) => <option key={p} value={p}>{p === cfg.periods.length ? `${p} (default)` : `${p} periods`}</option>)}</select>
            <button className="tt-btn" onClick={() => setClassMax(cfg.classes.filter((c) => stdOf(c) === pmStd), +pmN)} style={ghostBtn}>Apply to Std {pmStd}</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))", gap: 6 }}>
            {cfg.classes.map((c) => { const v = classPeriods(cfg, c); const less = v < cfg.periods.length; return (
              <label key={c} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 9, border: `1px solid ${less ? C.warn : C.line}`, background: less ? C.warnSoft : "#fff", fontSize: 12.5 }}>
                <b style={{ fontFamily: mono, minWidth: 30 }}>{c}</b>
                <select className="tt-sel" style={{ flex: 1, padding: "3px 4px", fontWeight: 700 }} value={v} onChange={(e) => setClassMax([c], +e.target.value)}>{cfg.periods.map((p) => <option key={p} value={p}>{p}</option>)}</select>
              </label>); })}
          </div>
        </div>
      </div>

      <div style={{ ...card, marginBottom: 16 }}>
        <Panelhead text="Admin password" count={cfg.adminPw ? "set" : "not set"} tone={cfg.adminPw ? "free" : undefined} />
        <div style={{ padding: 14, display: "grid", gap: 10 }}>
          <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.6 }}>Needed for <b>Reset</b>, <b>Master reset</b>, <b>Clear all</b> (Assign timetable) and <b>Clear all mapping</b>. Everyone who signs in uses the same password.</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {cfg.adminPw && <input className="tt-in" type="password" placeholder="Current password" value={pwCur} onChange={(e) => setPwCur(e.target.value)} style={{ width: 170 }} />}
            <input className="tt-in" type="password" placeholder="New password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} style={{ width: 170 }} />
            <input className="tt-in" type="password" placeholder="Repeat new password" value={pwNew2} onChange={(e) => setPwNew2(e.target.value)} style={{ width: 170 }} />
            <button className="tt-btn" onClick={() => changePw(false)} style={solidBtn}>{cfg.adminPw ? "Change password" : "Set password"}</button>
            {cfg.adminPw && <button className="tt-btn" onClick={() => changePw(true)} style={{ ...ghostBtn, color: C.clash }}>Remove password</button>}
          </div>
          {pwMsg && <div style={{ fontSize: 12.5, color: pwMsg.ok ? C.free : C.clash, fontWeight: 600 }}>{pwMsg.text}</div>}
        </div>
      </div>

      <ClassTeacherImport cfg={cfg} update={update} ask={ask} />
      <TeacherAvailability cfg={cfg} update={update} ask={ask} teacherLoad={teacherLoad} mobile={mobile} />
      <ExtraDutiesPanel cfg={cfg} update={update} ask={ask} mobile={mobile} />

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
                <option value="">class teacher…</option>{cfg.singles.filter((t) => !Object.values(cfg.classTeacher).includes(t)).map((t) => <option key={t}>{t}</option>)}
              </select>
              <select className="tt-sel" style={{ width: 150 }} value={clonefrom} onChange={(e) => setClonefrom(e.target.value)}>
                <option value="">blank mapping</option>{cfg.classes.map((c) => <option key={c} value={c}>copy mapping from {c}</option>)}
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
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "10px 14px", borderBottom: `1px solid ${C.line}` }}>
              <span style={{ fontSize: 12, color: C.sub, fontWeight: 700 }}>Rename teacher:</span>
              <select className="tt-sel" style={{ width: 110 }} value={renFrom} onChange={(e) => setRenFrom(e.target.value)}><option value="">pick…</option>{cfg.singles.map((t) => <option key={t}>{t}</option>)}</select>
              <input className="tt-in" style={{ width: 120 }} placeholder="new name" value={renTo} onChange={(e) => setRenTo(e.target.value)} />
              <button className="tt-btn" onClick={doRename} style={ghostBtn}>Rename everywhere</button>
            </div>
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

var SCHOOL_LOGO = "", SCHOOL_WM = true;
function openPrint(title, css, bodyHtml) {
  var w = window.open("", "_blank");
  if (!w) { alert("Please allow pop-ups for this site so the PDF can open, then choose 'Save as PDF' and paper size A4."); return; }
  var wm = SCHOOL_LOGO && SCHOOL_WM ? '<img class="tt-wm" src="' + SCHOOL_LOGO + '" alt="">' : '';
  var wmCss = wm ? ' .tt-wm{position:fixed;top:50%;left:50%;width:56%;max-width:150mm;max-height:62%;object-fit:contain;transform:translate(-50%,-50%);opacity:.09;z-index:9999;pointer-events:none;mix-blend-mode:multiply}' : '';
  w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>' + (SCHOOL_LOGO ? '<link rel="icon" href="' + SCHOOL_LOGO + '">' : '') + '<style>' + css + wmCss + '</style></head><body>' + wm + bodyHtml + '<scr' + 'ipt>window.onload=function(){setTimeout(function(){window.print();},350);};<\/scr' + 'ipt></body></html>');
  w.document.close();
}

function subTint(sub) { var hex = SUBJECT_BAR[sub]; if (!hex) return "#ffffff"; var nn = parseInt(hex.slice(1), 16); return "rgba(" + ((nn >> 16) & 255) + "," + ((nn >> 8) & 255) + "," + (nn & 255) + ",0.16)"; }
function subCol(sub) { return SUBJECT_BAR[sub] || "#444"; }


function gridHead(cfg) {
  var head = "<tr><th>Day / Period</th>", fn = fnCount(cfg);
  for (var pi = 0; pi < cfg.periods.length; pi++) head += "<th>P" + cfg.periods[pi] + (pi === 0 ? "<div style='font-size:9.5px;opacity:.85;font-weight:700;letter-spacing:.5px'>FN</div>" : pi === fn ? "<div style='font-size:9.5px;opacity:.85;font-weight:700;letter-spacing:.5px'>AN</div>" : "") + "</th>";
  return head + "</tr>";
}

function teacherAt(cfg, t, d, p) {
  var cm = {}; (cfg.combined || []).forEach(function (s) { cm[s.name] = s; });
  var hit = null, divs = [];
  for (var ci = 0; ci < cfg.classes.length; ci++) {
    var c = cfg.classes[ci];
    var slot = cfg.grid[c] && cfg.grid[c][d] && cfg.grid[c][d][p];
    var code = slot && slot[0];
    if (!code) continue;
    var s = cm[code] || cm[baseName(code)];
    if (s) { if (s.teachers.indexOf(t) >= 0) { divs.push(c); if (!hit) hit = { sub: s.sub, combined: true }; } continue; }
    if (code === t || (code.indexOf(" ") >= 0 && code.split(" ").indexOf(t) >= 0)) return { c: c, sub: slot[1] };
  }
  if (hit) { hit.c = divs.join(", "); return hit; }
  var ex = extraAt(cfg, t, d, p);
  if (ex) return { c: ex.label || "Duty", sub: ex.kind === "class" ? "Class" : "Duty", extra: true, kind: ex.kind };
  return null;
}
function isOffDay(cfg, t, d) { var a = (cfg.teacherDays || {})[t]; return !!(a && a.length && a.indexOf(d) < 0); }

function pdfLetterhead(cfg, kind, title, sub) {
  return '<div class="lh">' + (cfg.logo ? '<img src="' + cfg.logo + '" alt="">' : '') + '<div class="lt"><div class="ls">' + esc(cfg.school || "") + '</div><div class="lk">' + esc(kind) + (cfg.year ? ' &middot; ' + esc(cfg.year) : '') + '</div></div><div class="lr"><div class="lti">' + esc(title) + '</div>' + (sub ? '<div class="lsu">' + sub + '</div>' : '') + '</div></div>';
}
var STAMP_K = { S: 0.8, M: 1, L: 1.22 };
function stampGeom(cfg) {
  var sh = 14.5 * (STAMP_K[cfg && cfg.signSize] || 1), sd = 24 * (STAMP_K[cfg && cfg.sealSize] || 1), pos = (cfg && cfg.sealPos) || "corner";
  var sealCss = pos === "over" ? "left:50%;margin-left:" + (-sd / 2) + "mm;bottom:" + (-sd * 0.04) + "mm" : pos === "right" ? "right:-6mm;bottom:" + (-sd * 0.2) + "mm" : "left:-15mm;bottom:" + (-sd * 0.2) + "mm";
  return { sh: sh, sd: sd, pos: pos, sealCss: sealCss, boxH: Math.max(15, sh + 1) };
}
function pdfFooter(left, sigs, cfg, kind) {
  var d = new Date().toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  var on = cfg && (kind === "teacher" ? cfg.signOnTeacher !== false : cfg.signOnClass !== false);
  var hmTitle = (cfg && cfg.hmTitle) || "Headmaster", g = stampGeom(cfg);
  var corner = on && cfg.seal && g.pos === "corner" && sigs.indexOf("Headmaster") >= 0;
  var cornerSeal = corner ? '<div style="flex-shrink:0;margin-right:5mm;align-self:flex-end"><img src="' + cfg.seal + '" alt="" style="display:block;width:' + g.sd + 'mm;height:' + g.sd + 'mm;object-fit:contain;opacity:.92;mix-blend-mode:multiply"></div>' : '';
  return '<div class="ft">' + cornerSeal + '<div class="gen">' + left + '<br>Generated ' + esc(d) + '</div>' + sigs.map(function (s) {
    var isHM = s === "Headmaster";
    if (!isHM) return '<div class="sig"><div class="sgi" style="height:' + g.boxH + 'mm"></div><div class="sgl">' + esc(s) + '</div></div>';
    var img = on && cfg.hmSign ? '<img class="sg" src="' + cfg.hmSign + '" alt="" style="max-height:' + g.sh + 'mm;max-width:50mm">' : '';
    var seal = on && cfg.seal && !corner ? '<img class="seal" src="' + cfg.seal + '" alt="" style="width:' + g.sd + 'mm;height:' + g.sd + 'mm;left:auto;right:auto;bottom:auto;' + g.sealCss + '">' : '';
    return '<div class="sig hm"><div class="sgi" style="height:' + g.boxH + 'mm">' + seal + img + '</div><div class="sgl">' + esc(hmTitle) + (cfg && cfg.hmName ? '<span class="sgn">' + esc(cfg.hmName) + '</span>' : '') + '</div></div>';
  }).join("") + '</div>';
}
function gridCss(paper) {
  var ph = { A3: 277, Letter: 196, Legal: 196 }[paper] || 190;
  return "@page{size:" + (paper || "A4") + " landscape;margin:1cm} *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box} html,body{margin:0;height:100%} body{font-family:Arial,Helvetica,sans-serif;color:#16213a}" +
    " .page{page-break-after:always;height:" + ph + "mm;display:flex;flex-direction:column} .page:last-child{page-break-after:auto}" +
    " h2{font-size:20px;margin:0 0 6px;text-align:center;background:#0e6b73;color:#fff;padding:8px;border-radius:6px} .sub{font-size:13px;color:#0a4f55;margin:0 0 8px;text-align:center;font-weight:700}" +
    " .lh{display:flex;align-items:center;gap:12px;border-bottom:3px solid #0e6b73;padding-bottom:7px;margin-bottom:8px} .lh img{height:58px;width:58px;object-fit:contain}" +
    " .ls{font-size:21px;font-weight:800;color:#0a4f55;letter-spacing:.6px;text-transform:uppercase;line-height:1.1} .lk{font-size:11px;font-weight:800;color:#d98a2b;letter-spacing:2.5px;text-transform:uppercase;margin-top:3px}" +
    " .lr{margin-left:auto;text-align:right} .lti{display:inline-block;font-size:22px;font-weight:800;background:linear-gradient(115deg,#0a4f55,#0e6b73);color:#fff;padding:5px 16px;border-radius:8px} .lsu{font-size:12.5px;color:#0a4f55;font-weight:700;margin-top:4px}" +
    " table{border-collapse:collapse;width:100%;height:100%;table-layout:fixed;flex:1;border:2px solid #0e6b73} th,td{border:1px solid #a9c6c6;text-align:center;padding:3px;font-size:14px}" +
    " tr>*:first-child{width:96px;font-weight:800;background:#e1f0f0;color:#0a4f55} thead th{background:#0e6b73;color:#fff;font-weight:700;height:30px} td .t{font-weight:800;font-size:16px} td .s{font-size:12px;font-weight:700} td{word-break:break-word;overflow-wrap:anywhere;line-height:1.2}" +
    " .sm{display:flex;flex-wrap:wrap;gap:4px 6px;margin-top:6px} .sm span{font-size:10.5px;border:1px solid #cfdede;border-radius:10px;padding:1px 8px;background:#f6fafa;color:#33415c} .sm b{margin-right:4px}" +
    " .ft{display:flex;align-items:flex-end;gap:16mm;margin-top:9mm} .gen{margin-right:auto;font-size:10px;color:#647189;line-height:1.4} .sig{width:52mm;text-align:center;color:#16213a} .sgi{height:16mm;position:relative;display:flex;align-items:flex-end;justify-content:center} .sgi img.sg{position:relative;max-height:15.5mm;max-width:50mm;object-fit:contain;mix-blend-mode:multiply} .sgi img.seal{position:absolute;left:-15mm;bottom:-5mm;width:25mm;height:25mm;object-fit:contain;opacity:.9;mix-blend-mode:multiply} .sgl{border-top:1.2px solid #16213a;padding-top:3px;font-size:11px;font-weight:700} .sgn{display:block;font-size:10px;font-weight:600;color:#4b5870}";
}
function exportClassesPDF(cfg, paper, only) {
  var head = gridHead(cfg), pages = "", list = only && only.length ? only : cfg.classes;
  for (var ci = 0; ci < list.length; ci++) {
    var c = list[ci], body = "", sum = {}, order = [];
    for (var di = 0; di < cfg.days.length; di++) {
      var d = cfg.days[di], row = "<tr><th>" + esc(DAY_FULL[d]) + "</th>";
      for (var p = 0; p < cfg.periods.length; p++) {
        var slot = (cfg.grid[c] && cfg.grid[c][d] && cfg.grid[c][d][p]) || [null, null];
        var cs = (cfg.combined || []).find(function (x) { return x.name === slot[0]; }); var who = cs ? cs.teachers.join(" ") : slot[0];
        if (p >= classPeriods(cfg, c)) { row += '<td style="background:#e4e6ea"></td>'; continue; }
        if (slot[0]) { var key = slot[1] + "|" + who; if (!sum[key]) { sum[key] = { sub: slot[1], who: who, n: 0 }; order.push(key); } sum[key].n++; }
        row += slot[0] ? ('<td style="background:' + subTint(slot[1]) + ';border-left:5px solid ' + subCol(slot[1]) + '"><span class="t" style="color:' + subCol(slot[1]) + '">' + esc(slot[1]) + '</span><br><span class="s">' + esc(who) + '</span></td>') : "<td></td>";
      }
      body += row + "</tr>";
    }
    var strip = order.map(function (k) { var x = sum[k]; return '<span><b style="color:' + subCol(x.sub) + '">' + esc(x.sub) + '</b>' + esc(x.who) + ' &times;' + x.n + '</span>'; }).join("");
    var total = order.reduce(function (a, k) { return a + sum[k].n; }, 0);
    pages += '<div class="page">' + pdfLetterhead(cfg, "Class Time Table", "Class " + c, "Class teacher: " + esc(cfg.classTeacher[c] || "-") + " &middot; " + total + " periods / week") +
      '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>' + (strip ? '<div class="sm">' + strip + '</div>' : '') +
      pdfFooter(esc(cfg.school || "") + " &middot; Class " + esc(c), ["Class Teacher", "Headmaster"], cfg, "class") + '</div>';
  }
  openPrint(esc(cfg.school) + (list.length === 1 ? " - Class " + esc(list[0]) : " - Class timetables"), gridCss(paper) + fnCss(cfg), pages);
}

function exportTeachersPDF(cfg, paper, only) {
  var head = gridHead(cfg), pages = "", list = only && only.length ? only : cfg.singles;
  for (var ti = 0; ti < list.length; ti++) {
    var t = list[ti], body = "", placed = 0, cls = {};
    for (var di = 0; di < cfg.days.length; di++) {
      var d = cfg.days[di], row = "<tr><th>" + esc(DAY_FULL[d]) + "</th>", off = isOffDay(cfg, t, d);
      for (var p = 0; p < cfg.periods.length; p++) {
        var r = teacherAt(cfg, t, d, p);
        if (r) { placed++; String(r.c).split(", ").forEach(function (x) { cls[x] = 1; }); }
        row += r ? ('<td style="background:' + subTint(r.sub) + ';border-left:5px solid ' + subCol(r.sub) + '"><span class="t">' + esc(r.c) + '</span><br><span class="s" style="color:' + subCol(r.sub) + '">' + esc(r.sub) + (r.combined ? " &middot; combined" : "") + '</span></td>') : (off ? '<td style="background:#e4e6ea;color:#8a93a3;font-size:11px">off</td>' : "<td></td>");
      }
      body += row + "</tr>";
    }
    var free = teacherCap(cfg, t) - placed, cl = Object.keys(cls).sort(cmpClass);
    pages += '<div class="page">' + pdfLetterhead(cfg, "Teacher Time Table", t, placed + " periods / week &middot; " + free + " free") +
      '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>' + (cl.length ? '<div class="sm"><span><b>Classes</b>' + esc(cl.join(", ")) + '</span></div>' : '') +
      pdfFooter(esc(cfg.school || "") + " &middot; Teacher " + esc(t), ["Teacher", "Headmaster"], cfg, "teacher") + '</div>';
  }
  openPrint(esc(cfg.school) + (list.length === 1 ? " - " + esc(list[0]) : " - Teacher timetables"), gridCss(paper) + fnCss(cfg), pages);
}



function lhCss() {
  return " .lh{display:flex;align-items:center;gap:12px;border-bottom:3px solid #0e6b73;padding-bottom:7px;margin-bottom:8px} .lh img{height:56px;width:56px;object-fit:contain}" +
    " .ls{font-size:21px;font-weight:800;color:#0a4f55;letter-spacing:.6px;text-transform:uppercase;line-height:1.1} .lk{font-size:11px;font-weight:800;color:#d98a2b;letter-spacing:2.5px;text-transform:uppercase;margin-top:3px}" +
    " .lr{margin-left:auto;text-align:right} .lti{display:inline-block;font-size:20px;font-weight:800;background:linear-gradient(115deg,#0a4f55,#0e6b73);color:#fff;padding:5px 16px;border-radius:8px} .lsu{font-size:12px;color:#0a4f55;font-weight:700;margin-top:4px}" +
    " .ft{display:flex;align-items:flex-end;gap:16mm;margin-top:6mm} .gen{margin-right:auto;font-size:10px;color:#647189;line-height:1.4}" +
    " .sig{width:52mm;text-align:center;color:#16213a} .sgi{height:15mm;position:relative;display:flex;align-items:flex-end;justify-content:center}" +
    " .sgi img.sg{position:relative;max-height:14.5mm;max-width:50mm;object-fit:contain;mix-blend-mode:multiply} .sgi img.seal{position:absolute;left:-15mm;bottom:-5mm;width:24mm;height:24mm;object-fit:contain;opacity:.9;mix-blend-mode:multiply}" +
    " .sgl{border-top:1.2px solid #16213a;padding-top:3px;font-size:11px;font-weight:700} .sgn{display:block;font-size:10px;font-weight:600;color:#4b5870}";
}
// who is free when: free[d][p] = [teachers], perDay[t][d] = free count that day, week[t] = free count in the week
function leisureData(cfg) {
  var free = {}, perDay = {}, week = {}, busy = {};
  cfg.singles.forEach(function (t) { perDay[t] = {}; week[t] = 0; busy[t] = {}; });
  for (var di = 0; di < cfg.days.length; di++) {
    var d = cfg.days[di]; free[d] = [];
    for (var p = 0; p < cfg.periods.length; p++) {
      var list = [];
      for (var ti = 0; ti < cfg.singles.length; ti++) {
        var t = cfg.singles[ti];
        if (isOffDay(cfg, t, d)) { (busy[t][d] || (busy[t][d] = []))[p] = "off"; continue; }
        var r = teacherAt(cfg, t, d, p);
        (busy[t][d] || (busy[t][d] = []))[p] = r;
        if (!r) { list.push(t); perDay[t][d] = (perDay[t][d] || 0) + 1; week[t]++; }
      }
      list.sort(function (a, b) { return a.localeCompare(b); });
      free[d].push(list);
    }
  }
  return { free: free, perDay: perDay, week: week, busy: busy };
}
function cntTone(n) { return n <= 3 ? "background:#fbe0dd;color:#b3261e" : n <= 6 ? "background:#fbefd5;color:#94620b" : "background:#d7f2e2;color:#126236"; }
function freeKey(showLow) {
  return "<div class='lg'><b>Key:</b><span><span class='cn' style='" + cntTone(2) + "'>0–3 free</span> short of cover</span><span><span class='cn' style='" + cntTone(5) + "'>4–6 free</span></span><span><span class='cn' style='" + cntTone(9) + "'>7+ free</span> plenty</span>" +
    (showLow ? "<span><span class='tc'>AB</span> free 3+ periods that day — ask first</span><span><span class='tc lo'>AB</span> only 1–2 free that day</span>" : "") + "<span>Teachers on an off day are not listed. Combined subjects are counted.</span></div>";
}

/* 1. Substitution chart: days down, periods across, free teachers in each box */
function exportSubChartPDF(cfg, o) {
  o = o || {};
  var paper = o.paper || "A3", L = leisureData(cfg), P = cfg.periods.length, D = cfg.days.length;
  var maxN = 0; cfg.days.forEach(function (d) { L.free[d].forEach(function (l) { if (l.length > maxN) maxN = l.length; }); });
  var big = paper === "A3", fs = big ? (maxN > 22 ? 11 : 12.5) : (maxN > 16 ? 8.5 : 10);
  var ph = { A3: 277, A4: 190, Letter: 196, Legal: 196 }[paper] || 190;
  var css = "@page{size:" + paper + " landscape;margin:1cm} *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box} html,body{margin:0} body{font-family:Arial,Helvetica,sans-serif;color:#16213a}" +
    " .page{height:" + ph + "mm;display:flex;flex-direction:column}" + lhCss() +
    " table{border-collapse:collapse;width:100%;table-layout:fixed;flex:1;border:2px solid #0e6b73} th,td{border:1px solid #a9c6c6}" +
    " thead th{background:#0e6b73;color:#fff;font-size:" + (big ? 15 : 12) + "px;font-weight:800;height:" + (big ? 30 : 24) + "px} th.dy{width:" + (big ? 30 : 22) + "mm;background:#e1f0f0;color:#0a4f55;font-size:" + (big ? 15 : 12) + "px;font-weight:800}" +
    " td{vertical-align:top;padding:" + (big ? "5px 5px" : "3px 3px") + "} td.no{background:repeating-linear-gradient(135deg,#f1f3f6 0 6px,#e6e9ee 6px 12px)}" +
    " .cn{display:inline-block;font-size:" + (fs - 0.5) + "px;font-weight:800;padding:1px 8px;border-radius:10px;margin-bottom:4px}" +
    " .tc{display:inline-block;font-family:'Courier New',monospace;font-size:" + fs + "px;font-weight:800;padding:1px 4px;margin:0 3px 3px 0;border-radius:4px;background:#eef7f7;border:1px solid #bcd9d9;color:#0a3d42}" +
    " .tc.lo{background:#f8f9fb;border:1px dashed #aab3c1;color:#4b5563;font-weight:600}" +
    " .lg{margin-top:6px;font-size:10.5px;color:#4b5870;display:flex;gap:12px;flex-wrap:wrap;align-items:center} .lg .tc,.lg .cn{font-size:10px;margin:0}" +
    " .wk{margin-top:6px;font-size:10px;color:#33415c;line-height:1.7} .wk b{color:#0a4f55} .wk span{display:inline-block;margin-right:9px;white-space:nowrap}";
  var head = "<tr><th class='dy'>Day</th>"; for (var p = 0; p < P; p++) head += "<th>P" + cfg.periods[p] + "</th>"; head += "</tr>";
  var body = "";
  for (var di = 0; di < D; di++) {
    var d = cfg.days[di]; body += "<tr><th class='dy'>" + esc(DAY_FULL[d]) + "</th>";
    for (var p2 = 0; p2 < P; p2++) {
      var anyClass = cfg.classes.some(function (c) { return p2 < classPeriods(cfg, c); });
      if (!anyClass) { body += "<td class='no'></td>"; continue; }
      var l = L.free[d][p2];
      body += "<td><span class='cn' style='" + cntTone(l.length) + "'>" + l.length + " free</span><br>" +
        l.map(function (t) { return "<span class='tc" + ((L.perDay[t][d] || 0) <= 2 ? " lo" : "") + "'>" + esc(t) + "</span>"; }).join("") + "</td>";
    }
    body += "</tr>";
  }
  var wk = "";
  if (o.showWeek !== false) {
    var arr = cfg.singles.slice().sort(function (a, b) { return L.week[b] - L.week[a] || a.localeCompare(b); });
    wk = "<div class='wk'><b>Free periods this week:</b> " + arr.map(function (t) { return "<span>" + esc(t) + " <b>" + L.week[t] + "</b></span>"; }).join("") + "</div>";
  }
  var foot = o.sign !== false ? pdfFooter(esc(cfg.school || "") + " &middot; Substitution chart", ["Headmaster"], cfg, "class") : "";
  openPrint(esc(cfg.school) + " - Substitution chart", css, "<div class='page'>" + pdfLetterhead(cfg, "Substitution chart", "Free teachers by period", cfg.singles.length + " teachers &middot; " + D + " days &middot; " + P + " periods") +
    "<table><thead>" + head + "</thead><tbody>" + body + "</tbody></table>" + freeKey(true) + wk + foot + "</div>");
}

/* 2. One page per day: periods down the side, free teachers listed */
function exportFreeDailyPDF(cfg, o) {
  o = o || {};
  var paper = o.paper || "A4", L = leisureData(cfg), P = cfg.periods.length;
  var ph = { A3: 400, A4: 277, Letter: 259, Legal: 336 }[paper] || 277, big = paper === "A3";
  var css = "@page{size:" + paper + " portrait;margin:1cm} *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box} html,body{margin:0} body{font-family:Arial,Helvetica,sans-serif;color:#16213a}" +
    " .page{height:" + ph + "mm;display:flex;flex-direction:column;page-break-after:always} .page:last-child{page-break-after:auto}" + lhCss() +
    " table{border-collapse:collapse;width:100%;table-layout:fixed;flex:1;border:2px solid #0e6b73} th,td{border:1px solid #a9c6c6}" +
    " thead th{background:#0e6b73;color:#fff;font-size:13px;font-weight:800;height:28px} th.pp{width:22mm;background:#e1f0f0;color:#0a4f55;font-size:" + (big ? 22 : 18) + "px;font-weight:800}" +
    " td{vertical-align:middle;padding:5px 7px} td.n{width:24mm;text-align:center} td.no{background:repeating-linear-gradient(135deg,#f1f3f6 0 6px,#e6e9ee 6px 12px)}" +
    " .cn{display:inline-block;font-size:13px;font-weight:800;padding:2px 9px;border-radius:12px}" +
    " .tc{display:inline-block;font-family:'Courier New',monospace;font-size:" + (big ? 16 : 13.5) + "px;font-weight:800;padding:2px 6px;margin:2px 4px 2px 0;border-radius:5px;background:#eef7f7;border:1px solid #bcd9d9;color:#0a3d42}" +
    " .tc.lo{background:#f8f9fb;border:1px dashed #aab3c1;color:#4b5563;font-weight:600}" +
    " .lg{margin-top:6px;font-size:10.5px;color:#4b5870;display:flex;gap:12px;flex-wrap:wrap;align-items:center} .lg .tc,.lg .cn{font-size:10px;margin:0}" +
    " .off{margin-top:5px;font-size:11px;color:#647189}";
  var days = o.day ? [o.day] : cfg.days, pages = "";
  days.forEach(function (d) {
    var rows = "";
    for (var p = 0; p < P; p++) {
      var anyClass = cfg.classes.some(function (c) { return p < classPeriods(cfg, c); });
      if (!anyClass) { rows += "<tr><th class='pp'>P" + cfg.periods[p] + "</th><td class='n no'></td><td class='no'></td></tr>"; continue; }
      var l = L.free[d][p];
      rows += "<tr><th class='pp'>P" + cfg.periods[p] + "</th><td class='n'><span class='cn' style='" + cntTone(l.length) + "'>" + l.length + "</span></td><td>" +
        (l.length ? l.map(function (t) { return "<span class='tc" + ((L.perDay[t][d] || 0) <= 2 ? " lo" : "") + "'>" + esc(t) + "</span>"; }).join("") : "<i style='color:#b3261e'>Nobody is free</i>") + "</td></tr>";
    }
    var offT = cfg.singles.filter(function (t) { return isOffDay(cfg, t, d); });
    pages += "<div class='page'>" + pdfLetterhead(cfg, "Free teachers for substitution", DAY_FULL[d], cfg.singles.length - offT.length + " teachers working") +
      "<table><thead><tr><th class='pp' style='background:#0e6b73;color:#fff;font-size:13px'>Period</th><th style='width:24mm'>Free</th><th>Teachers free in this period</th></tr></thead><tbody>" + rows + "</tbody></table>" +
      (offT.length ? "<div class='off'><b>Not working today:</b> " + offT.map(esc).join(", ") + "</div>" : "") + freeKey(true) +
      (o.sign !== false ? pdfFooter(esc(cfg.school || "") + " &middot; " + esc(DAY_FULL[d]), ["Headmaster"], cfg, "class") : "") + "</div>";
  });
  openPrint(esc(cfg.school) + " - Free teachers by day", css, pages);
}

/* 3. Teacher week grid: one row per teacher, every period of the week; busy cells show the class */
function exportFreeSlotsPDF(cfg, paper, o) {
  o = o || {};
  paper = paper || "A3";
  var L = leisureData(cfg), P = cfg.periods.length, D = cfg.days.length, N = cfg.singles.length, big = paper === "A3";
  var fs = big ? (N > 48 ? 8.5 : 9.5) : 7;
  var css = "@page{size:" + paper + " landscape;margin:8mm} *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box} html,body{margin:0} body{font-family:Arial,Helvetica,sans-serif;color:#16213a}" + lhCss() +
    " table{border-collapse:collapse;width:100%;table-layout:fixed;border:2px solid #0e6b73} th,td{border:1px solid #c9d8de;text-align:center;padding:1px 1px;font-size:" + fs + "px;height:" + (big ? 19 : 14) + "px;overflow:hidden;white-space:nowrap}" +
    " thead{display:table-header-group} tr{page-break-inside:avoid} thead th{background:#0e6b73;color:#fff;font-weight:800} thead tr.pr th{background:#e1f0f0;color:#0a4f55;font-size:" + (fs + 0.5) + "px}" +
    " .tn{width:" + (big ? 20 : 15) + "mm;text-align:left;padding-left:4px;font-weight:800;color:#0a4f55;font-family:'Courier New',monospace} tbody tr:nth-child(even) td.tn{background:#f2f8f8}" +
    " .ds{border-left:2.5px solid #0e6b73!important} td.f{background:#c9efd8;color:#0e7a45;font-weight:800} td.b{background:#fff;color:#7a8597;font-size:" + (fs - 1.2) + "px} td.cb{background:#fbf3e4;color:#94620b;font-size:" + (fs - 1.2) + "px} td.o{background:repeating-linear-gradient(135deg,#eef0f3 0 4px,#e2e5ea 4px 8px)}" +
    " td.t{width:" + (big ? 13 : 10) + "mm;font-weight:800;background:#e3f5ec;color:#126236} .lg{margin-top:6px;font-size:10px;color:#4b5870;display:flex;gap:12px;flex-wrap:wrap;align-items:center} .lg i{display:inline-block;width:18px;height:11px;border:1px solid #c9d8de;vertical-align:middle;margin-right:4px}";
  var h1 = "<tr><th class='tn' rowspan='2' style='color:#fff'>Teacher</th>";
  cfg.days.forEach(function (d) { h1 += "<th colspan='" + P + "' class='ds'>" + esc(DAY_FULL[d]) + "</th>"; });
  h1 += (o.showTot !== false ? "<th rowspan='2' class='t' style='background:#0e6b73;color:#fff'>Free</th>" : "") + "</tr>";
  var h2 = "<tr class='pr'>"; cfg.days.forEach(function () { for (var p = 0; p < P; p++) h2 += "<th" + (p === 0 ? " class='ds'" : "") + ">" + cfg.periods[p] + "</th>"; }); h2 += "</tr>";
  var rows = "";
  cfg.singles.forEach(function (t) {
    var r = "<tr><td class='tn'>" + esc(t) + "</td>";
    cfg.days.forEach(function (d) {
      for (var p = 0; p < P; p++) {
        var b = L.busy[t][d] ? L.busy[t][d][p] : null, ds = p === 0 ? " ds" : "";
        if (b === "off") r += "<td class='o" + ds + "'></td>";
        else if (!b) r += "<td class='f" + ds + "'>&#9679;</td>";
        else { var cc = String(b.c).split(", "); r += "<td class='" + (b.combined ? "cb" : "b") + ds + "' title='" + esc(b.c + " " + b.sub) + "'>" + esc(cc.length > 1 ? cc[0] + "+" : cc[0]) + "</td>"; }
      }
    });
    rows += r + (o.showTot !== false ? "<td class='t'>" + L.week[t] + "</td>" : "") + "</tr>";
  });
  var lg = "<div class='lg'><b>Key:</b><span><i style='background:#c9efd8'></i>free</span><span><i></i>teaching (class shown)</span><span><i style='background:#fbf3e4'></i>combined subject (first class shown, + = more)</span><span><i style='background:repeating-linear-gradient(135deg,#eef0f3 0 3px,#e2e5ea 3px 6px)'></i>not working that day</span></div>";
  openPrint(esc(cfg.school) + " - Teacher week grid (free periods)", css, pdfLetterhead(cfg, "Leisure / free periods", "Teacher week grid", N + " teachers &middot; green = free") +
    "<table><thead>" + h1 + h2 + "</thead><tbody>" + rows + "</tbody></table>" + lg);
}

function LeisureExport({ cfg, paper }) {
  const [cp, setCp] = useState("A3");
  const [week, setWeek] = useState(true);
  const [sign, setSign] = useState(true);
  const [day, setDay] = useState("");
  const [tot, setTot] = useState(true);
  const lab = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: C.ink, cursor: "pointer" };
  const row = { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", padding: "10px 0", borderTop: `1px dashed ${C.line}` };
  const ttl = { fontSize: 13, fontWeight: 800, color: C.ink, minWidth: 210 };
  const sub = { display: "block", fontSize: 11.5, fontWeight: 500, color: C.sub, marginTop: 2 };
  return (
    <div style={{ display: "grid", width: "100%" }}>
      <div style={{ ...row, borderTop: "none", paddingTop: 0 }}>
        <span style={ttl}>Substitution chart <span style={{ fontSize: 10.5, padding: "1px 7px", borderRadius: 10, background: C.freeSoft, color: C.free, marginLeft: 4 }}>recommended</span><span style={sub}>Days × periods — who is free in each period, on one page</span></span>
        <select className="tt-sel" style={{ width: 80 }} value={cp} onChange={(e) => setCp(e.target.value)}><option>A3</option><option>A4</option></select>
        <label style={lab}><input type="checkbox" checked={week} onChange={(e) => setWeek(e.target.checked)} /> Weekly totals</label>
        <label style={lab}><input type="checkbox" checked={sign} onChange={(e) => setSign(e.target.checked)} /> HM signature</label>
        <span style={{ marginLeft: "auto" }}><PrintBtn onClick={() => exportSubChartPDF(cfg, { paper: cp, showWeek: week, sign })} icon="pdf" label="Substitution chart" sub={`${cp} landscape`} /></span>
      </div>
      <div style={row}>
        <span style={ttl}>Day sheets<span style={sub}>One page per day, periods down the side — print today's</span></span>
        <select className="tt-sel" style={{ width: 140 }} value={day} onChange={(e) => setDay(e.target.value)}><option value="">All days</option>{cfg.days.map((d) => <option key={d} value={d}>{DAY_FULL[d]}</option>)}</select>
        <span style={{ marginLeft: "auto" }}><PrintBtn onClick={() => exportFreeDailyPDF(cfg, { paper: paper || "A4", day: day || null, sign })} icon="pdf" light label="Day sheets" sub={`${paper || "A4"} portrait · ${day ? DAY_FULL[day] : "all days"}`} /></span>
      </div>
      <div style={row}>
        <span style={ttl}>Teacher week grid<span style={sub}>One row per teacher — green = free, class shown when busy</span></span>
        <label style={lab}><input type="checkbox" checked={tot} onChange={(e) => setTot(e.target.checked)} /> Total free column</label>
        <span style={{ marginLeft: "auto" }}><PrintBtn onClick={() => exportFreeSlotsPDF(cfg, "A3", { showTot: tot })} icon="pdf" light label="Teacher week grid" sub="A3 landscape" /></span>
      </div>
      <div style={row}>
        <span style={ttl}>Counts per day<span style={sub}>Number of free periods for each teacher, each day</span></span>
        <span style={{ marginLeft: "auto" }}><PrintBtn onClick={() => exportFreeReportPDF(cfg, paper)} icon="pdf" light label="Free-period counts" sub={`${paper} portrait`} /></span>
      </div>
    </div>
  );
}

function sheetLayout(paper, orient, per, D, P) {
  const dims = { A4: [210, 297], A3: [297, 420], Letter: [216, 279], Legal: [216, 356] }[paper] || [297, 420];
  const W = (orient === "portrait" ? dims[0] : dims[1]) - 16, H = (orient === "portrait" ? dims[1] : dims[0]) - 26;
  let best = null;
  for (let cols = 1; cols <= Math.max(1, per); cols++) {
    const rows = Math.ceil(per / cols);
    const cw = (W - (cols - 1) * 3) / cols, rh = (H - (rows - 1) * 3) / rows;
    // width: a period column holds ~5 characters; height: header + day rows of a mini (sizes in mm, font in px)
    const fw = (cw - 0.53 * P) / (0.73 * P + 0.42);
    const fh = (rh - (D + 1) * 0.79 - 1.06) / ((D + 1) * 0.304 + 0.38);
    const f = Math.min(fw, fh);
    if (!best || f > best.f + 0.05) best = { cols, rows, f };
  }
  const font = Math.max(4.5, Math.min(13, best.f));
  return { cols: best.cols, font, w: W, page: paper + " " + orient };
}

function miniGridPages(cfg, items, o, title, cellFor) {
  const per = Math.max(1, Math.min(items.length || 1, +o.per || 1));
  const L = sheetLayout(o.paper || "A3", o.orient || "landscape", per, cfg.days.length, cfg.periods.length);
  var css = "@page{size:" + L.page + ";margin:8mm} *{-webkit-print-color-adjust:exact;print-color-adjust:exact} html,body{margin:0} body{font-family:Arial,Helvetica,sans-serif;color:#111} .sheet{page-break-after:always;break-after:page} .sheet:last-child{page-break-after:auto;break-after:auto} h2{font-size:" + Math.max(11, L.font * 1.6).toFixed(1) + "px;text-align:center;margin:0 0 6px;color:#0a4f55} .grid{display:grid;grid-template-columns:repeat(" + L.cols + ",minmax(0,1fr));gap:3mm;align-items:start} .mini{border:1px solid #0e6b73;break-inside:avoid;page-break-inside:avoid} .mh{background:#0e6b73;color:#fff;font-weight:800;font-size:" + (L.font * 1.25).toFixed(1) + "px;text-align:center;padding:2px} table{border-collapse:collapse;width:100%;table-layout:fixed} td,th{border:1px solid #b9c9c9;font-size:" + L.font.toFixed(1) + "px;text-align:center;padding:1px;line-height:1.15;word-break:break-word;overflow-wrap:anywhere;vertical-align:middle} th{background:#e1f0f0;font-weight:700} tr>th:first-child{width:" + (L.font * 1.6).toFixed(1) + "px}";
  var head = "<tr><th></th>"; for (var p = 0; p < cfg.periods.length; p++) head += "<th>" + cfg.periods[p] + "</th>"; head += "</tr>";
  var sheets = "";
  for (var start = 0; start < items.length; start += per) {
    var minis = "";
    for (var k = start; k < Math.min(start + per, items.length); k++) {
      var it = items[k], body = "";
      for (var di = 0; di < cfg.days.length; di++) {
        var d = cfg.days[di]; body += "<tr><th>" + esc(DAY_FULL[d].slice(0, 2)) + "</th>";
        for (var pp = 0; pp < cfg.periods.length; pp++) body += cellFor(it, d, pp);
        body += "</tr>";
      }
      minis += "<div class=mini><div class=mh>" + esc(it) + "</div><table><thead>" + head + "</thead><tbody>" + body + "</tbody></table></div>";
    }
    sheets += "<div class=sheet><h2>" + esc(cfg.school) + " - " + title + (items.length > per ? " (" + (start / per + 1) + "/" + Math.ceil(items.length / per) + ")" : "") + "</h2><div class=grid>" + minis + "</div></div>";
  }
  return { css: css, body: sheets };
}

function exportClassesOverviewPDF(cfg, o) {
  o = o || { per: 40, paper: "A3", orient: "landscape" };
  var out = miniGridPages(cfg, cfg.classes, o, "All class timetables", function (c, d, pp) {
    var s = (cfg.grid[c] && cfg.grid[c][d] && cfg.grid[c][d][pp]) || [null, null];
    if (pp >= classPeriods(cfg, c)) return '<td style="background:#e4e6ea"></td>';
    return s[1] ? ('<td style="background:' + subTint(s[1]) + ';color:' + subCol(s[1]) + ';font-weight:700">' + esc(s[1]) + '</td>') : "<td></td>";
  });
  openPrint(esc(cfg.school) + " - All classes", out.css, out.body);
}

function exportTeachersOverviewPDF(cfg, o) {
  o = o || { per: 24, paper: "A3", orient: "landscape" };
  var out = miniGridPages(cfg, cfg.singles, o, "All teacher timetables", function (t, d, pp) {
    var r = teacherAt(cfg, t, d, pp);
    return r ? ('<td style="background:' + subTint(r.sub) + ';color:' + subCol(r.sub) + ';font-weight:700">' + esc(r.c) + '</td>') : "<td></td>";
  });
  openPrint(esc(cfg.school) + " - All teachers", out.css, out.body);
}

function freeOf(cfg, t, d) {
  if (isOffDay(cfg, t, d)) return null;
  var out = [];
  for (var p = 0; p < cfg.periods.length; p++) if (!teacherAt(cfg, t, d, p)) out.push(p + 1);
  return out;
}
function exportFreeReportPDF(cfg, paper, o) {
  o = o || {};
  var showP = o.showP !== false, orient = o.orient || "portrait", showTot = o.showTot !== false, showSum = o.showSum !== false;
  var nT = cfg.singles.length, big = (paper === "A3") || orient === "landscape";
  var fs = nT > 50 ? 10 : nT > 36 ? 11 : 12.5; if (big) fs += 1;
  var css = "@page{size:" + (paper || "A4") + " " + orient + ";margin:1cm} *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box} html,body{margin:0} body{font-family:Arial,Helvetica,sans-serif;color:#16213a}" +
    " .hd{display:flex;align-items:center;gap:14px;background:linear-gradient(115deg,#0a4f55,#0e6b73);color:#fff;padding:10px 16px;border-radius:10px;margin-bottom:10px}" +
    " .hd img{height:54px;width:54px;object-fit:contain;background:#fff;border-radius:10px;padding:3px} .hd .s{font-size:12px;opacity:.85;font-weight:700;letter-spacing:.5px;text-transform:uppercase} .hd .t{font-size:19px;font-weight:800} .hd .d{margin-left:auto;font-size:11px;text-align:right;opacity:.9}" +
    " table{border-collapse:collapse;width:100%;border:2px solid #0e6b73} th,td{border:1px solid #b9d3d3;padding:3px 5px;font-size:" + fs + "px;text-align:center;vertical-align:middle}" +
    " thead th{background:#0e6b73;color:#fff;font-weight:800;padding:6px 4px} tbody tr:nth-child(even) td.n{background:#eef6f6} td.n{text-align:left;font-weight:800;color:#0a4f55;background:#fff;white-space:nowrap}" +
    " .c{display:inline-block;min-width:22px;padding:1px 6px;border-radius:10px;font-weight:800} .p{display:block;font-size:" + (fs - 2.5) + "px;color:#3c4a60;font-weight:700;margin-top:1px;letter-spacing:.2px}" +
    " td.off{background:#eceff3!important;color:#8a93a3;font-weight:700;font-size:" + (fs - 2) + "px} td.tot{background:#e3f5ec;color:#1f7a47;font-weight:800} tr.sum td{background:#fbeeda!important;font-weight:800;color:#7a4a10;border-top:2px solid #0e6b73}" +
    " .lg{margin-top:8px;font-size:10.5px;color:#4b5870;display:flex;gap:12px;flex-wrap:wrap;align-items:center} .lg span.c{font-size:10px} thead{display:table-header-group} tr{page-break-inside:avoid}";
  var tone = function (n) { return n === 0 ? "background:#fbe0dd;color:#b3261e" : n === 1 ? "background:#fbefd5;color:#94620b" : n <= 3 ? "background:#e3f5ec;color:#1f7a47" : "background:#c9ecd8;color:#126236"; };
  var head = "<tr><th style='text-align:left'>Teacher</th>";
  for (var di = 0; di < cfg.days.length; di++) head += "<th>" + esc(DAY_FULL[cfg.days[di]]) + "</th>";
  head += (showTot ? "<th>Total free</th>" : "") + "</tr>";
  var rows = "", dayTot = cfg.days.map(function () { return 0; }), grand = 0;
  for (var ti = 0; ti < cfg.singles.length; ti++) {
    var t = cfg.singles[ti], total = 0, cells = "";
    for (var di2 = 0; di2 < cfg.days.length; di2++) {
      var fr = freeOf(cfg, t, cfg.days[di2]);
      if (fr === null) { cells += "<td class='off'>OFF</td>"; continue; }
      total += fr.length; dayTot[di2] += fr.length;
      cells += "<td><span class='c' style='" + tone(fr.length) + "'>" + fr.length + "</span>" + (showP ? "<span class='p'>" + (fr.length ? "P" + fr.join(" P") : "&mdash;") + "</span>" : "") + "</td>";
    }
    grand += total;
    rows += "<tr><td class='n'>" + esc(t) + "</td>" + cells + (showTot ? "<td class='tot'>" + total + "</td>" : "") + "</tr>";
  }
  var foot = "<tr class='sum'><td style='text-align:left'>All teachers</td>" + dayTot.map(function (x) { return "<td>" + x + "</td>"; }).join("") + (showTot ? "<td>" + grand + "</td>" : "") + "</tr>";
  if (!showSum) foot = "";
  var logo = cfg.logo ? "<img src='" + cfg.logo + "' alt=''>" : "";
  var now = new Date(), stamp = now.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  var hdr = "<div class='hd'>" + logo + "<div><div class='s'>" + esc(cfg.school || "") + "</div><div class='t'>Teacher free-period report &mdash; free periods per day</div></div><div class='d'>" + nT + " teachers &middot; " + cfg.days.length + " days &middot; " + cfg.periods.length + " periods<br>" + esc(stamp) + "</div></div>";
  var legend = "<div class='lg'><b>Key:</b><span><span class='c' style='" + tone(0) + "'>0</span> no free period</span><span><span class='c' style='" + tone(1) + "'>1</span> one free</span><span><span class='c' style='" + tone(2) + "'>2</span> two or three</span><span><span class='c' style='" + tone(4) + "'>4</span> four or more</span>" + (showP ? "<span>P2 P5 = the free period numbers</span>" : "") + "<span>OFF = not working that day</span><span>Combined subjects are counted.</span></div>";
  openPrint(esc(cfg.school) + " - Teacher free-period report", css, hdr + "<table><thead>" + head + "</thead><tbody>" + rows + foot + "</tbody></table>" + legend);
}
