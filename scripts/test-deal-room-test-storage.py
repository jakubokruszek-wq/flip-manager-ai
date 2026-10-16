"""Dedicated TEST store on FIXED disposable CI PG; never reads a configurable DSN."""
import os,unittest,uuid
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import psycopg
from psycopg.types.json import Jsonb
if os.environ.get('GITHUB_ACTIONS')!='true':raise SystemExit('CI_ONLY')
DSN='host=127.0.0.1 port=55438 dbname=deal_room_test user=deal_test password=isolated-only connect_timeout=5'
ROOT=Path(__file__).resolve().parents[1]
class TestStore(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  with psycopg.connect(DSN,autocommit=True) as c:
   c.execute((ROOT/'supabase/drafts/deal-room-test-storage.sql').read_text())
 def setUp(self):
  self.owner=str(uuid.uuid4());self.other=str(uuid.uuid4());self.case='deadbeef-'+str(uuid.uuid4())[9:]
  self.deal={'id':self.case,'listingId':self.case,'ceo':{'result':{'action':'HOLD / ZBIERZ DANE'}}}
  with psycopg.connect(DSN) as c:
   c.execute('insert into auth.users values (%s),(%s)',(self.owner,self.other))
   c.execute('insert into deal_room_test_cases(owner_id,case_id,deal,state) values (%s,%s,%s,%s)',(self.owner,self.case,Jsonb(self.deal),Jsonb({'answers':{},'rounds':[]})))
 def commit(self,request=None,owner=None,version=1,hash_value='a'*64,bad=False):
  state={'answers':{'renovationBudget':{'value':100000}},'rounds':[]}
  response={'deal':self.deal,'room':{**state,'version':version+1 if not bad else -1}}
  with psycopg.connect(DSN) as c:
   c.execute('set local role service_role')
   return c.execute('select deal_room_test_commit(%s,%s,%s,%s,%s,%s,%s,%s)',(owner or self.owner,self.case,version,request or str(uuid.uuid4()),hash_value,Jsonb(self.deal),Jsonb(state),Jsonb(response))).fetchone()[0]
 def test_cas_race(self):
  def attempt(_):
   try:self.commit();return 'ok'
   except psycopg.Error as e:return 'conflict' if 'VERSION_CONFLICT' in str(e) else str(e)
  with ThreadPoolExecutor(max_workers=2) as pool:self.assertCountEqual(list(pool.map(attempt,[1,2])),['ok','conflict'])
 def test_replay_after_lost_response(self):
  request=str(uuid.uuid4());first=self.commit(request);self.assertEqual(first,self.commit(request))
  with self.assertRaisesRegex(psycopg.Error,'VERSION_CONFLICT'):self.commit(request,hash_value='b'*64)
 def test_owner_fence_before_replay(self):
  request=str(uuid.uuid4());self.commit(request)
  with self.assertRaisesRegex(psycopg.Error,'TEST_NOT_FOUND'):self.commit(request,owner=self.other)
 def test_atomic_rollback(self):
  with self.assertRaisesRegex(psycopg.Error,'TEST_INVALID'):self.commit(bad=True)
  with psycopg.connect(DSN) as c:
   self.assertEqual(c.execute('select version from deal_room_test_cases where owner_id=%s and case_id=%s',(self.owner,self.case)).fetchone()[0],1)
   self.assertEqual(c.execute('select count(*) from deal_room_test_rounds where owner_id=%s',(self.owner,)).fetchone()[0],0)
 def test_no_browser_or_public_access(self):
  for role in ['anon','authenticated']:
   for table in ['deal_room_test_cases','deal_room_test_rounds']:
    with psycopg.connect(DSN) as c:
     c.execute(f'set local role {role}')
     with self.assertRaises(psycopg.errors.InsufficientPrivilege):c.execute(f'select * from {table}')
   with psycopg.connect(DSN) as c:
    self.assertFalse(c.execute("select has_function_privilege(%s,'public.deal_room_test_commit(uuid,uuid,integer,uuid,text,jsonb,jsonb,jsonb)','EXECUTE')",(role,)).fetchone()[0])
 def test_no_production_dependencies_or_triggers(self):
  with psycopg.connect(DSN) as c:
   self.assertEqual(c.execute("select count(*) from pg_trigger where tgrelid in ('deal_room_test_cases'::regclass,'deal_room_test_rounds'::regclass) and not tgisinternal").fetchone()[0],0)
   refs=c.execute("select confrelid::regclass::text from pg_constraint where conrelid in ('deal_room_test_cases'::regclass,'deal_room_test_rounds'::regclass) and contype='f'").fetchall()
   self.assertCountEqual([r[0] for r in refs],['auth.users','deal_room_test_cases'])
   self.assertEqual(c.execute("select count(*) from pg_class where oid in ('deal_room_test_cases'::regclass,'deal_room_test_rounds'::regclass) and relrowsecurity and relforcerowsecurity").fetchone()[0],2)
 def test_buy_and_missing_identity_refused(self):
  with psycopg.connect(DSN) as c:
   with self.assertRaises(psycopg.errors.CheckViolation):c.execute('insert into deal_room_test_cases(owner_id,case_id,deal,state) values (%s,%s,%s,%s)',(self.owner,'deadbeef-'+str(uuid.uuid4())[9:],Jsonb({}),Jsonb({})))
  self.deal['ceo']['result']['action']='KUP'
  with self.assertRaisesRegex(psycopg.Error,'TEST_INVALID'):self.commit()
if __name__=='__main__':unittest.main(verbosity=2)
