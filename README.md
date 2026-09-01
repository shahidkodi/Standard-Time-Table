# Timetable Manager — deploy guide

A school timetable app: B-Key, per-standard periods, rules engine, automated clash-free scheduler,
language (parallel) sessions, and an AI assistant. Built with Vite + React, Supabase (shared data + login),
and an OpenAI-compatible AI proxy. Installable as a PWA.

Everything except the AI assistant is free. The scheduler needs no API key.

## 1. Supabase (shared data + login) — free
1. Create a project at https://supabase.com (pick the region nearest you).
2. Open **SQL Editor**, paste the contents of `supabase/schema.sql`, run it.
3. **Authentication → Providers → Email**: keep it on, and turn **off** "Allow new users to sign up"
   so only staff you add can log in.
4. Add staff under **Authentication → Users → Add user → Create new user**. Staff log in with a
   **username**, so set each user's email to `<username>@amups.local` (e.g. `abdul@amups.local`)
   and give them a password. Tick **Auto Confirm User** if shown. The teacher then signs in with
   just `abdul` + their password — the app adds the `@amups.local` part automatically.
   (To use a different domain word, change `LOGIN_DOMAIN` near the top of `src/main.jsx`.)
5. **Project Settings → API**: copy the **Project URL** and the **anon public** key.

## 2. AI assistant (optional) — free key
Pick any OpenAI-compatible provider and get a free key:
- **Groq** (fast, no card): https://console.groq.com → `AI_BASE_URL=https://api.groq.com/openai/v1`, `AI_MODEL=llama-3.3-70b-versatile`
- **Gemini**: https://aistudio.google.com → `AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`, `AI_MODEL=gemini-2.5-flash`
- **OpenRouter / DeepSeek**: see `.env.example`
The key lives only on the server (Vercel), never in the browser. Skip this and the scheduler still works.

## 3. Deploy on Vercel — free
1. Push this folder to a GitHub repo.
2. https://vercel.com → New Project → import the repo (framework auto-detected as Vite).
3. **Settings → Environment Variables**, add:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (from step 1)
   - `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` (from step 2, optional)
4. Deploy. Add a custom domain under **Settings → Domains** if you like.

## 4. Heartbeat — keeps the free Supabase project awake
Supabase pauses free projects after 7 days of no DB activity. The included GitHub Action pings it
twice a week so it never pauses.
1. In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**
   - `SUPABASE_URL` = your project URL
   - `SUPABASE_ANON_KEY` = your anon key
2. The workflow in `.github/workflows/heartbeat.yml` runs automatically (Mon & Thu).
   You can also run it once manually from the Actions tab to confirm it works.

## 5. Install as an app
Open the site in Chrome/Safari → "Install app" / "Add to Home Screen". It opens full-screen with its own icon.

## Local development
```
npm install
cp .env.example .env        # fill in VITE_SUPABASE_* (AI vars only work on Vercel)
npm run dev
```

## Notes
- The whole timetable is stored as one JSON row (`timetables.id = 'main'`). Edits save automatically
  and sync live to other signed-in staff. Concurrency is last-write-wins, which is fine for a few
  editors; avoid two people editing the very same slot at the exact same second.
- Use **Export** in the app header to download a backup of the full config any time.
- To switch from staff logins to a single shared password later, replace the Login screen in
  `src/main.jsx` — the rest of the app is unaffected.
