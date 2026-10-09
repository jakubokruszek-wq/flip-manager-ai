/**
 * TEST-ONLY in-memory simulator of the subset of the Supabase-js query
 * builder used by the Facebook orphan-recovery path (server.ts,
 * persist-listing.ts, canonical-reconciliation.ts). Never imported by
 * application code — it exists purely so integration tests can drive the
 * REAL production orchestration functions (not a duplicate reimplementation
 * of their logic) through a controllable, inspectable "database" without
 * touching Production.
 *
 * It simulates the database's behavior (rows, upserts, an RPC), not the
 * application's decision logic: the canonical RPC handler installed by tests
 * mirrors what `reconcile_canonical_listing_decision` is documented to do
 * (upsert one listing_filter_matches row, update the listing's lifecycle
 * columns) so the real reconcileCanonicalListingDecision() function under
 * test still is, and remains, the only code path that decides membership.
 */

type Row = Record<string, unknown>;
/** Mirrors real Supabase/PostgREST's default max-rows response cap. */
const DEFAULT_SELECT_ROW_CAP = 1000;
type RpcResult = { data: unknown; error: { message: string } | null };
type RpcHandler = (params: Row) => RpcResult;
type QueryFailure = { message: string; code?: string };
type FailureRule = { op: "insert" | "update" | "upsert" | "select"; message: string; code?: string; remaining: number };
export type FakeDatabaseAccess = { kind: "table" | "rpc"; name: string };

export class FakeFacebookSupabase {
  private tables = new Map<string, Row[]>();
  private rpcHandlers = new Map<string, RpcHandler>();
  private rpcFailures = new Map<string, { message: string; remaining: number }[]>();
  private failures = new Map<string, FailureRule[]>();
  private accessLogEntries: FakeDatabaseAccess[] = [];
  private idSeq = 1;

  seed(table: string, rows: Row[]): this {
    this.tables.set(table, rows.map((row) => ({ ...row })));
    return this;
  }

  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }

  /** Records only application-facing Supabase calls; internal fake-table reads are not logged. */
  accessLog(): FakeDatabaseAccess[] {
    return [...this.accessLogEntries];
  }

  clearAccessLog(): void {
    this.accessLogEntries = [];
  }

  setRpc(name: string, handler: RpcHandler): this {
    this.rpcHandlers.set(name, handler);
    return this;
  }

  /** Forces the next count calls to a named RPC to fail before its handler runs. */
  failNextRpc(name: string, message: string, count = 1): this {
    const list = this.rpcFailures.get(name) ?? [];
    list.push({ message, remaining: count });
    this.rpcFailures.set(name, list);
    return this;
  }

  /** Forces the next `count` matching operations on `table` to fail with `message`, then behave normally again. */
  failNext(table: string, op: FailureRule["op"], message: string, count = 1, code?: string): this {
    const list = this.failures.get(table) ?? [];
    list.push({ op, message, code, remaining: count });
    this.failures.set(table, list);
    return this;
  }

  private consumeFailure(table: string, op: FailureRule["op"]): QueryFailure | null {
    const list = this.failures.get(table);
    const rule = list?.find((entry) => entry.op === op && entry.remaining > 0);
    if (!rule) return null;
    rule.remaining -= 1;
    return { message: rule.message, ...(rule.code ? { code: rule.code } : {}) };
  }

  private nextId(): string {
    return `fake-id-${this.idSeq++}`;
  }

  from(table: string): FakeQueryBuilder {
    this.accessLogEntries.push({ kind: "table", name: table });
    return new FakeQueryBuilder(this, table);
  }

  rpc(name: string, params: Row = {}): FakeRpcCall {
    this.accessLogEntries.push({ kind: "rpc", name });
    return new FakeRpcCall(this, name, params);
  }

  // Internal helpers used by FakeQueryBuilder / FakeRpcCall only.
  _table(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }
  _setTable(table: string, rows: Row[]): void {
    this.tables.set(table, rows);
  }
  _consumeFailure(table: string, op: FailureRule["op"]): QueryFailure | null {
    return this.consumeFailure(table, op);
  }
  _nextId(): string {
    return this.nextId();
  }
  _rpcHandler(name: string): RpcHandler | undefined {
    return this.rpcHandlers.get(name);
  }
  _consumeRpcFailure(name: string): string | null {
    const list = this.rpcFailures.get(name);
    const rule = list?.find((entry) => entry.remaining > 0);
    if (!rule) return null;
    rule.remaining -= 1;
    return rule.message;
  }
}

function splitTopLevelCommas(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of expression) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function matchesEqClause(row: Row, clause: string): boolean {
  const match = clause.match(/^([a-z_]+)\.eq\.(.*)$/i);
  if (!match) return false;
  const [, column, rawValue] = match;
  return String(row[column] ?? "") === rawValue;
}

class FakeQueryBuilder implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private readonly db: FakeFacebookSupabase;
  private readonly table: string;
  private filters: Array<(row: Row) => boolean> = [];
  private orExpression: string | null = null;
  private op: "select" | "insert" | "update" | "upsert" = "select";
  private payload: Row | null = null;
  private upsertPayload: Row[] | null = null;
  private onConflictColumns: string[] | null = null;
  private ignoreDuplicates = false;
  private limitCount: number | null = null;
  private rangeWindow: [number, number] | null = null;
  private wantsSelectBack = false;

  constructor(db: FakeFacebookSupabase, table: string) {
    this.db = db;
    this.table = table;
  }

  select(): this {
    this.wantsSelectBack = true;
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  neq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] !== value);
    return this;
  }
  gt(column: string, value: string): this {
    this.filters.push((row) => typeof row[column] === "string" && String(row[column]) > value);
    return this;
  }
  lt(column: string, value: string): this {
    this.filters.push((row) => typeof row[column] === "string" && String(row[column]) < value);
    return this;
  }
  gte(column: string, value: string): this {
    this.filters.push((row) => typeof row[column] === "string" && String(row[column]) >= value);
    return this;
  }
  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  or(expression: string): this {
    this.orExpression = expression;
    return this;
  }
  not(column: string, operator: string, value: unknown): this {
    if (operator === "is") this.filters.push((row) => row[column] !== value);
    return this;
  }
  is(column: string, value: unknown): this {
    this.filters.push((row) => value === null ? row[column] == null : row[column] === value);
    return this;
  }
  /**
   * PostgREST's generic filter, as used for a JSON-path column expression
   * (e.g. `.filter("metadata->>postId", "eq", value)` -- Postgres's `->>`
   * extracts a JSONB key as text). Only "eq" is implemented, since that is
   * the only operator any real caller currently uses through this fake.
   */
  filter(column: string, operator: string, value: unknown): this {
    const jsonPath = column.match(/^(\w+)->>(\w+)$/);
    if (jsonPath) {
      const [, base, key] = jsonPath;
      this.filters.push((row) => {
        const container = row[base];
        return typeof container === "object" && container !== null ? String((container as Row)[key]) === String(value) : false;
      });
      return this;
    }
    if (operator === "eq") this.filters.push((row) => row[column] === value);
    return this;
  }
  order(): this {
    return this;
  }
  limit(count: number): this {
    this.limitCount = count;
    return this;
  }
  range(from: number, to: number): this {
    this.rangeWindow = [from, to];
    return this;
  }
  abortSignal(): this {
    return this;
  }
  insert(payload: Row): this {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row): this {
    this.op = "update";
    // JSONB is serialized at request time; callers cannot mutate a stored
    // checkpoint later merely by changing their in-memory object.
    this.payload = structuredClone(payload);
    return this;
  }
  delete(): this {
    this.op = "update";
    this.payload = null;
    return this;
  }
  upsert(payload: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.op = "upsert";
    // Real Supabase-js's upsert() accepts a single row OR an array for a bulk
    // upsert, and this codebase's real callers (e.g. persistOrOverlay in
    // features/alerts/server.ts) always pass an array, even for one row.
    // Storing it under a normalized, always-array field — rather than
    // spreading it as this.payload in execute() — avoids the array-as-object
    // spread bug ({...[row]} produces {"0": row}, not row's own fields).
    this.upsertPayload = Array.isArray(payload) ? payload : [payload];
    this.onConflictColumns = options?.onConflict ? options.onConflict.split(",").map((value) => value.trim()) : null;
    this.ignoreDuplicates = options?.ignoreDuplicates === true;
    return this;
  }

  private matchesOr(row: Row): boolean {
    if (!this.orExpression) return true;
    return splitTopLevelCommas(this.orExpression).some((clause) => {
      if (clause.startsWith("and(") && clause.endsWith(")")) {
        return splitTopLevelCommas(clause.slice(4, -1)).every((inner) => matchesEqClause(row, inner));
      }
      return matchesEqClause(row, clause);
    });
  }

  private matchingRows(): Row[] {
    const all = this.db._table(this.table);
    const matched = all.filter((row) => this.filters.every((filter) => filter(row)) && this.matchesOr(row));
    if (this.rangeWindow) {
      const [from, to] = this.rangeWindow;
      return matched.slice(from, to + 1);
    }
    if (this.limitCount !== null) return matched.slice(0, this.limitCount);
    // Real PostgREST silently caps a response at its configured default row
    // limit (commonly 1000) whenever a query issues neither .range() nor
    // .limit() -- confirmed empirically against this project's own Supabase
    // instance. This fake must reproduce that silent truncation for a real
    // SELECT, or a missing-pagination bug (a query that can return more than
    // the default cap but never requests a page) can never be caught by a
    // test. Only applies to a genuine data-returning select -- matchingRows()
    // is also called internally to find which rows an update/delete targets,
    // where this.op is already "update" by the time it runs, and that must
    // never be silently capped.
    return this.op === "select" ? matched.slice(0, DEFAULT_SELECT_ROW_CAP) : matched;
  }

  private execute(): { data: unknown; error: QueryFailure | null } {
    const failure = this.db._consumeFailure(this.table, this.op);
    if (failure) return { data: null, error: failure };

    if (this.op === "select") {
      return { data: this.matchingRows(), error: null };
    }

    const table = this.db._table(this.table);
    if (this.op === "insert") {
      // Real callers (persist-listing.ts) never set listings.first_seen_at
      // explicitly on creation -- it relies on the real column's `DEFAULT
      // now()`, which this in-memory table must simulate or every
      // getFilterResults() read of a freshly-inserted listing silently drops
      // it (toListingRow requires a non-null first_seen_at).
      const defaults = this.table === "listings" && this.payload!.first_seen_at === undefined ? { first_seen_at: new Date().toISOString() } : {};
      const row = { id: this.payload!.id ?? this.db._nextId(), ...defaults, ...this.payload };
      this.db._setTable(this.table, [...table, row]);
      return { data: this.wantsSelectBack ? [row] : null, error: null };
    }

    if (this.op === "update") {
      const matched = this.matchingRows();
      const matchedIds = new Set(matched.map((row) => row.id));
      if (this.payload === null) {
        this.db._setTable(this.table, table.filter((row) => !matchedIds.has(row.id)));
        return { data: null, error: null };
      }
      const next = table.map((row) => (matchedIds.has(row.id) ? { ...row, ...this.payload } : row));
      this.db._setTable(this.table, next);
      return { data: this.wantsSelectBack ? next.filter((row) => matchedIds.has(row.id)) : null, error: null };
    }

    // upsert — apply every row in the (always-array) payload in order, each
    // against the table state left by the previous one, so a batch upsert
    // behaves the same as N sequential single-row upserts.
    const conflictColumns = this.onConflictColumns ?? ["id"];
    let nextTable = table;
    const rows: Row[] = [];
    for (const item of this.upsertPayload ?? []) {
      const existingIndex = nextTable.findIndex((row) => conflictColumns.every((column) => row[column] === item[column]));
      let row: Row;
      if (existingIndex >= 0) {
        if (this.ignoreDuplicates) {
          // `ignoreDuplicates: true` is PostgreSQL's ON CONFLICT DO NOTHING:
          // preserve the stored row exactly and continue processing the rest
          // of the batch. In particular, do not merge the incoming id/title
          // or any other field into the existing record.
          row = nextTable[existingIndex];
          rows.push(row);
          continue;
        }
        row = { ...nextTable[existingIndex], ...item };
        nextTable = [...nextTable.slice(0, existingIndex), row, ...nextTable.slice(existingIndex + 1)];
      } else {
        // Real callers (persist-listing.ts) never set listings.first_seen_at
        // explicitly on creation -- it relies on the real column's `DEFAULT
        // now()`, which this in-memory table must simulate for a genuinely
        // new row (never for an update to an existing one) or every
        // getFilterResults() read of it silently drops the listing
        // (toListingRow requires a non-null first_seen_at).
        const defaults = this.table === "listings" && item.first_seen_at === undefined ? { first_seen_at: new Date().toISOString() } : {};
        row = { id: item.id ?? this.db._nextId(), ...defaults, ...item };
        nextTable = [...nextTable, row];
      }
      rows.push(row);
    }
    this.db._setTable(this.table, nextTable);
    return { data: this.wantsSelectBack ? rows : null, error: null };
  }

  async maybeSingle(): Promise<{ data: Row | null; error: QueryFailure | null }> {
    const result = this.execute();
    if (result.error) return { data: null, error: result.error };
    const rows = Array.isArray(result.data) ? result.data : this.matchingRows();
    return { data: (rows[0] as Row) ?? null, error: null };
  }

  async single(): Promise<{ data: Row | null; error: QueryFailure | null }> {
    const result = this.execute();
    if (result.error) return { data: null, error: result.error };
    const rows = Array.isArray(result.data) ? result.data : this.matchingRows();
    if (!rows[0]) return { data: null, error: { message: "no rows found" } };
    return { data: rows[0] as Row, error: null };
  }

  then<TResult1 = { data: unknown; error: QueryFailure | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: QueryFailure | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

class FakeRpcCall implements PromiseLike<RpcResult> {
  private readonly db: FakeFacebookSupabase;
  private readonly name: string;
  private readonly params: Row;

  constructor(db: FakeFacebookSupabase, name: string, params: Row) {
    this.db = db;
    this.name = name;
    this.params = params;
  }

  abortSignal(): this {
    return this;
  }

  private execute(): RpcResult {
    const failure = this.db._consumeRpcFailure(this.name);
    if (failure) return { data: null, error: { message: failure } };
    const handler = this.db._rpcHandler(this.name);
    if (!handler) return { data: null, error: { message: `no fake rpc handler registered for ${this.name}` } };
    return handler(this.params);
  }

  async single(): Promise<RpcResult> {
    const result = this.execute();
    if (result.error) return result;
    // Mirrors real supabase-js: PostgREST's "single object" Accept header
    // unwraps a `returns table (...)` RPC's one-row result from an array to
    // a plain object, which is what every real .rpc(...).single() call site
    // in this codebase already assumes.
    return { data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data, error: null };
  }

  then<TResult1 = RpcResult, TResult2 = never>(
    onfulfilled?: ((value: RpcResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

/** Installs the canonical-reconciliation RPC handler this suite's tests need: it mirrors `reconcile_canonical_listing_decision`'s documented contract (upsert one listing_filter_matches row per listing/filter, keep the listing's lifecycle in sync) without reimplementing any application decision logic — the real reconcileCanonicalListingDecision() function is still what's under test. */
export function installCanonicalReconciliationRpc(db: FakeFacebookSupabase): void {
  db.setRpc("reconcile_canonical_listing_decision", (params) => {
    const listingId = String(params.p_listing_id);
    const filterId = String(params.p_filter_id);
    const bucket = String(params.p_bucket);
    const reasons = Array.isArray(params.p_reasons) ? params.p_reasons : [];
    const isCurrentMatch = bucket === "MATCHED";
    const matches = db.rows("listing_filter_matches");
    const existingIndex = matches.findIndex((row) => row.listing_id === listingId && row.search_filter_id === filterId);
    const row: Row = {
      id: existingIndex >= 0 ? matches[existingIndex].id : `fake-match-${listingId}-${filterId}`,
      listing_id: listingId,
      search_filter_id: filterId,
      is_current_match: isCurrentMatch,
      match_reasons: reasons,
      match_score: null,
      first_matched_at: existingIndex >= 0 ? matches[existingIndex].first_matched_at : params.p_matched_at,
      last_matched_at: params.p_matched_at,
      match_origin: params.p_match_origin ?? "scan",
    };
    const nextMatches = existingIndex >= 0 ? matches.map((existing, index) => (index === existingIndex ? row : existing)) : [...matches, row];
    (db as unknown as { _setTable: (table: string, rows: Row[]) => void })._setTable("listing_filter_matches", nextMatches);

    const listings = db.rows("listings");
    const listingIndex = listings.findIndex((listing) => listing.id === listingId);
    if (listingIndex >= 0) {
      const nextListings = [...listings];
      nextListings[listingIndex] = { ...listings[listingIndex], lifecycle_status: params.p_lifecycle_status, missing_fields: params.p_missing_fields ?? [] };
      (db as unknown as { _setTable: (table: string, rows: Row[]) => void })._setTable("listings", nextListings);
    }

    return { data: [{ listing_id: listingId, search_filter_id: filterId, bucket, lifecycle_status: params.p_lifecycle_status, is_current_match: isCurrentMatch, match_reasons: reasons }], error: null };
  });
}

/**
 * Shared by installFacebookHistorySummaryRpc and installFacebookHistoryClearRpc
 * so the two fake RPCs classify from one place, the same way the real
 * get_facebook_watcher_history_summary() and clear_facebook_watcher_history_atomic()
 * SQL functions share one CTE: a fake preview and a fake clear built on two
 * separately-written classifiers would only prove that two reimplementations
 * agree with each other, not that the preview can't drift from the mutation.
 */
function classifyFacebookHistoryCandidates(db: FakeFacebookSupabase): { pure: string[]; preserved: string[] } {
  const listingsById = new Map(db.rows("listings").map((row) => [String(row.id), row]));
  const propertyListingIds = new Set(db.rows("properties").map((row) => String(row.listing_id)));
  const dealListingIds = new Set(db.rows("deals").map((row) => String(row.listing_id)));
  const seen = new Set<string>();
  const pure: string[] = [];
  const preserved: string[] = [];
  for (const row of db.rows("listing_source_metadata")) {
    if (row.source !== "facebook") continue;
    const listingId = String(row.listing_id);
    if (seen.has(listingId)) continue;
    seen.add(listingId);
    const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as Row : {};
    const listingSource = listingsById.get(listingId)?.source;
    const isPreserved = listingSource !== "facebook" || metadata.crossSourceMatch === true || propertyListingIds.has(listingId) || dealListingIds.has(listingId);
    (isPreserved ? preserved : pure).push(listingId);
  }
  return { pure, preserved };
}

/** Installs the read-only preview RPC handler: classifies but never mutates. */
export function installFacebookHistorySummaryRpc(db: FakeFacebookSupabase): void {
  db.setRpc("get_facebook_watcher_history_summary", () => {
    const { pure, preserved } = classifyFacebookHistoryCandidates(db);
    return { data: [{ pure_facebook_listing_ids: pure, preserved_listing_ids: preserved, removed_association_listing_ids: preserved }], error: null };
  });
}

/** Installs the destructive clear RPC handler: same classification, then actually mutates this fake DB's tables (never Production). */
export function installFacebookHistoryClearRpc(db: FakeFacebookSupabase): void {
  db.setRpc("clear_facebook_watcher_history_atomic", () => {
    const activeScan = db.rows("source_scans").some((row) => row.source === "facebook" && ["pending", "running"].includes(String(row.status)));
    const activeJob = db.rows("facebook_scan_jobs").some((row) => ["SOURCE_SCAN", "GALLERY_HYDRATION"].includes(String(row.job_type)) && ["queued", "claimed", "running"].includes(String(row.status)));
    if (activeScan || activeJob) return { data: null, error: { message: "ACTIVE_FACEBOOK_WORK" } };

    const { pure, preserved } = classifyFacebookHistoryCandidates(db);
    db._setTable("listings", db.rows("listings").filter((row) => !(row.source === "facebook" && pure.includes(String(row.id)))));
    db._setTable("listing_source_metadata", db.rows("listing_source_metadata").filter((row) => !(row.source === "facebook" && preserved.includes(String(row.listing_id)))));
    return { data: [{ pure_facebook_listing_ids: pure, preserved_listing_ids: preserved, removed_association_listing_ids: preserved }], error: null };
  });
}
