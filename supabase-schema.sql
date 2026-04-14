-- Akira Academy — run once in Supabase → SQL → New query
-- Fixes incomplete tables (users without id breaks events FK).

drop table if exists public.events cascade;
drop table if exists public.users cascade;

create table public.users (
  id uuid primary key,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  is_anonymous boolean not null default true,
  auth_user_id uuid unique,
  locale text
);

comment on column public.users.auth_user_id is
  'auth.users.id after real login; optional merge from anonymous row later.';

create table public.events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references public.users (id) on delete cascade,
  event_type text not null,
  module_id text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists events_user_id_idx on public.events (user_id);
create index if not exists events_created_at_idx on public.events (created_at desc);
create index if not exists events_type_module_idx on public.events (event_type, module_id);

alter table public.users enable row level security;
alter table public.events enable row level security;

drop policy if exists "users_anon_insert" on public.users;
drop policy if exists "users_anon_update" on public.users;
drop policy if exists "events_anon_insert" on public.events;

create policy "users_anon_insert" on public.users for insert to anon with check (true);
create policy "users_anon_update" on public.users for update to anon using (true) with check (true);
create policy "events_anon_insert" on public.events for insert to anon with check (true);

grant usage on schema public to anon, authenticated;
grant insert, update on table public.users to anon;
grant insert on table public.events to anon;
