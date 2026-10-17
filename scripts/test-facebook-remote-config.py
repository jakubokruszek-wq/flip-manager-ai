import unittest
from facebook_android_remote_store import validate_database

class RemoteDatabaseConfig(unittest.TestCase):
    def test_only_explicit_separate_project_and_verified_tls(self):
        env={"FLIP_TEST_PROJECT_REF":"abcdefghijklmnopqrst","FLIP_TEST_DATABASE_URL":"postgresql://postgres.abcdefghijklmnopqrst:synthetic-only@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"}
        config=validate_database(env)
        self.assertEqual(config["sslmode"],"verify-full")
        self.assertEqual(config["dbname"],"postgres")
        for replacement in ["postgresql://postgres.abcdefghijklmnopqrst:synthetic-only@evil.invalid/postgres",env["FLIP_TEST_DATABASE_URL"]+"?sslmode=disable",env["FLIP_TEST_DATABASE_URL"].replace("5432","6543")]:
            with self.assertRaises(ValueError): validate_database({**env,"FLIP_TEST_DATABASE_URL":replacement})
        with self.assertRaises(ValueError): validate_database({**env,"FLIP_TEST_PROJECT_REF":"zmuisdirvfcxrvtbvrle"})
        with self.assertRaises(ValueError): validate_database({})

if __name__ == "__main__": unittest.main()
