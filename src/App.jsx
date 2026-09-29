import React, { useState, useEffect, useMemo, useRef } from "react";
import { SEED } from "./seed";
import { loadConfig, saveConfig, subscribeConfig } from "./storage";
import { supabase } from "./supabaseClient";

/* ============================================================
   AMUPS Pallikkal — Timetable Manager  (v2)
   The mapping is the source of truth: it sets which teacher takes
   which subject in each class, and how many periods per week.
   The master grid can only place what the mapping allows, and every
   teacher's load is tracked against their mapping target.
   ============================================================ */

const STORE_KEY = "tt_cfg_v2";
const APP_VERSION = "2026-09-29 b";

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
  ["bkey", "Mapping"], ["edit", "Assign timetable"], ["rules", "Scheduling rules"],
  ["combined", "Combined subjects"], ["analysis", "Analysis & checks"], ["export", "Export / PDF"], ["assistant", "AI assistant"], ["setup", "Classes & setup"],
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
function teacherWorkDays(cfg, t) { const a = (cfg.teacherDays || {})[t]; return a && a.length ? cfg.days.filter((d) => a.includes(d)) : cfg.days; }
function teacherCap(cfg, t) { return teacherWorkDays(cfg, t).length * cfg.periods.length; }

function autoSchedule(cfg, mode = "all", onlyClass = null, opts = {}) {
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

  const gen = (seed) => {
    const r = makeRng(seed);
    const issues = [];
    const grid = {}; cfg.classes.forEach((c) => (grid[c] = Array.from({ length: D }, () => Array.from({ length: P }, () => [null, null]))));
    const tbusy = Array.from({ length: D }, () => Array.from({ length: P }, () => new Set()));
    const subDay = {}, subPer = {};
    const fixed = new Set();           // cells placed by a rule or kept from before - never moved by repair
    const key = (c, d, p) => c + "|" + d + "|" + p;
    const extraUsed = {};
    const mark = (c, sub, d, p, k) => { const kd = `${c}|${sub}|${d}`, before = subDay[kd] || 0; if (k > 0 && before >= 1) extraUsed[c + "|" + sub] = (extraUsed[c + "|" + sub] || 0) + 1; if (k < 0 && before >= 2) extraUsed[c + "|" + sub] = (extraUsed[c + "|" + sub] || 0) - 1; subDay[kd] = before + k; subPer[`${c}|${sub}|${p}`] = (subPer[`${c}|${sub}|${p}`] || 0) + k; };
    const tcls = Array.from({ length: D }, () => Array.from({ length: P }, () => new Map()));
    const put = (c, d, p, code, sub) => { grid[c][d][p] = [code, sub]; const comb = isC(code); tOf(code).forEach((t) => { tbusy[d][p].add(t); if (!comb) tcls[d][p].set(t, c); }); mark(c, sub, d, p, 1); };

    // 1. keep what must stay: locked cells always; in fill modes, everything already placed
    const frozen = new Set();
    for (const k in (cfg.locked || {})) {
      if (!cfg.locked[k]) continue;
      const parts = k.split("|"); const c = parts[0], di = DAYS.indexOf(parts[1]), p = +parts[2];
      if (di < 0 || !grid[c] || p >= P) continue;
      frozen.add(key(c, di, p));
    }
    for (const c of cfg.classes) for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) {
      const slot = cfg.grid[c]?.[DAYS[d]]?.[p]; if (!slot || !slot[0]) continue;
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
          if (grid[c][d][p][0] === row.teacher && grid[c][d][p][1] === row.sub && !frozen.has(k)) { const [code, sub] = grid[c][d][p]; tOf(code).forEach((t) => { tbusy[d][p].delete(t); if (tcls[d][p].get(t) === c) tcls[d][p].delete(t); }); mark(c, sub, d, p, -1); grid[c][d][p] = [null, null]; fixed.delete(k); extra--; }
        }
      }
    }
    const tOK = (toks, d, p) => toks.every((t) => !tbusy[d][p].has(t) && availT(t, d));
    const book = (c, d, p, code, sub, isFixed) => { put(c, d, p, code, sub); if (isFixed) fixed.add(key(c, d, p)); };
    const unbook = (c, d, p) => { const [code, sub] = grid[c][d][p]; if (!code) return; tOf(code).forEach((t) => { tbusy[d][p].delete(t); if (tcls[d][p].get(t) === c) tcls[d][p].delete(t); }); mark(c, sub, d, p, -1); grid[c][d][p] = [null, null]; };
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
          if (t && !tOK(tOf(t), d, p)) { issues.push(`Common ${cp.sub}: ${t} (${c}) is busy or off on ${dayCode} P${pn}`); continue; }
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
      const teach = [...new Set(sessions.flatMap((sx) => sx.teachers.filter((t) => singles.has(t))))];
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
      const toks = tOf(l.teacher); const band = R(l.sub).band;
      const cand = shuf(slots(), r).filter(([d, p]) => allowed(l.sub, p));
      if (band === "early") cand.sort((a, b) => a[1] - b[1]); else if (band === "late") cand.sort((a, b) => b[1] - a[1]);
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
        const toks = tOf(l.teacher); let fixedIt = false;
        const cand = shuf(slots(), r).filter(([d, p]) => allowed(l.sub, p) && tOK(toks, d, p) && dayOK(l.c, l.sub, d) && !av(l.c, l.sub, l.teacher, p));
        cand.sort((a, b) => a[1] - b[1]);
        for (const [d, p] of cand) {
          if (free(l.c, d, p)) { book(l.c, d, p, l.teacher, l.sub, false); fixedIt = true; break; }
          if (!writable.has(l.c) || frozen.has(key(l.c, d, p)) || fixed.has(key(l.c, d, p))) continue;
          const [oc, os] = grid[l.c][d][p]; if (!oc || isC(oc)) continue;
          const otoks = tOf(oc);
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
      const toks = tOf(l.teacher);
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
    const notesOut = Object.values(autoNotes).map((x) => `${x.sub} in Std ${x.st} needs ${x.per} periods but has ${x.days} day(s) — placed twice on a day where needed (${x.classes.length} class${x.classes.length > 1 ? "es" : ""})`);

    const missing = {};
    const why = (l) => {
      const toks = tOf(l.teacher); let tFree = 0, both = 0;
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
    const res = gen(s * 7 + 1);
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
      if (!next.combinedV3) { (next.combined || []).forEach((x) => { if (!x.group || x.group === x.sub) x.group = stdBlockName(x); }); next.combinedV2 = true; next.combinedV3 = true; }
      if (!alive) return;
      if (Array.isArray(next.classes)) next.classes.sort(cmpClass);
      setCfg(next);
      lastSaved.current = JSON.stringify(next);
      if (wasEmpty) { try { await saveConfig(next); } catch {} }
    })();
    const ch = subscribeConfig((remote) => { if (!remote) return; const js = JSON.stringify(remote); if (js === lastSaved.current) return; lastSaved.current = js; if (Array.isArray(remote.classes)) remote.classes.sort(cmpClass); setCfg(remote); setSaved("synced"); });
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
  const update = (fn) => setCfg((prev) => { const next = clone(prev); fn(next); if (Array.isArray(next.classes)) next.classes.sort(cmpClass); persist(next); return next; });

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
          <div style={{ fontSize: 16.5, fontWeight: 800, letterSpacing: -0.3 }}>TIME TABLE</div>
          {!mobile && <div style={{ fontSize: 12, color: "rgba(255,255,255,.8)", marginTop: 1, fontWeight: 500 }}>{cfg.school} · {cfg.classes.length} classes · {cfg.singles.length} teachers · {cfg.days.length} days</div>}
        </div>
        <ClashBadge n={totalClashes} onClick={() => setShowClashes(true)} />
        <span style={{ fontSize: 12, color: "rgba(255,255,255,.85)", minWidth: 56, textAlign: "right", fontWeight: 500 }}>{saved}</span>
        <button className="tt-btn" onClick={() => ask("Reset — clear ALL class timetables to blank? Your mapping, classes, teachers and rules are kept.", () => update((n) => { for (const c of n.classes) for (const d of n.days) n.grid[c][d] = emptyDay(n.periods.length); n.locked = {}; }))} style={headerBtn}>Reset</button>
        <button className="tt-btn" onClick={() => ask("MASTER RESET  -  permanently delete EVERYTHING (all classes, teachers, subjects, mapping, combined subjects, rules, standard periods, and the whole timetable) and start from a blank app? This cannot be undone.", () => update((n) => { n.classes = []; n.singles = []; n.subjects = []; n.combined = []; n.bkey = {}; n.classTeacher = {}; n.grid = {}; n.stdPeriods = {}; n.rules = {}; n.twice = {}; n.classRules = {}; n.locked = {}; n.commonPeriods = []; n.teacherDays = {}; }))} style={{ ...headerBtn, border: "1px solid rgba(255,255,255,.5)", background: "rgba(214,69,69,.35)" }}>Master reset</button>
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
          {mobile && cfg.classes.length > 0 && (view === "classes" || view === "edit" || view === "bkey") && <MobilePicker label="Class" items={cfg.classes} value={safeCls} onChange={setCls} />}
          {mobile && cfg.singles.length > 0 && view === "teachers" && <MobilePicker label="Teacher" items={cfg.singles} value={safeTch} onChange={setTch} />}
          {view === "classes" && (cfg.classes.length ? <ClassView {...ctx} cls={safeCls} /> : <EmptyState msg="No classes yet. Add classes in Classes & setup, then set up your Mapping." onGo={() => setView("setup")} />)}
          {view === "teachers" && (cfg.singles.length ? <TeacherView {...ctx} tch={safeTch} /> : <EmptyState msg="No teachers yet. Add teachers in Classes & setup (or import them with a mapping CSV)." onGo={() => setView("setup")} />)}
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
      {showClashes && <ClashListModal list={clashList} onFix={doFixAll} fixMsg={fixMsg} onClose={() => { setShowClashes(false); setFixMsg(""); }} onOpen={(x) => { setShowClashes(false); if (x.kind === "blocks") setView("combined"); else { if (x.cls) setCls(x.cls); setView("edit"); } }} />}
      {confirmState && <ConfirmModal msg={confirmState.msg} onYes={() => { confirmState.onYes(); setConfirmState(null); }} onNo={() => setConfirmState(null)} />}
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
    const bases = [...e.comb]; const base = bases[0];
    const divs = [...new Set(bases.flatMap((b) => [...(occupancy[d][pi].sessions.get(b) || [])]))].sort(cmpClass);
    const sess = combinedByBase[base];
    return { cn: divs.join(" "), subj: sess?.sub, code: bases.length > 1 ? combGroupOf(sess) + " (combined)" : base, combined: true };
  };
  let placed = 0; cfg.days.forEach((d) => cfg.periods.forEach((p, pi) => { if (lookup(d, pi)) placed++; }));
  const freeCount = teacherCap(cfg, tch) - placed;
  return (
    <div>
      <ViewHeader title={`Teacher ${tch}`} note={`${placed} periods placed · ${freeCount} free · mapping target ${ld.target}`} right={<button className="tt-btn" onClick={printNow} style={ghostBtn}>Print / PDF</button>} />
      <div className="tt-printarea" style={card}>
        <div className="tt-printtitle" style={{ display: "none", fontWeight: 700, fontSize: 15, padding: "10px 12px" }}>{cfg.school} · Teacher {tch}</div>
        <GridTable cfg={cfg} render={(d, pi) => {
          const r = lookup(d, pi);
          if (!r) return { free: true, bg: C.freeSoft };
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

function NavDrawer({ open, onClose, view, setView, TH, school, theme, setTheme, onSignOut }) {
  if (!open) return null;
  return (
    <div onClick={onClose} className="tt-noprint" style={{ position: "fixed", inset: 0, background: "rgba(16,25,40,.45)", zIndex: 90 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: 280, maxWidth: "84%", background: "#fff", boxShadow: "2px 0 24px rgba(0,0,0,.25)", display: "flex", flexDirection: "column", animation: "ttslide .2s ease" }}>
        <div style={{ background: `linear-gradient(115deg, ${TH.g2}, ${TH.g1})`, color: "#fff", padding: "18px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15 }}>TIME TABLE</div>
            <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.8)" }}>{school}</div>
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

function BKeyView({ cfg, cls, setCls, update, expand, teacherLoad, mobile, ask }) {
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
  const weekSlots = cfg.days.length * cfg.periods.length;
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
  const clearAllMapping = () => ask("Clear the mapping (subjects + teachers) AND combined subjects for EVERY class? Standard periods, classes and the teacher list are kept.", () => update((n) => { for (const c of n.classes) n.bkey[c] = []; n.combined = []; }));
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
        <button className="tt-btn" onClick={saveMapping} style={solidBtn}>Save mapping</button>
        <button className="tt-btn" onClick={autofillAll} style={ghostBtn}>Auto-fill subjects · all classes</button>
        <button className="tt-btn" onClick={clearAllMapping} style={{ ...ghostBtn, color: C.clash }}>Clear all mapping</button>
        <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={(e) => onImport(e.target.files && e.target.files[0])} style={{ display: "none" }} />
        <button className="tt-btn" onClick={() => fileRef.current && fileRef.current.click()} style={ghostBtn}>Import CSV / Excel</button>
      </>} />
      {imp && <Banner tone="primary">{imp}</Banner>}
      {saveMsg && <SaveReport r={saveMsg} onClose={() => setSaveMsg(null)} />}
      <div style={{ marginBottom: 16 }}>
        <Seg label="Section" options={[["std", "1 · Standard periods"], ["class", "2 · Class mapping"], ["load", "3 · Teacher load"]]} val={section} onChange={setSection} />
      </div>

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
          <div style={{ fontSize: 12, color: C.sub, marginTop: 8, lineHeight: 1.6 }}>Set one class fully (subjects + teachers), then copy it to the classes that share the same setup and tweak only what differs. Copying replaces the target classes' mapping.</div>
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
      <div style={{ padding: "0 14px 12px", fontSize: 12, color: C.sub, lineHeight: 1.6 }}>Standards don't have to match  -  give each its own subjects and periods. Remove a subject with ×, add one from the dropdown. "Auto-fill subjects" uses each standard's own list. New standards appear here automatically when you add their classes in Setup.</div>
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
        <div style={{ padding: "8px 14px", fontSize: 12, color: C.sub, lineHeight: 1.6 }}>Mapped = weekly periods this teacher is given in the mapping (combined subjects counted once). Free = periods left in that teacher’s week (their working days × periods) after that. Placed = periods actually in the generated timetable. Tap a teacher to see their classes.</div>
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
function EditView({ cfg, cls, update, expand, clashTokens, occupancy, ask }) {
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
  const describeRun = (res, okText) => {
    const parts = [];
    if (res.unplaced === 0) parts.push(okText);
    else parts.push(`${res.unplaced} period(s) could not be placed without breaking a rule: ${res.missing.slice(0, 10).join(", ")}${res.missing.length > 10 ? ` … +${res.missing.length - 10} more` : ""}.`);
    if (res.issues && res.issues.length) parts.push(`Rule notes: ${res.issues.slice(0, 6).join("; ")}${res.issues.length > 6 ? ` … +${res.issues.length - 6} more` : ""}.`);
    return parts.join(" ");
  };
  const genAll = () => ask("Auto-generate a fresh, clash-free timetable for the whole school from the mapping? This replaces every current assignment.", () => {
    setReport("Generating… this can take a few seconds.");
    setTimeout(() => {
      try {
        const res = autoSchedule(cfg, "all");
        update((n) => { n.grid = res.grid; });
        setReport(describeRun(res, "Generated a complete clash-free timetable for all classes, following every rule."));
      } catch (e) { setReport("Couldn't generate: " + ((e && e.message) || e) + ". A rule/language-session may reference a class or teacher that no longer exists — check Classes & setup, or try 'Fill remaining'."); }
    }, 60);
  });
  const genFillAll = () => {
    setReport("Filling remaining slots…");
    setTimeout(() => {
      try {
        const res = autoSchedule(cfg, "gaps");
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
  const clearAllTT = () => ask("Clear EVERY class's timetable and start completely blank? All locks are also removed.", () => { update((n) => { for (const c of n.classes) for (const d of n.days) n.grid[c][d] = emptyDay(n.periods.length); n.locked = {}; }); setReport("All timetables cleared — everything is blank."); });
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
      </>} />
      {report && <Banner tone="primary">{report}</Banner>}
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
      <CTDaysPanel cfg={cfg} update={update} />
      <CommonPeriodsPanel cfg={cfg} update={update} />
      <ClassRulesPanel cfg={cfg} update={update} />
      <TwicePanel cfg={cfg} update={update} />
      <p style={{ fontSize: 12.5, color: C.sub, marginTop: 12, lineHeight: 1.6 }}>
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
      <div style={{ padding: "9px 14px", fontSize: 12, color: C.sub, lineHeight: 1.6 }}>
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
      <div style={{ padding: "8px 14px", fontSize: 12, color: C.sub, lineHeight: 1.6 }}>On the other days, the class teacher is kept out of P1 in that class, so P1 is free for IT, PET, LB and others. The generator picks which days; to fix exact days for a class, use Class-specific period rules below.</div>
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
      <div style={{ padding: "0 14px 14px", fontSize: 12, color: C.sub, lineHeight: 1.6 }}>
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
        <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.6 }}>
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
      <p style={{ fontSize: 12, color: C.sub, marginTop: 10 }}>The assistant can read the whole timetable and make edits on request. Review changes in the Class or Assign views — use Reset if an edit isn't what you wanted.</p>
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
    const locked = gDivs.filter((c) => cfg.locked?.[`${c}|${d}|${pi}`]);
    const r = cfg.rules?.[s?.sub] || {};
    const ruleNo = (r.pin && r.pin !== pi + 1) || (r.forbid && r.forbid.includes(pi + 1));
    return { off, clash, busy, inOther, locked, ruleNo, clean: !off.length && !clash.length && !busy.length && !inOther.length && !locked.length && !ruleNo };
  };
  let gPlaced = 0; const gDaysUsed = new Set();
  cfg.days.forEach((d) => cfg.periods.forEach((_, pi) => { if (runningAt(d, pi)) { gPlaced++; gDaysUsed.add(d); } }));
  const placeAt = (list) => update((n) => {
    for (const [d, pi] of list) for (const x of gSes) {
      const ses = n.combined.find((y) => y.name === x.name); if (!ses) continue;
      for (const c of ses.divisions) { if (!n.grid[c] || n.locked?.[`${c}|${d}|${pi}`]) continue; const cur = n.grid[c][d][pi][0]; if (cur && cur !== ses.name && n.combined.some((y) => y.name === cur)) continue; n.grid[c][d][pi] = [ses.name, ses.sub]; }
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
        <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.6, margin: "-4px 0 14px", padding: "8px 12px", background: "#f6f8fa", borderRadius: 9 }}>
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

/* ---------------- Export / PDF ---------------- */
function ExportView({ cfg }) {
  const [paper, setPaper] = useState("A4");
  const Card = ({ title, desc, actions }) => (
    <div style={{ ...card, padding: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 14, lineHeight: 1.6 }}>{desc}</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{actions}</div>
    </div>
  );
  return (
    <div>
      <ViewHeader title="Export / PDF" note="Save timetables and reports as PDF. Pick a paper size (default A4), then export." right={
        <label style={{ fontSize: 12.5, color: C.sub, display: "inline-flex", alignItems: "center", gap: 6 }}>Paper
          <select className="tt-sel" style={{ width: 110 }} value={paper} onChange={(e) => setPaper(e.target.value)}>
            <option>A4</option><option>A3</option><option>Letter</option><option>Legal</option>
          </select>
        </label>
      } />
      <div style={{ display: "grid", gap: 16 }}>
        <Card title="Class timetables" desc="One page per class (landscape) - periods across the top, weekdays down the side, subject + teacher in each cell."
          actions={<button className="tt-btn" onClick={() => exportClassesPDF(cfg, paper)} style={solidBtn}>Export all class timetables ({paper})</button>} />
        <Card title="Teacher timetables" desc="One page per teacher (landscape) - the class and subject they take each period."
          actions={<button className="tt-btn" onClick={() => exportTeachersPDF(cfg, paper)} style={solidBtn}>Export all teacher timetables ({paper})</button>} />
        <Card title="Compact overview sheets (A3, landscape, fit-to-page)" desc="All class timetables packed about 40 per A3 page, and all teacher timetables about 24 per A3 page."
          actions={<>
            <button className="tt-btn" onClick={() => exportClassesOverviewPDF(cfg)} style={solidBtn}>All classes (A3, ~40/sheet)</button>
            <button className="tt-btn" onClick={() => exportTeachersOverviewPDF(cfg)} style={solidBtn}>All teachers (A3, ~24/sheet)</button>
          </>} />
        <Card title="Data backup" desc="Download all your setup and timetable (classes, teachers, mapping, rules, combined subjects, timetable) as one file. Keep it as a backup, or share it when asking for help."
          actions={<button className="tt-btn" onClick={() => exportJSON(cfg)} style={ghostBtn}>Download data backup (.json)</button>} />
        <Card title="Leisure / free periods" desc="Either a grid marking exactly which periods each teacher is free (green dot) — all teachers on one A3 page — or a simple count per day."
          actions={<>
            <button className="tt-btn" onClick={() => exportFreeSlotsPDF(cfg, paper)} style={solidBtn}>Free periods by period (A3 PDF)</button>
            <button className="tt-btn" onClick={() => exportFreeReportPDF(cfg, paper)} style={ghostBtn}>Free-period counts per day ({paper})</button>
          </>} />
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
      <div style={{ padding: "8px 14px", fontSize: 12.5, color: C.sub }}>{t}: {rows.length} class assignment(s), {tot} periods/week.</div>
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
              const freeDay = cfg.days.map((d) => { if (isOffDay(cfg, t, d)) return null; let f = 0; for (let p = 0; p < cfg.periods.length; p++) if (!teacherAt(cfg, t, d, p)) f++; return f; });
              const totalFree = freeDay.reduce((a, f) => a + (f || 0), 0);
              return (
                <tr key={t}>
                  <td style={{ ...cellTd, height: 32, textAlign: "left", paddingLeft: 12, fontFamily: mono, fontWeight: 700 }}>{t}</td>
                  {freeDay.map((f, i) => <td key={i} style={{ ...cellTd, height: 32, fontFamily: mono, color: f === null ? C.sub : f === 0 ? C.clash : C.ink, background: f === null ? "#f4f5f7" : undefined }}>{f === null ? "off" : f}</td>)}
                  <td style={{ ...cellTd, height: 32, fontFamily: mono, fontWeight: 700, color: C.free }}>{totalFree}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: "8px 14px", fontSize: 12, color: C.sub }}>Numbers are free (leisure) periods that day, counting combined subjects too. "off" = the teacher doesn't work that day. Use Print / PDF above to export this report.</div>
    </div>
  );
}

/* ---------------- Classes & setup ---------------- */
function TeacherAvailability({ cfg, update }) {
  const [q, setQ] = useState("");
  const TD = cfg.teacherDays || {};
  const list = cfg.singles.filter((t) => !q.trim() || t.toLowerCase().includes(q.trim().toLowerCase()));
  const isOn = (t, d) => { const a = TD[t]; return !a || !a.length || a.includes(d); };
  const toggle = (t, d) => update((n) => {
    n.teacherDays = n.teacherDays || {};
    let a = n.teacherDays[t] && n.teacherDays[t].length ? [...n.teacherDays[t]] : [...n.days];
    a = a.includes(d) ? a.filter((x) => x !== d) : [...a, d];
    a = n.days.filter((x) => a.includes(x));
    if (a.length === n.days.length || a.length === 0) delete n.teacherDays[t]; else n.teacherDays[t] = a;
  });
  const limited = cfg.singles.filter((t) => TD[t] && TD[t].length && TD[t].length < cfg.days.length);
  return (
    <div style={{ ...card, marginBottom: 16 }}>
      <Panelhead text="Teacher availability (working days)" count={limited.length ? `${limited.length} limited` : undefined} />
      <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.line}`, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input className="tt-in" style={{ width: 200 }} placeholder="Search teacher…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span style={{ fontSize: 12, color: C.sub }}>Tap a day to switch it off for that teacher. The generator never gives them periods on an off day.</span>
      </div>
      <div className="tt-scroll" style={{ maxHeight: 360, overflow: "auto" }}>
        <table style={{ ...tbl, minWidth: 380 }}>
          <thead><tr><th style={{ ...th, textAlign: "left", paddingLeft: 12 }}>Teacher</th>{cfg.days.map((d) => <th key={d} style={{ ...th, width: 58 }}>{DAY_FULL[d] ? DAY_FULL[d].slice(0, 3) : d}</th>)}<th style={{ ...th, width: 80 }}>Max/week</th></tr></thead>
          <tbody>{list.map((t) => (
            <tr key={t}>
              <td style={{ ...cellTd, textAlign: "left", paddingLeft: 12, fontFamily: mono, fontWeight: 800, height: 36 }}>{t}</td>
              {cfg.days.map((d) => { const on = isOn(t, d); return (
                <td key={d} style={{ ...cellTd, height: 36 }}>
                  <button className="tt-btn" onClick={() => toggle(t, d)} style={{ minWidth: 44, padding: "4px 6px", borderRadius: 7, fontSize: 11.5, fontWeight: 700, cursor: "pointer", border: `1px solid ${on ? C.primary : C.line}`, background: on ? C.primarySoft : "#f4f5f7", color: on ? C.primary : C.sub }}>{on ? "On" : "Off"}</button>
                </td>); })}
              <td style={{ ...cellTd, height: 36, fontFamily: mono }}>{teacherCap(cfg, t)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function SetupView({ cfg, update, ask, mobile }) {
  const [name, setName] = useState("");
  const [ct, setCt] = useState("");
  const [clonefrom, setClonefrom] = useState(cfg.classes[0]);
  const [newSub, setNewSub] = useState("");
  const [newTch, setNewTch] = useState("");
  const [err, setErr] = useState("");
  const [renFrom, setRenFrom] = useState("");
  const [renTo, setRenTo] = useState("");

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
      </div>

      <TeacherAvailability cfg={cfg} update={update} />

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

function openPrint(title, css, bodyHtml) {
  var w = window.open("", "_blank");
  if (!w) { alert("Please allow pop-ups for this site so the PDF can open, then choose 'Save as PDF' and paper size A4."); return; }
  w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title><style>' + css + '</style></head><body>' + bodyHtml + '<scr' + 'ipt>window.onload=function(){setTimeout(function(){window.print();},350);};<\/scr' + 'ipt></body></html>');
  w.document.close();
}

function subTint(sub) { var hex = SUBJECT_BAR[sub]; if (!hex) return "#ffffff"; var nn = parseInt(hex.slice(1), 16); return "rgba(" + ((nn >> 16) & 255) + "," + ((nn >> 8) & 255) + "," + (nn & 255) + ",0.16)"; }
function subCol(sub) { return SUBJECT_BAR[sub] || "#444"; }

function gridCss(paper) { return "@page{size:" + (paper || "A4") + " landscape;margin:1cm} *{-webkit-print-color-adjust:exact;print-color-adjust:exact} html,body{margin:0;height:100%} .page{page-break-after:always;height:190mm;box-sizing:border-box;display:flex;flex-direction:column} .page:last-child{page-break-after:auto} h2{font-size:20px;margin:0 0 6px;text-align:center;background:#0e6b73;color:#fff;padding:8px;border-radius:6px} .sub{font-size:13px;color:#0a4f55;margin:0 0 8px;text-align:center;font-weight:700} table{border-collapse:collapse;width:100%;height:100%;table-layout:fixed;flex:1;border:2px solid #0e6b73} th,td{border:1px solid #a9c6c6;text-align:center;padding:3px;font-size:14px} tr>*:first-child{width:64px;font-weight:800;background:#e1f0f0;color:#0a4f55} thead th{background:#0e6b73;color:#fff;font-weight:700} td .t{font-weight:800;font-size:16px} td .s{font-size:12px;font-weight:700}"; }

function gridHead(cfg) {
  var head = "<tr><th>Day / Period</th>";
  for (var pi = 0; pi < cfg.periods.length; pi++) head += "<th>P" + cfg.periods[pi] + "</th>";
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
  if (hit) { hit.c = divs.length > 3 ? divs.slice(0, 3).join(", ") + " +" + (divs.length - 3) : divs.join(", "); return hit; }
  return null;
}
function isOffDay(cfg, t, d) { var a = (cfg.teacherDays || {})[t]; return !!(a && a.length && a.indexOf(d) < 0); }

function exportClassesPDF(cfg, paper) {
  var head = gridHead(cfg), pages = "";
  for (var ci = 0; ci < cfg.classes.length; ci++) {
    var c = cfg.classes[ci], body = "";
    for (var di = 0; di < cfg.days.length; di++) {
      var d = cfg.days[di], row = "<tr><th>" + esc(DAY_FULL[d]) + "</th>";
      for (var p = 0; p < cfg.periods.length; p++) {
        var slot = (cfg.grid[c] && cfg.grid[c][d] && cfg.grid[c][d][p]) || [null, null];
        row += slot[0] ? ('<td style="background:' + subTint(slot[1]) + ';border-left:5px solid ' + subCol(slot[1]) + '"><span class="t" style="color:' + subCol(slot[1]) + '">' + esc(slot[1]) + '</span><br><span class="s">' + esc(slot[0]) + '</span></td>') : "<td></td>";
      }
      body += row + "</tr>";
    }
    pages += '<div class="page"><h2>' + esc(cfg.school) + " &mdash; Class " + esc(c) + '</h2><p class="sub">Class teacher: ' + esc(cfg.classTeacher[c] || "-") + '</p><table><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }
  openPrint(esc(cfg.school) + " - Class timetables", gridCss(paper), pages);
}

function exportTeachersPDF(cfg, paper) {
  var head = gridHead(cfg), pages = "";
  for (var ti = 0; ti < cfg.singles.length; ti++) {
    var t = cfg.singles[ti], body = "";
    for (var di = 0; di < cfg.days.length; di++) {
      var d = cfg.days[di], row = "<tr><th>" + esc(DAY_FULL[d]) + "</th>";
      for (var p = 0; p < cfg.periods.length; p++) {
        var r = teacherAt(cfg, t, d, p);
        row += r ? ('<td style="background:' + subTint(r.sub) + ';border-left:5px solid ' + subCol(r.sub) + '"><span class="t">' + esc(r.c) + '</span><br><span class="s" style="color:' + subCol(r.sub) + '">' + esc(r.sub) + '</span></td>') : "<td></td>";
      }
      body += row + "</tr>";
    }
    pages += '<div class="page"><h2>' + esc(cfg.school) + " &mdash; Teacher " + esc(t) + '</h2><table><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }
  openPrint(esc(cfg.school) + " - Teacher timetables", gridCss(paper), pages);
}


function exportFreeSlotsPDF(cfg, paper) {
  var css = "@page{size:A3 landscape;margin:8mm} *{-webkit-print-color-adjust:exact;print-color-adjust:exact} html,body{margin:0} body{font-family:Arial,Helvetica,sans-serif;color:#111} h2{font-size:16px;margin:0 0 8px;text-align:center;color:#0a4f55} table{border-collapse:collapse;width:100%;border:2px solid #0e6b73;table-layout:fixed} th,td{border:1px solid #bcd;padding:2px 1px;text-align:center;font-size:9px} thead th{background:#0e6b73;color:#fff;font-weight:700} td.free{background:#c9efd8;color:#0e7a45;font-weight:800} td.busy{color:#bbb} td.off{background:#e4e6ea} .tname{text-align:left;font-weight:800;background:#e1f0f0} .dsep{border-left:2px solid #0e6b73}";
  var head1 = "<tr><th rowspan=2 class=tname>Teacher</th>";
  for (var di = 0; di < cfg.days.length; di++) head1 += "<th colspan=" + cfg.periods.length + " class=dsep>" + esc(DAY_FULL[cfg.days[di]]) + "</th>";
  head1 += "<th rowspan=2>Free</th></tr>";
  var head2 = "<tr>";
  for (var d2 = 0; d2 < cfg.days.length; d2++) for (var pp = 0; pp < cfg.periods.length; pp++) head2 += "<th class=" + (pp === 0 ? "dsep" : "x") + ">" + cfg.periods[pp] + "</th>";
  head2 += "</tr>";
  var rows = "";
  for (var ti = 0; ti < cfg.singles.length; ti++) {
    var t = cfg.singles[ti], cells = "", freeTot = 0;
    for (var di3 = 0; di3 < cfg.days.length; di3++) {
      var d = cfg.days[di3];
      for (var p = 0; p < cfg.periods.length; p++) {
        var off = isOffDay(cfg, t, d), busy = off ? null : teacherAt(cfg, t, d, p);
        if (!busy && !off) freeTot++;
        cells += "<td class=\"" + (off ? "off" : busy ? "busy" : "free") + (p === 0 ? " dsep" : "") + "\">" + (off ? "" : busy ? "" : "\u25cf") + "</td>";
      }
    }
    rows += "<tr><td class=tname>" + esc(t) + "</td>" + cells + "<td><b>" + freeTot + "</b></td></tr>";
  }
  openPrint(esc(cfg.school) + " - Teacher free periods (by period)", css, "<h2>" + esc(cfg.school) + " - Teacher free (leisure) periods — green dot = free</h2><table><thead>" + head1 + head2 + "</thead><tbody>" + rows + "</tbody></table>");
}

function miniGridPages(cfg, items, per, cols, title, cellFor) {
  var css = "@page{size:A3 landscape;margin:8mm} *{-webkit-print-color-adjust:exact;print-color-adjust:exact} html,body{margin:0} body{font-family:Arial,Helvetica,sans-serif;color:#111} h2{font-size:16px;text-align:center;margin:2px 0 10px;color:#0a4f55} .grid{display:grid;grid-template-columns:repeat(" + cols + ",1fr);gap:8px} .mini{border:1px solid #0e6b73;break-inside:avoid;page-break-inside:avoid} .mh{background:#0e6b73;color:#fff;font-weight:800;font-size:11px;text-align:center;padding:3px} table{border-collapse:collapse;width:100%;table-layout:fixed} td,th{border:1px solid #b9c9c9;font-size:9px;text-align:center;padding:2px 1px;line-height:1.15} th{background:#e1f0f0;font-weight:700}";
  var head = "<tr><th></th>"; for (var p = 0; p < cfg.periods.length; p++) head += "<th>" + cfg.periods[p] + "</th>"; head += "</tr>";
  var sheets = "";
  for (var start = 0; start < items.length; start += per) {
    var minis = "";
    for (var k = start; k < Math.min(start + per, items.length); k++) {
      var it = items[k], body = "";
      for (var di = 0; di < cfg.days.length; di++) {
        var d = cfg.days[di]; body += "<tr><th>" + esc(DAY_FULL[d].slice(0, 1)) + "</th>";
        for (var pp = 0; pp < cfg.periods.length; pp++) body += cellFor(it, d, pp);
        body += "</tr>";
      }
      minis += "<div class=mini><div class=mh>" + esc(it) + "</div><table><thead>" + head + "</thead><tbody>" + body + "</tbody></table></div>";
    }
    sheets += minis;
  }
  return { css: css, body: "<h2>" + esc(cfg.school) + " - " + title + "</h2><div class=grid>" + sheets + "</div>" };
}

function exportClassesOverviewPDF(cfg) {
  var out = miniGridPages(cfg, cfg.classes, 40, 8, "All class timetables", function (c, d, pp) {
    var s = (cfg.grid[c] && cfg.grid[c][d] && cfg.grid[c][d][pp]) || [null, null];
    return s[1] ? ('<td style="background:' + subTint(s[1]) + ';color:' + subCol(s[1]) + ';font-weight:700">' + esc(s[1]) + '</td>') : "<td></td>";
  });
  openPrint(esc(cfg.school) + " - All classes (A3)", out.css, out.body);
}

function exportTeachersOverviewPDF(cfg) {
  var out = miniGridPages(cfg, cfg.singles, 24, 6, "All teacher timetables", function (t, d, pp) {
    var r = teacherAt(cfg, t, d, pp);
    return r ? ('<td style="background:' + subTint(r.sub) + ';color:' + subCol(r.sub) + ';font-weight:700">' + esc(r.c) + '</td>') : "<td></td>";
  });
  openPrint(esc(cfg.school) + " - All teachers (A3)", out.css, out.body);
}

function exportFreeReportPDF(cfg, paper) {
  var css = "@page{size:" + (paper || "A4") + " portrait;margin:1cm} *{-webkit-print-color-adjust:exact;print-color-adjust:exact} html,body{margin:0} body{font-family:Arial,Helvetica,sans-serif;color:#111} h2{font-size:20px;margin:0 0 12px;text-align:center} table{border-collapse:collapse;width:100%;border:2px solid #111} th,td{border:1px solid #333;padding:8px 9px;text-align:center;font-size:13.5px} th{background:#e6e6e6;font-weight:700} td:first-child,th:first-child{text-align:left}";
  var head = "<tr><th style='text-align:left'>Teacher</th>";
  for (var di = 0; di < cfg.days.length; di++) head += "<th>" + esc(DAY_FULL[cfg.days[di]].slice(0, 3)) + "</th>";
  head += "<th>Total free</th></tr>";
  var rows = "";
  for (var ti = 0; ti < cfg.singles.length; ti++) {
    var t = cfg.singles[ti], total = 0, cells = "";
    for (var di2 = 0; di2 < cfg.days.length; di2++) {
      var d = cfg.days[di2], free = 0;
      if (isOffDay(cfg, t, d)) { cells += "<td style='color:#888'>off</td>"; continue; }
      for (var p = 0; p < cfg.periods.length; p++) if (!teacherAt(cfg, t, d, p)) free++;
      total += free; cells += "<td>" + free + "</td>";
    }
    rows += "<tr><td style='text-align:left'><b>" + esc(t) + "</b></td>" + cells + "<td><b>" + total + "</b></td></tr>";
  }
  openPrint(esc(cfg.school) + " - Teacher leisure report", css, "<h2>" + esc(cfg.school) + " &mdash; Teacher free (leisure) periods per day</h2><table><thead>" + head + "</thead><tbody>" + rows + "</tbody></table>");
}
