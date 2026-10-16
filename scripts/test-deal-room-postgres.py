"""Destructive bootstrap ONLY on a fixed disposable CI PostgreSQL endpoint."""
import os
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb

if os.environ.get('GITHUB_ACTIONS') != 'true' and os.environ.get('DEAL_ROOM_ISOLATED_TESTS') != '1':
    raise SystemExit('ISOLATED_TESTS_REQUIRED')
DSN = 'host=127.0.0.1 port=55438 dbname=deal_room_test user=deal_test password=isolated-only connect_timeout=5'
ROOT = Path(__file__).resolve().parents[1]
OWNER = str(uuid.uuid4())
OTHER = str(uuid.uuid4())
NOW = '2026-10-15T12:00:00+00:00'

class DealRoomSql(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with psycopg.connect(DSN, autocommit=True) as c:
            c.execute("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create table public.listings(id uuid primary key, updated_at timestamptz)")
            c.execute('grant select, update on public.listings to service_role')
            c.execute('insert into auth.users values (%s),(%s)', (OWNER, OTHER))
            for name in ['20260912120000_create_investment_os_phase1.sql', '20260912150000_investment_os_foundation.sql', '20260912180000_investment_os_deal_cas.sql']:
                c.execute((ROOT / 'supabase/migrations' / name).read_text())
            c.execute((ROOT / 'supabase/drafts/deal-room-qa.sql').read_text())
    def setUp(self):
        self.deal, self.listing = str(uuid.uuid4()), str(uuid.uuid4())
        with psycopg.connect(DSN) as c:
            c.execute('insert into listings values (%s,%s)', (self.listing, NOW))
            c.execute("insert into deals(id,listing_id,facts_fingerprint,source_updated_at) values (%s,%s,'synthetic',%s)", (self.deal,self.listing,NOW))
    def write(self, request=None, owner=OWNER, version=1, hash_value='a'*64, valid=True):
        request = request or str(uuid.uuid4())
        deal = dict(id=self.deal, listing_id=self.listing, stage='VERIFYING', facts_fingerprint='after', facts={}, scout={},verify={},market={},underwriting={},ceo={},playbook={},evidence_fabric=[],information_requests=[],analysis_level=1)
        response = dict(ok=True,deal=dict(id=self.deal),room=dict(version=version+1 if valid else -1))
        with psycopg.connect(DSN) as c:
            c.execute('set local role service_role')
            return c.execute('select commit_deal_room_round_cas(%s,%s,%s,%s,%s,%s,%s,%s,%s)', (Jsonb(deal), version,NOW,owner,request,hash_value,Jsonb({'askingPrice':260000}),Jsonb({'answers':{'askingPrice':{'value':260000}},'rounds':[]}),Jsonb(response))).fetchone()[0]
    def test_replay_and_restart(self):
        request = str(uuid.uuid4())
        first = self.write(request)
        self.assertEqual(first, self.write(request))
        with psycopg.connect(DSN) as c:
            self.assertEqual(c.execute('select version from deals where id=%s',(self.deal,)).fetchone()[0],2)
            self.assertEqual(str(c.execute('select deal_room_owner_id from deals where id=%s',(self.deal,)).fetchone()[0]),OWNER)
            self.assertEqual(c.execute('select count(*) from deal_room_rounds where deal_id=%s',(self.deal,)).fetchone()[0],1)
            self.assertEqual(c.execute('select state from deal_room_workspaces where deal_id=%s',(self.deal,)).fetchone()[0]['answers']['askingPrice']['value'],260000)
    def test_different_payload_same_id_conflicts(self):
        request=str(uuid.uuid4()); self.write(request)
        with self.assertRaisesRegex(psycopg.Error,'VERSION_CONFLICT'): self.write(request,hash_value='b'*64)
    def test_other_owner_denied(self):
        self.write()
        with self.assertRaisesRegex(psycopg.Error,'DEAL_ROOM_NOT_FOUND'): self.write(owner=OTHER,version=2)
    def test_atomic_rollback(self):
        with self.assertRaisesRegex(psycopg.Error,'DEAL_ROOM_INVALID'): self.write(valid=False)
        with psycopg.connect(DSN) as c:
            self.assertEqual(c.execute('select version from deals where id=%s',(self.deal,)).fetchone()[0],1)
            self.assertEqual(c.execute('select count(*) from deal_room_rounds where deal_id=%s',(self.deal,)).fetchone()[0],0)
            self.assertEqual(c.execute('select count(*) from deal_fact_overrides where deal_id=%s',(self.deal,)).fetchone()[0],0)
    def test_source_snapshot_fence(self):
        with psycopg.connect(DSN) as c: c.execute("update listings set updated_at='2026-10-16' where id=%s",(self.listing,))
        with self.assertRaisesRegex(psycopg.Error,'VERSION_CONFLICT'): self.write()
    def test_two_concurrent_saves_one_winner(self):
        def attempt(_):
            try: self.write(); return 'won'
            except psycopg.Error as e:
                if 'VERSION_CONFLICT' not in str(e): raise
                return 'lost'
        with ThreadPoolExecutor(max_workers=2) as pool: self.assertEqual(sorted(pool.map(attempt,range(2))),['lost','won'])
    def test_concurrent_first_owners_one_winner(self):
        def attempt(owner):
            try: self.write(owner=owner); return 'won'
            except psycopg.Error as e:
                if 'DEAL_ROOM_NOT_FOUND' not in str(e): raise
                return 'lost'
        with ThreadPoolExecutor(max_workers=2) as pool: self.assertEqual(sorted(pool.map(attempt,[OWNER,OTHER])),['lost','won'])
    def test_rls_and_grants(self):
        self.write()
        for role in ['anon','authenticated']:
            for table in ['deal_room_workspaces','deal_room_rounds']:
                with psycopg.connect(DSN) as c:
                    c.execute(f'set local role {role}')
                    with self.assertRaises(psycopg.errors.InsufficientPrivilege): c.execute(f'select * from {table}')
            with psycopg.connect(DSN) as c:
                self.assertFalse(c.execute("select has_function_privilege(%s,'public.commit_deal_room_round_cas(jsonb,integer,timestamptz,uuid,uuid,text,jsonb,jsonb,jsonb)','execute')",(role,)).fetchone()[0])
        with psycopg.connect(DSN) as c:
            c.execute('set local role service_role')
            with self.assertRaises(psycopg.errors.InsufficientPrivilege): c.execute('delete from deal_room_rounds')

if __name__ == '__main__': unittest.main(verbosity=2)
