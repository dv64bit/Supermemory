-- 0002 bi-temporal memories, speaker, confidence, provenance, review status, pipeline version (PLAN.v2 §2).
-- Backfill follows PRD.v2: valid_from = coalesce(doc_date, created_at), speaker = 'document', confidence = 0.7.
alter table memories
  add column valid_from timestamptz,          -- when the fact became true in the world (event time)
  add column valid_to timestamptz,            -- when it stopped being true (supersede or expiry)
  add column learned_at timestamptz not null default now(), -- when we ingested it (transaction time)
  add column speaker text,                    -- user | assistant | third_party | document
  add column subject text,                    -- canonical entity the fact is about
  add column confidence real,                 -- 0..1
  add column source_span jsonb,               -- {document_id, start, end, quote}
  add column sensitivity text,                -- none | personal | sensitive; null = not classified
  add column status text not null default 'active', -- active | pending_review | rejected
  add column pinned boolean not null default false,  -- user-authored/edited; survives re-dream untouched
  add column pipeline_version text,
  add column dream_run_id uuid,
  add column embedding_model text;
alter table chunks add column embedding_model text;

update memories m set
  valid_from = coalesce((select d.doc_date from documents d where d.pk = m.source_document_pk), m.created_at),
  learned_at = m.created_at,
  speaker = 'document',
  confidence = 0.7,
  status = case when m.forget_reason = 'declined in review' then 'rejected'
                when m.is_inference then 'pending_review' else 'active' end,
  embedding_model = 'Xenova/bge-base-en-v1.5';
-- Superseded memories end where their successor starts; expiring ones end at their expiry.
update memories old set valid_to = s.valid_from
from memory_edges e join memories s on s.pk = e.src
where e.rel = 'updates' and e.dst = old.pk;
update memories set valid_to = forget_after where valid_to is null and forget_after is not null;
update chunks set embedding_model = 'Xenova/bge-base-en-v1.5';
