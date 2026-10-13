/**
 * Read-only guard for diagnostics against a real Supabase project.
 *
 * Wraps a Supabase client so that every query builder refuses insert, update,
 * upsert and delete before a request is built, and the client refuses rpc,
 * storage, functions and realtime. Every successful SELECT result can be
 * recorded (table -> rows), which is how the exact rows the Finder read are
 * exported for a replay test. Nothing here can write to the database.
 */

export class ReadOnlyViolationError extends Error {
  constructor(target: string) {
    super(`READ-ONLY: operacja ${target} jest zablokowana w diagnostyce.`);
    this.name = "ReadOnlyViolationError";
  }
}

const WRITE_METHODS = new Set<PropertyKey>(["insert", "update", "upsert", "delete"]);
const BLOCKED_CLIENT_MEMBERS = new Set<PropertyKey>(["rpc", "storage", "functions", "channel", "realtime", "removeChannel", "removeAllChannels"]);

export type SelectRecorder = (table: string, rows: readonly Record<string, unknown>[]) => void;

type FromClient = { from: (table: string) => unknown };

export function readOnlySupabase<T extends FromClient>(client: T, record?: SelectRecorder): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (BLOCKED_CLIENT_MEMBERS.has(prop)) {
        return () => { throw new ReadOnlyViolationError(String(prop)); };
      }
      if (prop === "from") return (table: string) => wrapBuilder(target.from(table), table, record);
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapBuilder(builder: unknown, table: string, record?: SelectRecorder): unknown {
  if (!builder || typeof builder !== "object") return builder;
  return new Proxy(builder as object, {
    get(target, prop) {
      if (WRITE_METHODS.has(prop)) {
        return () => { throw new ReadOnlyViolationError(`${table}.${String(prop)}`); };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === "then" && typeof value === "function") {
        return (onFulfilled?: (result: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          (value as (resolve: (result: unknown) => unknown) => Promise<unknown>).call(target, (result: unknown) => {
            const data = (result as { data?: unknown } | null)?.data;
            if (record && data) record(table, (Array.isArray(data) ? data : [data]) as Record<string, unknown>[]);
            return result;
          }).then(onFulfilled, onRejected);
      }
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = (value as (...inner: unknown[]) => unknown).apply(target, args);
        return result && typeof result === "object" && "then" in result ? wrapBuilder(result, table, record) : result;
      };
    },
  });
}
