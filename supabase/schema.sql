-- Run this in Supabase → SQL Editor once.

-- Shared timetable (whole config stored as one JSON document).
create table if not exists public.timetables (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
alter table public.timetables enable row level security;

create policy "tt_read"   on public.timetables for select to authenticated using (true);
create policy "tt_insert" on public.timetables for insert to authenticated with check (true);
create policy "tt_update" on public.timetables for update to authenticated using (true) with check (true);

-- Tiny table the heartbeat pings so the free project never pauses.
create table if not exists public.ping (
  id int primary key,
  t  timestamptz default now()
);
insert into public.ping (id, t) values (1, now()) on conflict (id) do nothing;
alter table public.ping enable row level security;
create policy "ping_read" on public.ping for select to anon using (true);
