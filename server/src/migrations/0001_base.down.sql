-- Development only: removes every table 0001 creates (and all data). The vector extension is left installed.
drop table if exists llm_cache, llm_calls, settings, profile_buckets, memory_edges, memories, chunks, documents, namespaces cascade;
