-- 0005 Review inbox (P5): inferences made before P3 queued no review_items row, so they would be missing from the
-- inbox. Queue one for each inference still pending review.
insert into review_items (ns, kind, memory_pk, payload, created_at)
select m.ns, 'inference', m.pk, '{"backfilled": true}', m.created_at
from memories m
where m.is_inference and m.status = 'pending_review'
  and not exists (select 1 from review_items r where r.memory_pk = m.pk and r.kind = 'inference');
