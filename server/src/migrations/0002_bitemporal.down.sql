alter table chunks drop column embedding_model;
alter table memories
  drop column valid_from, drop column valid_to, drop column learned_at, drop column speaker, drop column subject,
  drop column confidence, drop column source_span, drop column sensitivity, drop column status, drop column pinned,
  drop column pipeline_version, drop column dream_run_id, drop column embedding_model;
