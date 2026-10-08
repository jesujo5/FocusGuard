-- =====================================================================
-- FocusGuard — supabase/schema.sql
-- Phase 9 (Part 7, 8, 29, 31, 35, 36) + Phase 10 (Parts 12/13):
-- cloud database + Row Level Security.
--
-- HOW TO RUN
--   1. Open your Supabase project → SQL Editor → New query.
--   2. Paste this whole file and press Run.
--   3. It is safe to run more than once: everything uses IF NOT EXISTS and
--      policies are dropped/recreated by name. It never drops a table.
--
-- WHAT IT CREATES
--   profiles · study_sessions · distraction_events · coin_ledger
--   daily_goals · user_settings
--   worlds · world_objects · world_expansions   (Phase 10 — Focus World)
--   + indexes for the queries FocusGuard actually runs
--   + Row Level Security so a user can only ever see their own rows
--
-- PRIVACY
--   Only derived statistics are stored. No webcam frame, image, video or
--   facial landmark is ever sent here — FocusGuard has no code that could.
--
-- SECURITY MODEL (Part 29)
--   Ownership is always `auth.uid() = user_id`, decided by the database
--   from the verified JWT. A client-supplied user_id is never trusted:
--   inserting someone else's id simply fails the policy.
--
-- IDEMPOTENCY (Part 13)
--   Every table has a client-generated primary key (or the user id), so
--   syncing the same record twice is an UPSERT that updates one row.
--   FocusGuard always writes with onConflict = id / user_id.
-- =====================================================================

-- Needed for gen_random_uuid() on older projects.
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- 1. profiles
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references auth.users (id) on delete cascade,
  email       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is
  'One minimal profile row per FocusGuard user. No personal data beyond the email Supabase Auth already holds.';

-- ---------------------------------------------------------------------
-- 2. study_sessions
-- ---------------------------------------------------------------------
create table if not exists public.study_sessions (
  id                    text primary key,
  user_id               uuid not null references auth.users (id) on delete cascade,
  subject               text not null default '',
  goal                  text not null default '',
  start_time            timestamptz,
  end_time              timestamptz,
  elapsed_duration      integer not null default 0 check (elapsed_duration >= 0),   -- seconds
  active_duration       integer not null default 0 check (active_duration >= 0),    -- seconds, paused time removed
  paused_duration       integer not null default 0 check (paused_duration >= 0),    -- seconds
  focused_duration      integer check (focused_duration is null or focused_duration >= 0),
  distracted_duration   integer check (distracted_duration is null or distracted_duration >= 0),
  face_missing_duration integer check (face_missing_duration is null or face_missing_duration >= 0),
  unclassified_duration integer check (unclassified_duration is null or unclassified_duration >= 0),
  distraction_count     integer not null default 0 check (distraction_count >= 0),
  pomodoros_completed   integer not null default 0 check (pomodoros_completed >= 0),
  focus_score           integer check (focus_score is null or (focus_score >= 0 and focus_score <= 100)),
  focus_rating          text,
  focus_coins_earned    integer not null default 0 check (focus_coins_earned >= 0),
  measured              boolean not null default false,
  status                text not null default 'completed',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.study_sessions is
  'Finished (or recovered) study sessions. Durations are seconds; timestamps are UTC. The focused/score columns are derived statistics only.';

-- ---------------------------------------------------------------------
-- 3. distraction_events
-- ---------------------------------------------------------------------
create table if not exists public.distraction_events (
  id          text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  session_id  text references public.study_sessions (id) on delete cascade,
  start_time  timestamptz,
  end_time    timestamptz,
  duration    integer not null default 0 check (duration >= 0),   -- seconds
  reason      text not null default 'HEAD_AWAY'
              check (reason in ('HEAD_AWAY', 'FACE_MISSING')),
  created_at  timestamptz not null default now()
);

comment on table public.distraction_events is
  'One row per away episode (metadata only). session_id references study_sessions, which is why sessions sync first.';

-- ---------------------------------------------------------------------
-- 4. coin_ledger — the source of truth for Focus Coins
-- ---------------------------------------------------------------------
create table if not exists public.coin_ledger (
  id              text primary key,
  user_id         uuid not null references auth.users (id) on delete cascade,
  session_id      text references public.study_sessions (id) on delete set null,
  type            text not null default 'FOCUSED_TIME',
  amount          integer not null check (amount > 0),
  "timestamp"     timestamptz not null default now(),
  focused_seconds integer not null default 0 check (focused_seconds >= 0),
  rule            text default '1 focused minute = 1 Focus Coin',
  created_at      timestamptz not null default now()
);

comment on table public.coin_ledger is
  'Append-only reward transactions. A balance is always SUM(amount) — never a number sent by the browser. The primary key makes re-syncing idempotent, so 41 coins can never become 123.';

-- ---------------------------------------------------------------------
-- 5. daily_goals
-- ---------------------------------------------------------------------
create table if not exists public.daily_goals (
  id                text primary key,
  user_id           uuid not null references auth.users (id) on delete cascade,
  "date"            date not null,
  target_minutes    integer not null default 0 check (target_minutes >= 0),
  completed_minutes integer not null default 0 check (completed_minutes >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint daily_goals_user_date_key unique (user_id, "date")
);

comment on table public.daily_goals is
  'The user''s daily target. completed_minutes is derived from stored focused time, never typed in by the user.';

-- ---------------------------------------------------------------------
-- 6. user_settings
-- ---------------------------------------------------------------------
create table if not exists public.user_settings (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  focus_minutes      integer not null default 25 check (focus_minutes between 1 and 180),
  short_break_minutes integer not null default 5 check (short_break_minutes between 1 and 180),
  long_break_minutes integer not null default 15 check (long_break_minutes between 1 and 180),
  auto_start_next    boolean not null default true,
  sound_enabled      boolean not null default true,
  attention_mode     text not null default 'screen' check (attention_mode in ('screen', 'notebook')),
  alerts_enabled     boolean not null default true,
  grace_seconds      integer not null default 5 check (grace_seconds between 2 and 15),
  camera_preference  text not null default 'ask',
  daily_goal_minutes integer not null default 120 check (daily_goal_minutes >= 0),
  updated_at         timestamptz not null default now()
);

-- Prompt 10.5 additions, for databases created before the attention modes.
-- Idempotent: safe to re-run against an existing project.
alter table public.user_settings
  add column if not exists attention_mode text not null default 'screen';
alter table public.user_settings
  add column if not exists alerts_enabled boolean not null default true;

comment on table public.user_settings is
  'Non-sensitive preferences only (timers, grace period, attention mode, sound toggles). No images, no camera data, no credentials.';

-- ---------------------------------------------------------------------
-- 6b. worlds / world_objects / world_expansions (Phase 10 — Focus World)
--     The world is one row per user; its objects and land expansions point
--     at it. world_objects are soft-deleted (deleted = true) so a removal
--     syncs as an ordinary update and last-write-wins keeps working.
--     No world art, no images: only coordinates, a type string and a rotation.
-- ---------------------------------------------------------------------
create table if not exists public.worlds (
  id          text primary key,                                  -- the owner's id
  user_id     uuid not null references auth.users (id) on delete cascade,
  grid_size   integer not null default 5 check (grid_size in (5, 7, 10, 15)),
  biome       text not null default 'meadow',                    -- future biomes slot in here
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.worlds is
  'One Focus World per user: its land size and biome. Grows only by spending earned Focus Coins.';

create table if not exists public.world_objects (
  id          text primary key,
  world_id    text references public.worlds (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  type        text not null,
  x           integer not null default 0 check (x >= 0),
  y           integer not null default 0 check (y >= 0),
  rotation    integer not null default 0 check (rotation in (0, 90, 180, 270)),
  deleted     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.world_objects is
  'One row per placed object. Soft-deleted so a removal syncs and last-write-wins applies.';

create table if not exists public.world_expansions (
  id            text primary key,
  world_id      text references public.worlds (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  old_grid_size integer not null default 5,
  new_grid_size integer not null default 7,
  cost          integer not null default 0 check (cost >= 0),
  created_at    timestamptz not null default now()
);

comment on table public.world_expansions is
  'One row per purchased land expansion (5→7→10→15). Existing objects keep their coordinates.';

-- ---------------------------------------------------------------------
-- 7. Indexes (Part 36) — sized for the queries FocusGuard runs
-- ---------------------------------------------------------------------
create index if not exists study_sessions_user_idx              on public.study_sessions (user_id);
create index if not exists study_sessions_user_start_idx        on public.study_sessions (user_id, start_time desc);

create index if not exists distraction_events_user_idx          on public.distraction_events (user_id);
create index if not exists distraction_events_session_idx       on public.distraction_events (session_id);

create index if not exists coin_ledger_user_idx                 on public.coin_ledger (user_id);
create index if not exists coin_ledger_session_idx              on public.coin_ledger (session_id);
create index if not exists coin_ledger_user_time_idx            on public.coin_ledger (user_id, "timestamp");

create index if not exists daily_goals_user_date_idx            on public.daily_goals (user_id, "date");

create index if not exists worlds_user_idx                      on public.worlds (user_id);
create index if not exists world_objects_user_idx               on public.world_objects (user_id);
create index if not exists world_objects_world_idx              on public.world_objects (world_id);
create index if not exists world_expansions_user_idx            on public.world_expansions (user_id);
create index if not exists world_expansions_world_idx           on public.world_expansions (world_id);

-- user_settings is keyed by user_id, so the primary key already covers
-- the one query it needs (select * where user_id = auth.uid()).

-- ---------------------------------------------------------------------
-- 8. Row Level Security (Part 8) — mandatory on every user-owned table
-- ---------------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.study_sessions    enable row level security;
alter table public.distraction_events enable row level security;
alter table public.coin_ledger       enable row level security;
alter table public.daily_goals       enable row level security;
alter table public.user_settings     enable row level security;
alter table public.worlds            enable row level security;
alter table public.world_objects     enable row level security;
alter table public.world_expansions  enable row level security;

-- ---------------------------------------------------------------------
-- 9. Policies
--    Rule everywhere: the row's user_id must equal the authenticated
--    user id. There is no policy that allows anon access and no policy
--    that allows reading another user's rows.
-- ---------------------------------------------------------------------

-- profiles ------------------------------------------------------------
drop policy if exists "profiles are own" on public.profiles;
create policy "profiles are own"
  on public.profiles for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- study_sessions ------------------------------------------------------
drop policy if exists "study_sessions select own" on public.study_sessions;
create policy "study_sessions select own"
  on public.study_sessions for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "study_sessions insert own" on public.study_sessions;
create policy "study_sessions insert own"
  on public.study_sessions for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "study_sessions update own" on public.study_sessions;
create policy "study_sessions update own"
  on public.study_sessions for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "study_sessions delete own" on public.study_sessions;
create policy "study_sessions delete own"
  on public.study_sessions for delete to authenticated
  using (auth.uid() = user_id);

-- distraction_events --------------------------------------------------
drop policy if exists "distraction_events select own" on public.distraction_events;
create policy "distraction_events select own"
  on public.distraction_events for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "distraction_events insert own" on public.distraction_events;
create policy "distraction_events insert own"
  on public.distraction_events for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "distraction_events update own" on public.distraction_events;
create policy "distraction_events update own"
  on public.distraction_events for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "distraction_events delete own" on public.distraction_events;
create policy "distraction_events delete own"
  on public.distraction_events for delete to authenticated
  using (auth.uid() = user_id);

-- coin_ledger ---------------------------------------------------------
drop policy if exists "coin_ledger select own" on public.coin_ledger;
create policy "coin_ledger select own"
  on public.coin_ledger for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "coin_ledger insert own" on public.coin_ledger;
create policy "coin_ledger insert own"
  on public.coin_ledger for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "coin_ledger update own" on public.coin_ledger;
create policy "coin_ledger update own"
  on public.coin_ledger for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "coin_ledger delete own" on public.coin_ledger;
create policy "coin_ledger delete own"
  on public.coin_ledger for delete to authenticated
  using (auth.uid() = user_id);

-- daily_goals ---------------------------------------------------------
drop policy if exists "daily_goals select own" on public.daily_goals;
create policy "daily_goals select own"
  on public.daily_goals for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "daily_goals insert own" on public.daily_goals;
create policy "daily_goals insert own"
  on public.daily_goals for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "daily_goals update own" on public.daily_goals;
create policy "daily_goals update own"
  on public.daily_goals for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "daily_goals delete own" on public.daily_goals;
create policy "daily_goals delete own"
  on public.daily_goals for delete to authenticated
  using (auth.uid() = user_id);

-- user_settings -------------------------------------------------------
drop policy if exists "user_settings select own" on public.user_settings;
create policy "user_settings select own"
  on public.user_settings for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "user_settings insert own" on public.user_settings;
create policy "user_settings insert own"
  on public.user_settings for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "user_settings update own" on public.user_settings;
create policy "user_settings update own"
  on public.user_settings for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "user_settings delete own" on public.user_settings;
create policy "user_settings delete own"
  on public.user_settings for delete to authenticated
  using (auth.uid() = user_id);

-- worlds -------------------------------------------------------------
drop policy if exists "worlds select own" on public.worlds;
create policy "worlds select own"
  on public.worlds for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "worlds insert own" on public.worlds;
create policy "worlds insert own"
  on public.worlds for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "worlds update own" on public.worlds;
create policy "worlds update own"
  on public.worlds for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "worlds delete own" on public.worlds;
create policy "worlds delete own"
  on public.worlds for delete to authenticated
  using (auth.uid() = user_id);

-- world_objects -------------------------------------------------------
drop policy if exists "world_objects select own" on public.world_objects;
create policy "world_objects select own"
  on public.world_objects for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "world_objects insert own" on public.world_objects;
create policy "world_objects insert own"
  on public.world_objects for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "world_objects update own" on public.world_objects;
create policy "world_objects update own"
  on public.world_objects for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "world_objects delete own" on public.world_objects;
create policy "world_objects delete own"
  on public.world_objects for delete to authenticated
  using (auth.uid() = user_id);

-- world_expansions ----------------------------------------------------
drop policy if exists "world_expansions select own" on public.world_expansions;
create policy "world_expansions select own"
  on public.world_expansions for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "world_expansions insert own" on public.world_expansions;
create policy "world_expansions insert own"
  on public.world_expansions for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "world_expansions update own" on public.world_expansions;
create policy "world_expansions update own"
  on public.world_expansions for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "world_expansions delete own" on public.world_expansions;
create policy "world_expansions delete own"
  on public.world_expansions for delete to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 10. Making sure the public API can still use the tables
--     (RLS, not grants, decides who sees what.)
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- ---------------------------------------------------------------------
-- 11. Verifying RLS is on (run this on its own any time)
-- ---------------------------------------------------------------------
-- select tablename, rowsecurity from pg_tables
-- where schemaname = 'public'
-- order by tablename;
--
-- Every FocusGuard table must show rowsecurity = true.
-- If you ever see rowsecurity = false, run:
--   alter table public.<table> enable row level security;
-- and re-run the policies above. Never disable RLS to "make sync work".
