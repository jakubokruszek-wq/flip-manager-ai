import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("pilot_plan", Path(__file__).with_name("prepare-facebook-live-pilot.py"))
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)


class PilotPlan(unittest.TestCase):
    args = ("abcdefghijklmnopqrst", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "1234567890", 2000)

    def test_prints_additive_transaction_only(self):
        sql = plan.prepare(*self.args, now=1000)
        self.assertIn("offline_test_environment", sql)
        self.assertIn("PILOT_TEST_PROJECT_MISMATCH", sql)
        self.assertIn("max_attempts", sql)
        self.assertEqual(sql.count("insert into"), 5)
        for forbidden in ("delete from", "drop ", "truncate ", "update ", "alter table", "create table", "deviceToken"):
            self.assertNotIn(forbidden, sql)

    def test_rejects_production_existing_ids_and_group_injection(self):
        for index, value in ((0,"zmuisdirvfcxrvtbvrle"),(1,"00000000-0000-4000-8000-000000000001"),(3,"offline-lodz"),(3,"group';drop table x")):
            args=list(self.args);args[index]=value
            with self.assertRaises(ValueError): plan.prepare(*args,now=1000)

    def test_requires_new_short_approval(self):
        for expiry in (999,3601001):
            args=list(self.args);args[4]=expiry
            with self.assertRaises(ValueError): plan.prepare(*args,now=1000)


if __name__ == "__main__": unittest.main()
