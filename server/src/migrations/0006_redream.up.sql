-- 0006 Re-dream (P6): one row per run. The run replays a namespace's documents through the current pipeline into a
-- shadow namespace, and stores a diff report; swapping moves the old memories into an archive namespace.
create table redreams (
  id uuid primary key default gen_random_uuid(),
  ns text not null references namespaces(id) on delete cascade,
  shadow_ns text not null,
  status text not null default 'running',     -- running | ready | failed | swapped | discarded
  pipeline_version text not null,
  total int not null default 0,                -- documents to replay
  done int not null default 0,
  failed int not null default 0,
  report jsonb,
  archive_ns text,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index redreams_ns on redreams (ns, started_at);
