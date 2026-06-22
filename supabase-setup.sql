-- Life Tracker — database setup
-- Run this once in your Supabase project:
--   Dashboard -> SQL Editor -> New query -> paste this -> Run
--
-- Design: one row per user, holding that user's whole tracker state as JSON.
-- Row-level security ensures each logged-in user can only read and write their
-- own row, even though everyone shares the same anon key in the browser.

create table if not exists public.tracker_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.tracker_state enable row level security;

-- Each policy restricts rows to the currently authenticated user.
create policy "read own state"
  on public.tracker_state for select
  using (auth.uid() = user_id);

create policy "insert own state"
  on public.tracker_state for insert
  with check (auth.uid() = user_id);

create policy "update own state"
  on public.tracker_state for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
