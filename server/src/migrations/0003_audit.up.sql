-- 0003 audit and v2 bookkeeping tables (PLAN.v2 §2). Memories are referenced by pk, like memory_edges.
create table dream_runs (
  id uuid primary key default gen_random_uuid(),
  ns text not null references namespaces(id) on delete cascade,
  document_pks bigint[] not null,
  pipeline_version text not null,
  status text not null default 'running',     -- running | done | failed
  stats jsonb not null default '{}',          -- candidates, added, updated, extended, duplicates, inferences
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index dream_runs_ns on dream_runs (ns, started_at);
alter table llm_calls add column dream_run_id uuid;

-- Every change to a memory: who did it and why. before/after hold only the fields that changed.
create table memory_events (
  id bigserial primary key,
  memory_pk bigint not null references memories(pk) on delete cascade,
  action text not null,   -- create|update|supersede|extend|derive|strengthen|decay|expire|forget|restore|approve|reject|edit
  actor text not null,    -- dreamer | api | sweeper | user
  reason text,
  before jsonb,
  after jsonb,
  pipeline_version text,
  dream_run_id uuid,
  at timestamptz not null default now()
);
create index memory_events_memory on memory_events (memory_pk, at);

create table entities (
  id text primary key default gen_random_uuid()::text,
  ns text not null references namespaces(id) on delete cascade,
  canonical_name text not null,
  type text not null,                         -- person | org | place | thing | ...
  aliases text[] not null default '{}',
  embedding vector(768),
  embedding_model text,
  created_at timestamptz not null default now(),
  unique (ns, type, canonical_name)
);
create table memory_entities (
  memory_pk bigint not null references memories(pk) on delete cascade,
  entity_id text not null references entities(id) on delete cascade,
  role text not null,                         -- subject | object | mention
  primary key (memory_pk, entity_id, role)
);
create index memory_entities_entity on memory_entities (entity_id);

create table review_items (
  id text primary key default gen_random_uuid()::text,
  ns text not null references namespaces(id) on delete cascade,
  kind text not null,                         -- inference | conflict | low_confidence
  memory_pk bigint references memories(pk) on delete cascade,
  related_memory_pk bigint references memories(pk) on delete cascade,
  payload jsonb not null default '{}',
  status text not null default 'open',        -- open | approved | rejected | merged
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index review_items_open on review_items (ns, created_at) where status = 'open';

-- Secret guard: what was redacted from a document (kinds and counts, never the values).
alter table documents add column redactions jsonb;
