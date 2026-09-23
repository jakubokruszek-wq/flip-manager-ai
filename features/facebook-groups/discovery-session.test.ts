import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";

type Row = { id: string; token_hash: string; device_id: string | null; candidates: unknown[]; expires_at: string; consumed_at: string | null };

/**
 * A minimal fake matching only the exact query shapes discovery-session.ts
 * issues against facebook_group_discovery_sessions: insert().select().
 * single(), delete().lt(expires_at), select().eq(id).maybeSingle(), and
 * update().eq(id).is(consumed_at, null). Not a general-purpose Supabase
 * double -- this table's real query surface is small and worth modeling
 * directly, matching the convention already used for gallery-request-trace
 * and the OLX watchdog in this same codebase.
 */
function fakeAdmin(rows: Row[] = []) {
  const client = {
    from(table: string) {
      assert.equal(table, "facebook_group_discovery_sessions");
      return {
        insert(payload: Record<string, unknown>) {
          return {
            select() {
              return {
                async single() {
                  const row: Row = { id: randomUUID(), token_hash: String(payload.token_hash), device_id: (payload.device_id as string | null) ?? null, candidates: (payload.candidates as unknown[]) ?? [], expires_at: String(payload.expires_at), consumed_at: null };
                  rows.push(row);
                  return { data: { id: row.id }, error: null };
                },
              };
            },
          };
        },
        delete() {
          return {
            async lt(column: string, value: string) {
              for (let i = rows.length - 1; i >= 0; i -= 1) {
                if (String((rows[i] as unknown as Record<string, unknown>)[column]) < value) rows.splice(i, 1);
              }
              return { error: null };
            },
          };
        },
        select() {
          return {
            eq(_column: string, id: string) {
              return {
                async maybeSingle() {
                  const row = rows.find((item) => item.id === id) ?? null;
                  return { data: row, error: null };
                },
              };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(_column: string, id: string) {
              return {
                is(column: string, value: unknown) {
                  return (async () => {
                    const row = rows.find((item) => item.id === id && (item as unknown as Record<string, unknown>)[column] === value);
                    if (row) Object.assign(row, patch);
                    return { error: null };
                  })();
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, rows };
}

let currentFake = fakeAdmin();
mock.module("@/features/facebook-watcher/supabase-admin", { namedExports: { createFacebookWatcherAdminClient: () => currentFake.client } });

const { createDiscoverySession, resolveDiscoverySessionToken, markDiscoverySessionConsumed, MAX_DISCOVERY_CANDIDATES } = await import("./discovery-session.ts");

function candidate(url = "https://www.facebook.com/groups/999888777/") {
  return { url, name: "Test Group", discoveredAt: new Date().toISOString() };
}

test("a created session's token resolves back to the exact stored candidates", async () => {
  currentFake = fakeAdmin();
  const { token, expiresAt } = await createDiscoverySession([candidate()], "device-1");
  assert.ok(token.includes("."));
  assert.ok(!Number.isNaN(Date.parse(expiresAt)));
  const session = await resolveDiscoverySessionToken(token);
  assert.ok(session);
  assert.equal(session.candidates.length, 1);
  assert.equal(session.candidates[0].url, "https://www.facebook.com/groups/999888777/");
});

test("a wrong secret for a real session id is rejected", async () => {
  currentFake = fakeAdmin();
  const { token } = await createDiscoverySession([candidate()], null);
  const sessionId = token.split(".")[0];
  const tampered = `${sessionId}.${"0".repeat(64)}`;
  assert.equal(await resolveDiscoverySessionToken(tampered), null);
});

test("a token for a nonexistent session id is rejected", async () => {
  currentFake = fakeAdmin();
  const fakeId = "00000000-0000-4000-8000-000000000000";
  assert.equal(await resolveDiscoverySessionToken(`${fakeId}.${"a".repeat(64)}`), null);
});

test("a malformed token (no separator, wrong lengths) is rejected without ever querying", async () => {
  currentFake = fakeAdmin();
  assert.equal(await resolveDiscoverySessionToken("not-a-token"), null);
  assert.equal(await resolveDiscoverySessionToken(""), null);
  assert.equal(await resolveDiscoverySessionToken("a.b"), null);
});

test("an expired session is rejected even though its row still exists", async () => {
  currentFake = fakeAdmin();
  const { token } = await createDiscoverySession([candidate()], null);
  const sessionId = token.split(".")[0];
  const row = currentFake.rows.find((item) => item.id === sessionId)!;
  row.expires_at = new Date(Date.now() - 60_000).toISOString();
  assert.equal(await resolveDiscoverySessionToken(token), null);
});

test("creating a new session opportunistically deletes already-expired sessions", async () => {
  currentFake = fakeAdmin([{ id: "stale-1", token_hash: "x".repeat(64), device_id: null, candidates: [], expires_at: new Date(Date.now() - 60_000).toISOString(), consumed_at: null }]);
  await createDiscoverySession([candidate()], null);
  assert.equal(currentFake.rows.some((row) => row.id === "stale-1"), false);
});

test("two different sessions never see each other's candidates (cross-session isolation)", async () => {
  currentFake = fakeAdmin();
  const a = await createDiscoverySession([candidate("https://www.facebook.com/groups/111/")], null);
  const b = await createDiscoverySession([candidate("https://www.facebook.com/groups/222/")], null);
  const sessionA = await resolveDiscoverySessionToken(a.token);
  const sessionB = await resolveDiscoverySessionToken(b.token);
  assert.equal(sessionA?.candidates[0]?.url, "https://www.facebook.com/groups/111/");
  assert.equal(sessionB?.candidates[0]?.url, "https://www.facebook.com/groups/222/");
});

test("markDiscoverySessionConsumed sets consumed_at exactly once, idempotently", async () => {
  currentFake = fakeAdmin();
  const { token } = await createDiscoverySession([candidate()], null);
  const sessionId = token.split(".")[0];
  await markDiscoverySessionConsumed(sessionId);
  const firstConsumedAt = currentFake.rows.find((row) => row.id === sessionId)?.consumed_at;
  assert.ok(firstConsumedAt);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await markDiscoverySessionConsumed(sessionId);
  assert.equal(currentFake.rows.find((row) => row.id === sessionId)?.consumed_at, firstConsumedAt, "a second consume call must never overwrite the first consumed_at");
});

test("a consumed-but-not-expired session can still be resolved (consumption is an audit trail, not a hard lock -- safe retry stays possible)", async () => {
  currentFake = fakeAdmin();
  const { token } = await createDiscoverySession([candidate()], null);
  const sessionId = token.split(".")[0];
  await markDiscoverySessionConsumed(sessionId);
  const session = await resolveDiscoverySessionToken(token);
  assert.ok(session);
  assert.ok(session.consumedAt);
});

test("creating a session with more than the bounded candidate count is rejected", async () => {
  currentFake = fakeAdmin();
  const many = Array.from({ length: MAX_DISCOVERY_CANDIDATES + 1 }, (_, i) => candidate(`https://www.facebook.com/groups/${i}/`));
  await assert.rejects(() => createDiscoverySession(many, null), /DISCOVERY_TOO_MANY_CANDIDATES/);
});
