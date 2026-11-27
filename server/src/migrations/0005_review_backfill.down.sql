delete from review_items where kind = 'inference' and payload @> '{"backfilled": true}' and status = 'open';
