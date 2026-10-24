drop index entities_aliases;
drop index memory_entities_memory;
alter table namespaces drop column inject_sensitive;
alter table documents drop column dreamed_chars, drop column dreamed_hash;
drop index memories_subject;
alter table memories drop column slot;
