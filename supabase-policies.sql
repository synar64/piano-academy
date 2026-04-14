-- Futtasd ezt, ha a táblák már megvannak, de a böngészőből INSERT hibázik
-- (pl. "new row violates row-level security policy" vagy permission denied).

alter table if exists public.users enable row level security;
alter table if exists public.events enable row level security;

drop policy if exists "users_anon_insert" on public.users;
drop policy if exists "users_anon_update" on public.users;
drop policy if exists "events_anon_insert" on public.events;

create policy "users_anon_insert" on public.users for insert to anon with check (true);
create policy "users_anon_update" on public.users for update to anon using (true) with check (true);
create policy "events_anon_insert" on public.events for insert to anon with check (true);

grant usage on schema public to anon, authenticated;
grant insert, update on table public.users to anon;
grant insert on table public.events to anon;
