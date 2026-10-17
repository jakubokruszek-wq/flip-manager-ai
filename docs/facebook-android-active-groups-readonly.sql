-- READ ONLY. Prepared but NOT executed successfully in this session.
-- Run only on the intended Flip Manager project using an authorized read-only session.
begin transaction isolation level repeatable read read only;
set local statement_timeout = '10s';

-- Registry metadata only; no active filters, device tokens or post content.
select id, name, url, enabled, priority, access_status, last_checked_at, last_error,
       count(*) over () as "activeGroupCount"
from public.watched_facebook_groups
where enabled = true
order by case priority when 'high' then 0 when 'normal' then 1 else 2 end, created_at, id;

-- Historical scan metrics only. Export ALL pages if scopeTotal exceeds the row count.
select coalesce(j.group_snapshot->0->>'sourceId',
                substring(j.group_snapshot->0->>'url' from '/groups/([^/?#]+)')) as "sourceId",
       coalesce(j.group_snapshot->0->>'type', 'GROUP') as "sourceType",
       coalesce(s.finished_at, j.finished_at) as "finishedAt",
       coalesce(s.status, j.status) as status,
       case when coalesce(s.finished_at, j.finished_at) is not null and coalesce(j.started_at, s.started_at) is not null
         then greatest(0, extract(epoch from (coalesce(s.finished_at, j.finished_at) - coalesce(j.started_at, s.started_at))) * 1000)
         else null end as "durationMs",
       s.listings_created as "listingsCreated", s.listings_updated as "listingsUpdated",
       j.consumer_type as "consumerType", j.error_code as "errorCode",
       count(*) over () as "scopeTotal"
from public.facebook_scan_jobs j
left join public.source_scans s on s.id = j.source_scan_id
where j.job_type = 'SOURCE_SCAN' and j.consumer_type in ('BROWSER_EXTENSION', 'ANDROID_WEBVIEW')
  and j.created_at >= now() - interval '14 days'
  and j.status in ('completed', 'failed')
order by coalesce(s.finished_at, j.finished_at) desc nulls last, j.id
limit 2000;
commit;
