alter table documents drop column redactions;
drop table review_items, memory_entities, entities, memory_events;
alter table llm_calls drop column dream_run_id;
drop table dream_runs;
