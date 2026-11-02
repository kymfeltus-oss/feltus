-- FELTUS CODE additive schema.
-- Adapt RLS policies to the existing FELTUS project-membership conventions.

create table if not exists feltus_code_sessions (
  id uuid primary key,
  project_id uuid not null,
  owner_id uuid not null,
  title text not null default 'Code session',
  repo_ref text,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE','ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_feltus_code_sessions_project
  on feltus_code_sessions(project_id, updated_at desc);

create table if not exists feltus_code_actions (
  id uuid primary key,
  session_id uuid not null references feltus_code_sessions(id) on delete cascade,
  project_id uuid not null,
  actor_id uuid not null,
  action_type text not null,
  target_path text,
  task_name text,
  summary text,
  result_status text,
  created_at timestamptz not null default now()
);

create index if not exists idx_feltus_code_actions_session
  on feltus_code_actions(session_id, created_at desc);

create table if not exists feltus_code_checkpoints (
  id uuid primary key,
  session_id uuid not null references feltus_code_sessions(id) on delete cascade,
  project_id uuid not null,
  actor_id uuid not null,
  git_commit text,
  label text,
  created_at timestamptz not null default now()
);

alter table feltus_code_sessions enable row level security;
alter table feltus_code_actions enable row level security;
alter table feltus_code_checkpoints enable row level security;

-- Intentionally no permissive policies.
-- Tables remain fail-closed until integrated with existing FELTUS RLS helpers.
