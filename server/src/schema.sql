create extension if not exists vector;

create table if not exists namespaces (
  id text primary key,
  supporting_context text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists documents (
  pk bigserial primary key,
  ns text not null references namespaces(id) on delete cascade,
  id text not null,                         -- public id: caller's stable id or generated
  title text,
  type text not null default 'text',
  url text,
  raw text not null,                        -- what the caller sent
  content text,                             -- extracted text
  content_hash text,
  status text not null default 'queued',    -- queued|extracting|chunking|embedding|indexing|done|failed
  error text,
  task_type text not null default 'memory', -- memory|superrag
  dreaming text not null default 'dynamic', -- dynamic|instant
  supporting_context text,
  metadata jsonb not null default '{}',
  doc_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ns, id)
);
create index if not exists documents_queue on documents (status, created_at) where status = 'queued';

create table if not exists chunks (
  id bigserial primary key,
  document_pk bigint not null references documents(pk) on delete cascade,
  ns text not null,
  position int not null,
  content text not null,
  embedding vector(768) not null,
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  created_at timestamptz not null default now()
);
create index if not exists chunks_embedding on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_fts on chunks using gin (fts);
create index if not exists chunks_ns on chunks (ns);

-- Phase 2: memories (atomic facts) + typed relations between them
alter table documents add column if not exists dreaming_status text not null default 'done'; -- dreaming|done

create table if not exists memories (
  pk bigserial primary key,
  id text not null unique default gen_random_uuid()::text,
  ns text not null references namespaces(id) on delete cascade,
  content text not null,
  kind text not null default 'fact',         -- fact (persists until updated) | preference (strengthens) | episode (decays)
  is_latest boolean not null default true,
  is_inference boolean not null default false,
  is_forgotten boolean not null default false,
  forget_after timestamptz,
  forget_reason text,
  strength real not null default 1,
  version int not null default 1,
  root_id text,                              -- first version's id; groups a version chain
  metadata jsonb not null default '{}',
  source_document_pk bigint references documents(pk) on delete set null,
  embedding vector(768) not null,
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists memories_embedding on memories using hnsw (embedding vector_cosine_ops);
create index if not exists memories_fts on memories using gin (fts);
create index if not exists memories_ns_live on memories (ns) where is_latest and not is_forgotten;

create table if not exists memory_edges (
  src bigint not null references memories(pk) on delete cascade,  -- the newer memory
  dst bigint not null references memories(pk) on delete cascade,  -- the memory it updates/extends/derives from
  rel text not null,                                               -- updates|extends|derives
  primary key (src, dst, rel)
);
create index if not exists memory_edges_dst on memory_edges (dst);

-- Phase 3: profile buckets (topical sections) assigned at extraction time
alter table memories add column if not exists bucket text;
create table if not exists profile_buckets (
  ns text not null references namespaces(id) on delete cascade,
  name text not null,
  description text not null,
  primary key (ns, name)
);

-- Phase 4: tiny key/value store (MCP active space)
create table if not exists settings (key text primary key, value text not null);
