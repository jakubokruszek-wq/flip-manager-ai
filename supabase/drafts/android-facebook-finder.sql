-- OPTIONAL DRAFT. Only for isolated verification. Never auto-migrated/deployed.
begin;
create table public.android_facebook_post_receipts (
 job_id uuid not null references public.facebook_scan_jobs(id) on delete cascade,
 post_id text not null check(post_id ~ '^[0-9]{5,30}$'),
 payload_hash text not null check(payload_hash ~ '^[a-f0-9]{64}$'),
 result jsonb not null, created_at timestamptz not null default now(),
 primary key(job_id,post_id)
);
alter table public.android_facebook_post_receipts enable row level security;
revoke all on public.android_facebook_post_receipts from public,anon,authenticated;
grant select,insert on public.android_facebook_post_receipts to service_role;

create function public.persist_android_facebook_finder_post(
 p_job_id uuid,p_device_id uuid,p_lease_token uuid,p_completion_id uuid,p_payload_hash text,
 p_post_id text,p_listing jsonb,p_metadata jsonb,p_decision jsonb,p_checked_at timestamptz
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 j public.facebook_scan_jobs%rowtype; previous public.listings%rowtype;
 incoming public.listings%rowtype; saved_id uuid; inserted boolean;
 saved_receipt public.android_facebook_post_receipts%rowtype;
 canonical record; outcome jsonb; created_count integer:=0; updated_count integer:=0;
 duplicate_count integer:=0; price_drop integer:=0; match_created boolean:=false; matched boolean:=false;
begin
 select * into j from public.facebook_scan_jobs where id=p_job_id for share;
 if j.id is null or j.consumer_type<>'ANDROID_WEBVIEW' or j.job_type<>'SOURCE_SCAN'
   or j.status<>'running' or j.worker_id is distinct from p_device_id::text
   or j.lease_token is distinct from p_lease_token or j.android_completion_id is distinct from p_completion_id
   or p_completion_id is null or p_payload_hash is null
   or j.android_payload_hash is distinct from p_payload_hash or j.android_completion_state is distinct from 'in_progress'
   or not exists(select 1 from public.collector_devices where id=p_device_id and consumer_type='ANDROID_WEBVIEW' and revoked_at is null)
   or not exists(select 1 from public.collector_android_source_grants g join public.watched_facebook_groups s on s.id=g.watched_group_id
     where g.device_id=p_device_id and g.search_filter_id=j.search_filter_id and s.id::text=j.group_snapshot->0->>'id'
       and (g.expires_at is null or g.expires_at>clock_timestamp()))
 then raise exception 'ANDROID_FINDER_OWNER_LOST' using errcode='42501'; end if;
 if p_post_id is null or p_post_id !~ '^[0-9]{5,30}$' or p_checked_at is null
   or coalesce(j.group_snapshot->0->>'type','') not in ('GROUP','PROFILE')
   or nullif(j.group_snapshot->0->>'sourceId','') is null
   or p_decision->>'bucket' is null
   or p_listing->>'source' is distinct from 'facebook'
   or p_metadata->'metadata'->>'postId' is distinct from p_post_id
   or p_metadata->>'source_post_url' is distinct from p_listing->>'normalized_url'
   or p_metadata->'metadata'->>'groupId' is distinct from j.group_snapshot->0->>'sourceId'
   or p_listing->>'normalized_url' !~ '^https://(www[.])?facebook[.]com/'
   or not ((p_listing->>'normalized_url') ~ ('/(posts|permalink)/'||p_post_id||'/?$')
     or (p_listing->>'normalized_url') ~ ('/(permalink|story)[.]php[?]([^#]*&)?story_fbid='||p_post_id||'(&|$)'))
 then raise exception 'ANDROID_FINDER_IDENTITY_INVALID' using errcode='22023'; end if;
 if (j.group_snapshot->0->>'type'='GROUP' and strpos(p_listing->>'normalized_url','facebook.com/groups/'||(j.group_snapshot->0->>'sourceId')||'/')=0)
   or (j.group_snapshot->0->>'type'='PROFILE' and
     strpos(p_listing->>'normalized_url','facebook.com/'||(j.group_snapshot->0->>'sourceId')||'/posts/')=0 and
     substring(p_listing->>'normalized_url' from '[?&]id=([^&]+)') is distinct from j.group_snapshot->0->>'sourceId')
 then raise exception 'ANDROID_FINDER_SOURCE_MISMATCH' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('android-finder-post:'||p_job_id::text||':'||p_post_id,0));
 select * into saved_receipt from public.android_facebook_post_receipts where job_id=p_job_id and post_id=p_post_id;
 if found then
   if saved_receipt.payload_hash<>p_payload_hash then raise exception 'ANDROID_FINDER_RECEIPT_CONFLICT'; end if;
   return saved_receipt.result;
 end if;
 incoming:=jsonb_populate_record(null::public.listings,p_listing);
 if incoming.external_listing_id is null or incoming.original_url is null or incoming.normalized_url is null
 then raise exception 'ANDROID_FINDER_IDENTITY_MISSING'; end if;
 perform pg_advisory_xact_lock(hashtextextended('facebook-listing:'||incoming.external_listing_id,0));
 select * into previous from public.listings where source='facebook' and external_listing_id=incoming.external_listing_id for update;
 -- Preserve historical rows and explicit operator decisions.
 if previous.lifecycle_status='ARCHIVED' then
   saved_id:=previous.id; duplicate_count:=1;
 else
   insert into public.listings as target(source,external_listing_id,original_url,normalized_url,title,price,area,price_per_sqm,rooms,floor,
     building_type,ownership,address,district,city,description,images,status,last_seen_at,content_hash,flip_score)
   values('facebook',incoming.external_listing_id,incoming.original_url,incoming.normalized_url,incoming.title,incoming.price,incoming.area,
     incoming.price_per_sqm,incoming.rooms,incoming.floor,incoming.building_type,incoming.ownership,incoming.address,incoming.district,
     incoming.city,incoming.description,coalesce(incoming.images,'[]'::jsonb),'active',p_checked_at,incoming.content_hash,incoming.flip_score)
   on conflict(source,external_listing_id) do update set
     original_url=excluded.original_url,normalized_url=excluded.normalized_url,title=excluded.title,price=excluded.price,area=excluded.area,
     price_per_sqm=excluded.price_per_sqm,rooms=excluded.rooms,floor=excluded.floor,
     building_type=coalesce(excluded.building_type,target.building_type),ownership=coalesce(excluded.ownership,target.ownership),
     address=excluded.address,district=excluded.district,city=excluded.city,description=excluded.description,
     images=case when jsonb_array_length(excluded.images)>0 then excluded.images else target.images end,
     last_seen_at=p_checked_at,content_hash=excluded.content_hash,flip_score=excluded.flip_score
   where target.lifecycle_status is distinct from 'ARCHIVED' and (target.content_hash is distinct from excluded.content_hash or target.price is distinct from excluded.price)
   returning id,(xmax=0) into saved_id,inserted;
   if saved_id is null then
     select id into strict saved_id from public.listings where source='facebook' and external_listing_id=incoming.external_listing_id;
     duplicate_count:=1;
   elsif inserted then created_count:=1;
   else updated_count:=1; end if;
   if updated_count=1 and previous.price>incoming.price then price_drop:=1; end if;
   if created_count+updated_count>0 then
     insert into public.listing_snapshots(listing_id,price,title,description,images,status,raw_data)
     values(saved_id,incoming.price,incoming.title,incoming.description,coalesce(incoming.images,'[]'::jsonb),'active',
       coalesce(p_metadata->'metadata','{}'::jsonb)||jsonb_build_object('androidJobId',p_job_id));
   end if;
   select * into canonical from public.reconcile_canonical_listing_decision(saved_id,j.search_filter_id,
     p_decision->>'bucket',coalesce(p_decision->'reasons','[]'::jsonb),coalesce(p_decision->'missingFields','[]'::jsonb),
     case when p_decision->>'bucket'='MATCHED' then 'ACTIVE' else p_decision->>'bucket' end,'scan',j.source_scan_id,p_checked_at);
   match_created:=created_count=1 and coalesce(canonical.is_current_match,false);
   matched:=coalesce(canonical.is_current_match,false);
   insert into public.listing_source_metadata as metadata(listing_id,source,source_post_url,group_name,author_name,published_at,collected_at,metadata)
   values(saved_id,'facebook',p_metadata->>'source_post_url',p_metadata->>'group_name',p_metadata->>'author_name',
     nullif(p_metadata->>'published_at','')::timestamptz,p_checked_at,coalesce(p_metadata->'metadata','{}'::jsonb))
   on conflict(source,source_post_url) do update set listing_id=excluded.listing_id,group_name=excluded.group_name,
     author_name=coalesce(excluded.author_name,metadata.author_name),published_at=coalesce(excluded.published_at,metadata.published_at),
     collected_at=excluded.collected_at,metadata=metadata.metadata||excluded.metadata||
       jsonb_strip_nulls(jsonb_build_object('workflowStatus',metadata.metadata->'workflowStatus','firstImportedAt',metadata.metadata->'firstImportedAt','importedAt',metadata.metadata->'importedAt'));
   if created_count=1 then
     update public.watched_facebook_groups set imported_posts_count=imported_posts_count+1,new_today_count=new_today_count+1,
       opportunities_count=opportunities_count+case when incoming.flip_score>=85 or
         (p_metadata->'metadata'->>'sellerType'='private' and p_metadata->'metadata'->>'condition'='renovation') then 1 else 0 end
       where id::text=j.group_snapshot->0->>'id';
   end if;
 end if;
 outcome:=jsonb_build_object('listingId',saved_id,'created',created_count,'updated',updated_count,'duplicates',duplicate_count,
   'matched',matched,'matchCreated',match_created,'priceDrop',price_drop);
 insert into public.android_facebook_post_receipts(job_id,post_id,payload_hash,result) values(p_job_id,p_post_id,p_payload_hash,outcome);
 return outcome;
end; $$;
revoke all on function public.persist_android_facebook_finder_post(uuid,uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.persist_android_facebook_finder_post(uuid,uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,timestamptz) to service_role;
commit;
