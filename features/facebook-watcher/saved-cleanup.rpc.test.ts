import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const migration=fs.readFileSync("supabase/migrations/20261103063116_watcher_quality_saved_date_cleanup.sql","utf8");
test("saved-date cleanup previews, fences stale confirmation, protects CRM and prevents resurrection",async()=>{
 const db=new PGlite();
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create table listings(id uuid primary key,source text,external_listing_id text,created_at timestamptz);
   create table listing_source_metadata(listing_id uuid references listings on delete cascade,source text,source_post_url text,metadata jsonb default '{}');
   create table properties(listing_id uuid);create table deals(listing_id uuid);
   create table source_scans(source text,status text);create table facebook_scan_jobs(job_type text,status text);
   create table receipts(listing_id uuid references listings on delete set null,receipt text);
  `);
  await db.exec(migration);
  const ids=[1,2,3,4,5].map(n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`);
  for(let i=0;i<ids.length;i++){
   await db.query("insert into listings values($1,'facebook',$2,$3)",[ids[i],`facebook:post:55000000${i}`,i===1?'2026-11-02T00:00:00Z':'2026-10-01T00:00:00Z']);
   await db.query("insert into listing_source_metadata values($1,'facebook',$2,$3)",[ids[i],`https://www.facebook.com/groups/g/posts/55000000${i}/`,i===4?{crossSourceMatch:true}:{}]);
  }
  await db.query("insert into properties values($1)",[ids[2]]);await db.query("insert into deals values($1)",[ids[3]]);
  await db.query("insert into receipts values($1,'ack-remains')",[ids[0]]);
  const call=async(apply=false,token:string|null=null)=>(await db.query<{p: {token:string;total:number;protectedCount:number;listingIds:string[]}}>("select facebook_watcher_cleanup_saved_before('2026-11-01', $1,$2) p",[apply,token])).rows[0].p;
  const preview=await call();assert.equal(preview.total,1);assert.equal(preview.protectedCount,3);
  assert.equal((await db.query("select * from listings")).rows.length,5);
  await assert.rejects(()=>call(true,"wrong"),/CLEANUP_PREVIEW_CHANGED/);
  await db.exec("insert into source_scans values('facebook','running')");await assert.rejects(()=>call(true,preview.token),/ACTIVE_FACEBOOK_WORK/);await db.exec("delete from source_scans");
  assert.equal((await call(true,preview.token)).total,1);
  assert.equal((await db.query("select * from listings")).rows.length,4);
  assert.deepEqual((await db.query("select * from receipts")).rows,[{listing_id:null,receipt:'ack-remains'}]);
  await assert.rejects(()=>db.query("insert into listings values($1,'facebook','facebook:post:550000000',now())",[ids[0]]),/FACEBOOK_POST_REMOVED/);
  assert.equal((await call()).total,0);
  for(const role of ['anon','authenticated']){
   const privileges=await db.query<{allowed:boolean}>(`select has_function_privilege('${role}','public.facebook_watcher_cleanup_saved_before(timestamptz,boolean,text)','EXECUTE') allowed`);
   assert.equal(privileges.rows[0].allowed,false);
  }
 }finally{await db.close();}
});
