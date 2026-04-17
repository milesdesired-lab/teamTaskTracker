-- ═══════════════════════════════════════════════════════════
-- TEAM TASK TRACKER — Run this in your NEW Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- 1. TEAMS
create table teams (
  id                uuid        default gen_random_uuid() primary key,
  name              text        not null,
  code              text        not null unique,
  leader_pin        text        not null,
  approval_required boolean     default false,
  created_at        timestamptz default now()
);

-- 2. MEMBERS
create table members (
  id                uuid        default gen_random_uuid() primary key,
  team_id           uuid        not null references teams(id) on delete cascade,
  name              text        not null,
  role              text        not null default 'member' check (role in ('leader', 'member')),
  whatsapp_number   text        default null,
  created_at        timestamptz default now()
);

-- 3. TASKS
create table tasks (
  id                uuid        default gen_random_uuid() primary key,
  team_id           uuid        not null references teams(id) on delete cascade,
  created_by        uuid        not null references members(id) on delete cascade,
  assigned_to       uuid        not null references members(id) on delete cascade,
  text              text        not null,
  done              boolean     default false,
  urgent            boolean     default false,
  approved          boolean     default true,
  deadline_type     text        default 'today' check (deadline_type in ('today', 'date')),
  deadline_date     date        default current_date,
  deadline_time     time        default null,
  reminder_sent     boolean     default false,
  created_at        timestamptz default now()
);

-- 4. INDEXES
create index idx_tasks_team     on tasks(team_id);
create index idx_tasks_assigned on tasks(assigned_to);
create index idx_tasks_date     on tasks(deadline_date);
create index idx_tasks_pending  on tasks(team_id, approved) where approved = false;
create index idx_members_team   on members(team_id);
create index idx_teams_code     on teams(code);

-- 5. ROW LEVEL SECURITY (open for PoC)
alter table teams   enable row level security;
alter table members enable row level security;
alter table tasks   enable row level security;

create policy "allow all on teams"   on teams   for all using (true) with check (true);
create policy "allow all on members" on members for all using (true) with check (true);
create policy "allow all on tasks"   on tasks   for all using (true) with check (true);

-- 6. STORAGE BUCKET for monthly reports
insert into storage.buckets (id, name, public)
values ('reports', 'reports', true)
on conflict (id) do nothing;

create policy "Public read on reports"
  on storage.objects for select
  using (bucket_id = 'reports');

create policy "Service role write on reports"
  on storage.objects for all
  using (bucket_id = 'reports')
  with check (bucket_id = 'reports');
