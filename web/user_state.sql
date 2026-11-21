-- RepoSwipe · per-user synced state (Stack, groups, achievements, settings — never AI keys or GitHub tokens).
-- One row per signed-in user. Row-level security: a user can only ever read/write their own row.
-- Run once in Supabase → SQL Editor → Run.

create table if not exists public.reposwipe_user_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  state      jsonb not null default '{}'::jsonb,
  version    integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.reposwipe_user_state enable row level security;

create policy "own state select" on public.reposwipe_user_state
  for select to authenticated using (auth.uid() = user_id);
create policy "own state insert" on public.reposwipe_user_state
  for insert to authenticated with check (auth.uid() = user_id);
create policy "own state update" on public.reposwipe_user_state
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own state delete" on public.reposwipe_user_state
  for delete to authenticated using (auth.uid() = user_id);

-- keep rows sane (a Stack of a few thousand repos is ~1–2 MB); hard cap 4 MB
alter table public.reposwipe_user_state
  add constraint reposwipe_user_state_size check (pg_column_size(state) < 4194304);

grant select, insert, update, delete on public.reposwipe_user_state to authenticated;
