-- 0004 Dreamer v2 (P3): slot for the one-latest-per-(subject, slot) invariant, what part of a document was already
-- dreamed (append-only re-ingests dream only the new part), and the per-namespace sensitive-injection policy.
alter table memories add column slot text; -- single-valued attribute the fact sets (employer, home_city); null = can coexist
create index memories_subject on memories (ns, lower(subject)) where is_latest;
alter table documents add column dreamed_chars int, add column dreamed_hash text;
alter table namespaces add column inject_sensitive boolean not null default false;
create index memory_entities_memory on memory_entities (memory_pk);
create index entities_aliases on entities using gin (aliases);
