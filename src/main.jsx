import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { supabase, supabaseReady } from "./supabaseClient";

const sans = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";

// Staff log in with a username; we attach this fixed domain behind the scenes.
// When you create users in Supabase, use  <username>@amups.local  as the email.
const LOGIN_DOMAIN = "amups.local";

function Login() {
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr("");
    const email = user.trim().toLowerCase() + "@" + LOGIN_DOMAIN;
    const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
    if (error) setErr(error.message);
    setBusy(false);
  };
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "linear-gradient(120deg,#0a4f55,#0e6b73)", fontFamily: sans }}>
      <div style={{ background: "#fff", borderRadius: 16, padding: 30, width: 360, maxWidth: "90vw", boxShadow: "0 18px 50px rgba(0,0,0,.25)" }}>
        <div style={{ width: 46, height: 46, borderRadius: 12, background: "#0e6b73", color: "#fff", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 18, marginBottom: 16 }}>TT</div>
        <h1 style={{ margin: "0 0 4px", fontSize: 20, color: "#16213a" }}>Timetable Manager</h1>
        <p style={{ margin: "0 0 20px", fontSize: 13, color: "#647189" }}>Sign in with your staff username and password.</p>
        {!supabaseReady && <p style={{ color: "#d64545", fontSize: 12.5 }}>Supabase isn't configured yet — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.</p>}
        <input placeholder="Username" value={user} onChange={(e) => setUser(e.target.value)} autoCapitalize="none" autoCorrect="off" style={inp} />
        <input placeholder="Password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} style={inp} />
        {err && <div style={{ color: "#d64545", fontSize: 12.5, marginBottom: 10 }}>{err}</div>}
        <button onClick={submit} disabled={busy} style={{ width: "100%", border: "none", background: "#0e6b73", color: "#fff", padding: "11px", borderRadius: 9, fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>{busy ? "Signing in…" : "Sign in"}</button>
      </div>
    </div>
  );
}
const inp = { width: "100%", boxSizing: "border-box", border: "1px solid #e4e8ef", borderRadius: 9, padding: "11px 12px", fontSize: 14, marginBottom: 12, fontFamily: sans };

function ConfigNeeded() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "linear-gradient(120deg,#0a4f55,#0e6b73)", fontFamily: sans, padding: 20 }}>
      <div style={{ background: "#fff", borderRadius: 16, padding: 28, width: 440, maxWidth: "92vw", boxShadow: "0 18px 50px rgba(0,0,0,.25)" }}>
        <h1 style={{ margin: "0 0 8px", fontSize: 19, color: "#16213a" }}>Almost there - add your Supabase keys</h1>
        <p style={{ fontSize: 13.5, color: "#48607a", lineHeight: 1.6, margin: "0 0 12px" }}>This app cannot find its database keys, so the login screen is off. In your Vercel project open <b>Settings > Environment Variables</b>, add both of these for <b>Production</b>, then <b>Redeploy</b>:</p>
        <pre style={{ background: "#f3f5f8", padding: "12px 14px", borderRadius: 10, fontSize: 12.5, color: "#16213a", overflowX: "auto", whiteSpace: "pre-wrap" }}>VITE_SUPABASE_URL = https://YOUR-ID.supabase.co\nVITE_SUPABASE_ANON_KEY = your publishable / anon key</pre>
        <p style={{ fontSize: 12.5, color: "#647189", margin: "10px 0 0" }}>After redeploying, this becomes your staff login screen.</p>
      </div>
    </div>
  );
}

function Root() {
  const [session, setSession] = useState(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  if (session === undefined) return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: sans, color: "#647189" }}>Loading…</div>;
  if (!supabaseReady) return <ConfigNeeded />;
  if (!session) return <Login />;
  return <App />;
}

createRoot(document.getElementById("root")).render(<Root />);
