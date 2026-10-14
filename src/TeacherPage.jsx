import React, { useEffect, useMemo, useState } from "react";
import { loadTeacherPage } from "./storage";

// Read-only page a teacher opens from their personal link (…/?t=CODE). No login needed.
const sans = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";
const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const WD = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const C = { ink: "#16213a", sub: "#647189", line: "#e4e8ef", g1: "#0e6b73", g2: "#0a4f55", soft: "#e1f0f0", free: "#1f9d57", freeSoft: "#e3f5ec", warn: "#bd861d", warnSoft: "#fbf2dd", red: "#d64545", redSoft: "#fbe6e4", accent: "#d98a2b" };
const SUB_COL = { ENG: "#3b76d1", MAT: "#e07b1f", SS: "#1f9d57", BS: "#7a8a2e", HIN: "#a64bbf", "MAL-2": "#138a9c", LAN: "#c08a2e", IT: "#5a5bd6", PET: "#e0574b", LB: "#5b7088", TAB: "#cf5a93" };

function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function fromIso(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function nice(s, long) { return fromIso(s).toLocaleDateString(undefined, long ? { weekday: "long", day: "numeric", month: "long" } : { weekday: "short", day: "numeric", month: "short" }); }

export default function TeacherPage({ token }) {
  const [st, setSt] = useState({ loading: true });
  const [tab, setTab] = useState(null);
  const [now, setNow] = useState(new Date());
  const load = async () => {
    try {
      const r = await loadTeacherPage(token);
      if (r.error) setSt({ error: r.error });
      else if (!r.page) setSt({ notFound: true });
      else setSt({ page: r.page, school: r.school || {} });
    } catch (e) { setSt({ error: (e && e.message) || String(e) }); }
    setNow(new Date());
  };
  useEffect(() => {
    try { let staff = false; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i) || ""; if (k.startsWith("sb-") && k.endsWith("-auth-token")) staff = true; } if (!staff) localStorage.setItem("tt_my_token", token); } catch {}
    load();
    const iv = setInterval(load, 5 * 60 * 1000);
    const vis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", vis); };
  }, [token]);
  // install to home screen opens this teacher's page, not the staff login
  useEffect(() => {
    const p = st.page, s = st.school; if (!p) return;
    document.title = `${p.t} · Timetable`;
    try {
      const o = window.location.origin;
      const man = { name: `${p.t} · ${s.school || "Timetable"}`, short_name: p.t, start_url: `${o}/?t=${encodeURIComponent(token)}`, scope: `${o}/`, display: "standalone", background_color: "#ffffff", theme_color: C.g1,
        icons: [{ src: `${o}/icon-192.png`, sizes: "192x192", type: "image/png" }, { src: `${o}/icon-512.png`, sizes: "512x512", type: "image/png" }] };
      let l = document.querySelector("link[rel='manifest']"); if (!l) { l = document.createElement("link"); l.rel = "manifest"; document.head.appendChild(l); }
      l.href = URL.createObjectURL(new Blob([JSON.stringify(man)], { type: "application/manifest+json" }));
      if (s.logo) { let f = document.querySelector("link[rel='icon']"); if (!f) { f = document.createElement("link"); f.rel = "icon"; document.head.appendChild(f); } f.href = s.logo; }
    } catch {}
  }, [st.page, st.school, token]);

  const school = st.school || {}, page = st.page;
  const days = school.days || [], periods = school.periods || [];
  const today = iso(now), dayCode = WD[now.getDay()];
  const working = days.includes(dayCode);
  const showDay = tab || (working ? dayCode : days[0]);
  const subs = (page && page.subs) || {};
  const upcoming = useMemo(() => Object.keys(subs).filter((d) => d > today && (subs[d].cover || []).length).sort(), [subs, today]);

  const shell = (children) => (
    <div style={{ minHeight: "100vh", background: "#eef1f5", fontFamily: sans, color: C.ink }}>
      <style>{"@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');*{box-sizing:border-box}"}</style>
      {children}
    </div>
  );
  if (st.loading) return shell(<div style={{ display: "grid", placeItems: "center", minHeight: "100vh", color: C.sub }}>Loading your timetable…</div>);
  if (st.notFound || st.error) return shell(
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: 20 }}>
      <div style={{ background: "#fff", borderRadius: 16, padding: 26, maxWidth: 420, textAlign: "center", boxShadow: "0 10px 30px rgba(0,0,0,.08)" }}>
        <div style={{ fontSize: 34, marginBottom: 6 }}>🔗</div>
        <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>{st.notFound ? "This link isn't active" : "Couldn't load the timetable"}</h1>
        <p style={{ fontSize: 13.5, color: C.sub, lineHeight: 1.6, margin: 0 }}>{st.notFound ? "The link may have been replaced with a new one. Please ask the school office for your current link." : "Check your internet connection and try again."}</p>
        {!st.notFound && <button onClick={load} style={{ marginTop: 14, border: "none", background: C.g1, color: "#fff", padding: "10px 18px", borderRadius: 10, fontWeight: 700, fontFamily: sans }}>Try again</button>}
        <div style={{ marginTop: 18 }}><a href="/?admin=1" style={{ fontSize: 12, color: C.sub }}>Staff login</a></div>
      </div>
    </div>
  );

  const td = subs[today] || {};
  const absentPart = td.absent, half = school.fn || Math.ceil(periods.length / 2);
  const absentAt = (p) => !!absentPart && (absentPart === "full" || (absentPart === "am" ? p < half : p >= half));
  const cell = (d, p) => (page.week[d] || [])[p];
  const subColor = (s) => SUB_COL[s] || C.g2;
  const coverToday = td.cover || [];
  const myToday = periods.map((_, p) => ({ p, c: working ? cell(dayCode, p) : null, cover: coverToday.find((x) => x.p === p), away: absentAt(p), by: (td.coveredBy || []).find((x) => x.p === p) }));
  const freeToday = myToday.filter((x) => x.c === null && !x.cover).length;
  const at = page._at ? new Date(page._at) : null;

  return shell(
    <>
      <header style={{ background: `linear-gradient(115deg, ${C.g2}, ${C.g1})`, color: "#fff", padding: "16px 16px 22px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", alignItems: "center", gap: 12 }}>
          {school.logo ? <div style={{ width: 48, height: 48, borderRadius: 12, background: "#fff", display: "grid", placeItems: "center", padding: 3, flexShrink: 0 }}><img src={school.logo} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /></div> : null}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.5, textTransform: "uppercase", opacity: 0.85 }}>{school.school}{school.year ? ` · ${school.year}` : ""}</div>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.3 }}>My timetable · <span style={{ fontFamily: mono }}>{page.t}</span></div>
            <div style={{ fontSize: 12.5, opacity: 0.9 }}>{page.load} periods a week · {page.free} free{page.ct && page.ct.length ? ` · Class teacher of ${page.ct.join(", ")}` : ""}</div>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 760, margin: "-12px auto 0", padding: "0 12px 30px", display: "grid", gap: 14 }}>
        <section style={card}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <h2 style={{ margin: 0, fontSize: 17 }}>Today</h2>
            <span style={{ color: C.sub, fontSize: 13 }}>{nice(today, true)}</span>
            {working && <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, padding: "2px 10px", borderRadius: 20, background: C.freeSoft, color: C.free }}>{freeToday} free period{freeToday === 1 ? "" : "s"}</span>}
          </div>
          {absentPart && <div style={{ ...note, background: C.redSoft, color: "#8a1f17" }}>You are marked <b>absent</b> {absentPart === "full" ? "today" : absentPart === "am" ? "for the forenoon (FN)" : "for the afternoon (AN)"}. Your classes are covered by colleagues.</div>}
          {coverToday.length > 0 && <div style={{ ...note, background: C.warnSoft, color: "#7a5310" }}><b>Substitution today:</b> {coverToday.sort((a, b) => a.p - b.p).map((x) => `P${periods[x.p]} ${x.cls} ${x.sub} (for ${x.for})`).join(" · ")}</div>}
          {!working ? <div style={{ color: C.sub, fontSize: 14, padding: "8px 0" }}>No classes today. 🌿</div> : (
            <div style={{ display: "grid", gap: 6 }}>
              {myToday.flatMap((x) => [x.p === half && half > 0 && half < periods.length ? <div key={"lunch"} style={{ display: "flex", alignItems: "center", gap: 10, color: C.accent, fontSize: 11.5, fontWeight: 800, letterSpacing: 1, padding: "2px 4px" }}><span style={{ flex: 1, height: 1, background: "#f0d9b5" }} />LUNCH · AFTERNOON (AN)<span style={{ flex: 1, height: 1, background: "#f0d9b5" }} /></div> : null, x]).filter(Boolean).map((x) => {
                if (!x || x.p === undefined) return x;
                const c = x.c;
                let main, sub, bg = "#fff", bd = C.line, tag = null;
                if (x.cover) { main = `${x.cover.cls} · ${x.cover.sub}`; sub = `Substitution for ${x.cover.for}`; bg = C.warnSoft; bd = `${C.warn}88`; tag = "COVER"; }
                else if (c === "off") { main = "Not working"; sub = ""; bg = "#f1f3f6"; }
                else if (!c) { main = "Free"; sub = ""; bg = C.freeSoft; bd = `${C.free}55`; }
                else { main = `${c.c} · ${c.s}`; sub = c.k ? "combined class" : ""; }
                if (x.away && c && c !== "off") { sub = x.by && x.by.by ? `You're absent — ${x.by.by} is covering` : "You're absent"; bg = C.redSoft; bd = `${C.red}55`; }
                return (
                  <div key={x.p} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 12px", borderRadius: 12, border: `1.5px solid ${bd}`, background: bg }}>
                    <span style={{ width: 40, height: 40, borderRadius: 11, display: "grid", placeItems: "center", background: `linear-gradient(135deg, ${C.g1}, ${C.g2})`, color: "#fff", fontWeight: 800, flexShrink: 0 }}>P{periods[x.p]}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 15, fontWeight: 800, color: c && c.s && !x.cover ? subColor(c.s) : C.ink }}>{main}</div>
                      {sub && <div style={{ fontSize: 12, color: C.sub }}>{sub}</div>}
                    </div>
                    {tag && <span style={{ fontSize: 10.5, fontWeight: 800, padding: "2px 8px", borderRadius: 10, background: C.warn, color: "#fff" }}>{tag}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {upcoming.length > 0 && (
          <section style={card}>
            <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Coming up</h2>
            {upcoming.map((d) => (
              <div key={d} style={{ padding: "6px 0", borderTop: `1px solid ${C.line}`, fontSize: 13.5 }}>
                <b>{nice(d)}</b> — {subs[d].cover.sort((a, b) => a.p - b.p).map((x) => `P${periods[x.p]} ${x.cls} ${x.sub} (for ${x.for})`).join(" · ")}
              </div>
            ))}
          </section>
        )}

        <section style={card}>
          <h2 style={{ margin: "0 0 10px", fontSize: 16 }}>My week</h2>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {days.map((d) => <button key={d} onClick={() => setTab(d)} style={{ border: `1.5px solid ${showDay === d ? C.g1 : C.line}`, background: showDay === d ? C.g1 : "#fff", color: showDay === d ? "#fff" : C.sub, padding: "7px 13px", borderRadius: 20, fontWeight: 800, fontSize: 13, fontFamily: sans, cursor: "pointer" }}>{((school.dayNames || {})[d] || d).slice(0, 3)}{d === dayCode && working ? " •" : ""}</button>)}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
            {periods.map((pn, p) => {
              const c = cell(showDay, p);
              return (
                <div key={p} style={{ padding: "9px 11px", borderRadius: 12, border: `1px solid ${C.line}`, background: c === "off" ? "#f1f3f6" : !c ? C.freeSoft : "#fff", borderLeft: `5px solid ${c && c !== "off" ? subColor(c.s) : !c ? C.free : C.line}` }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: C.sub }}>P{pn}</div>
                  <div style={{ fontSize: 14.5, fontWeight: 800 }}>{c === "off" ? "Not working" : !c ? "Free" : c.c}</div>
                  {c && c !== "off" && <div style={{ fontSize: 12.5, fontWeight: 700, color: subColor(c.s) }}>{c.s}{c.k ? " · combined" : ""}</div>}
                </div>
              );
            })}
          </div>
        </section>

        <footer style={{ textAlign: "center", fontSize: 11.5, color: C.sub, lineHeight: 1.7 }}>
          {at ? `Updated ${at.toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · ` : ""}Read-only · refreshes by itself<br />
          Tip: use your browser's <b>Add to Home screen</b> to open this like an app.<br />
          <a href="/?admin=1" style={{ color: C.sub }}>Staff login</a>
        </footer>
      </main>
    </>
  );
}
const card = { background: "#fff", borderRadius: 16, padding: 14, boxShadow: "0 1px 2px rgba(22,33,58,.04), 0 6px 18px rgba(22,33,58,.06)", border: "1px solid #e4e8ef" };
const note = { borderRadius: 10, padding: "9px 12px", fontSize: 13, marginBottom: 10, lineHeight: 1.5 };
