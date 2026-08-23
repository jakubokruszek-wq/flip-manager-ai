import assert from "node:assert/strict";
import test from "node:test";
import { resolveSupabaseAdminKey } from "./supabase-admin-key.ts";

const secret = `sb_secret_${"s".repeat(32)}`;
const legacy = `${"a".repeat(40)}.${"b".repeat(80)}.${"c".repeat(40)}`;

test("valid server secret has precedence over legacy key", () => assert.equal(resolveSupabaseAdminKey(secret, legacy), secret));
test("invalid placeholder is not treated as configured secret", () => assert.equal(resolveSupabaseAdminKey("placeholder", legacy), legacy));
test("missing usable admin credentials returns null", () => assert.equal(resolveSupabaseAdminKey("placeholder", "bad"), null));
