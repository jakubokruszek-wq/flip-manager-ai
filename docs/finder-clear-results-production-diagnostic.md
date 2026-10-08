# Finder clear-results — read-only history diagnosis

Production was not queried for this mission, and no clear request was sent. The saved snapshot (`is_current_match=true`, zero `finder_cleared` reasons, REVIEW rows) cannot prove whether the browser skipped the POST, the route rejected it, or a later scan recreated/changed memberships.

To classify the historical event, correlate Vercel request logs for the operator's browser session and the relevant time window. Required entries: GET of `/api/flip-finder/search-filters/6ebf3a9c-5418-4ae6-a0bf-1989b6603367/results`, POST of `/api/flip-finder/search-filters/6ebf3a9c-5418-4ae6-a0bf-1989b6603367/clear-results`, HTTP status/request ID and route error (especially the active-scan 409), then any scan/continuation requests and later results GET. The browser must also show that the confirmation button submitted once; do not infer submission from an opened dialog.

After correlating the time and run IDs, these read-only queries can determine whether the tombstones are now present and whether a later scan observation occurred. They do not by themselves prove which HTTP request was seen by the browser:

```sql
select m.search_filter_id, m.listing_id, m.is_current_match, m.match_origin,
       m.match_reasons, m.last_matched_at
from public.listing_filter_matches as m
where m.search_filter_id = '6ebf3a9c-5418-4ae6-a0bf-1989b6603367'
  and (m.is_current_match is true or m.match_reasons @> '["finder_cleared"]'::jsonb)
order by m.last_matched_at desc nulls last, m.listing_id;

select s.id, s.scan_run_id, s.source, s.status, s.started_at, s.finished_at,
       s.error_message, s.scanned_count, s.matched_count
from public.source_scans as s
where s.search_filter_id = '6ebf3a9c-5418-4ae6-a0bf-1989b6603367'
order by s.started_at desc
limit 200;
```

Interpretation: a correlated successful POST followed by `finder_cleared` rows is evidence the clear write landed; a 409/error log means the request was rejected; no request log is consistent with a client not sending it, but absence can also reflect retention/sampling. A later scan must be compared using its `started_at`/run ID and row timestamps against the database's stale-observation guard before calling it a restore. This mission makes no claim about that historical Production cause.
