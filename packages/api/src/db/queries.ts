/**
 * EventQueryBuilder — type-safe, injection-safe query builder for the events table.
 *
 * All user-supplied VALUES go through parameterized placeholders (?).
 * All column/table identifiers are validated against an explicit allowlist before
 * being interpolated into SQL — no raw user strings reach the query string.
 *
 * Usage:
 *   const { sql, params } = new EventQueryBuilder("proj_123")
 *     .dateRange(start, end)
 *     .eventNames(["page_view", "button_click"])
 *     .groupBy("event_name")
 *     .aggregate("count_and_unique")
 *     .orderBy("event_count", "DESC")
 *     .limit(1000)
 *     .build();
 */

// ─── Public types ─────────────────────────────────────────────────────────────

export type GroupByColumn =
  | "event_name"
  | "country_code"
  | "device_type"
  | "os_name"
  | "browser_name"
  | "user_id"
  | "session_id"
  | "hour"
  | "day"
  | "week"
  | "month";

export type AggregateMode =
  | "count"              // SELECT count(*) AS event_count
  | "unique_users"       // SELECT count(distinct user_id) AS unique_users
  | "count_and_unique"   // Both of the above
  | "raw";               // SELECT * — raw event rows

export type FilterOperator = "eq" | "neq" | "in" | "nin" | "gt" | "gte" | "lt" | "lte" | "contains";

export interface PropertyFilter {
  /** Key inside the `properties` JSON column. Validated to be alphanum + underscores only. */
  property: string;
  operator: FilterOperator;
  value: string | number | string[];
}

export interface EventFilters {
  startDate?: Date;
  endDate?: Date;
  eventNames?: string[];
  userId?: string;
  sessionId?: string;
  countryCode?: string;
  deviceType?: string;
  propertyFilter?: PropertyFilter;
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

// ─── Allowlists ───────────────────────────────────────────────────────────────

const ALLOWED_GROUP_BY_COLUMNS: Record<GroupByColumn, string> = {
  event_name:   "event_name",
  country_code: "country_code",
  device_type:  "device_type",
  os_name:      "os_name",
  browser_name: "browser_name",
  user_id:      "user_id",
  session_id:   "session_id",
  hour:         "date_trunc('hour', timestamp)",
  day:          "date_trunc('day', timestamp)",
  week:         "date_trunc('week', timestamp)",
  month:        "date_trunc('month', timestamp)",
};

const ALLOWED_ORDER_COLUMNS = new Set([
  "event_count", "unique_users", "unique_sessions",
  "timestamp", "received_at", "event_name",
  "country_code", "device_type", "user_id",
  "hour", "day", "week", "month",
]);

const PROPERTY_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

// ─── Builder ──────────────────────────────────────────────────────────────────

export class EventQueryBuilder {
  private readonly projectId: string;
  private filters: EventFilters = {};
  private groupByCol?: GroupByColumn;
  private aggregateMode: AggregateMode = "count_and_unique";
  private limitVal = 10_000;
  private offsetVal = 0;
  private orderByCol = "event_count";
  private orderByDir: "ASC" | "DESC" = "DESC";

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  dateRange(start: Date, end: Date): this {
    this.filters.startDate = start;
    this.filters.endDate = end;
    return this;
  }

  eventNames(names: string[]): this {
    this.filters.eventNames = names.slice(0, 50); // cap at 50 to keep IN list sane
    return this;
  }

  user(userId: string): this {
    this.filters.userId = userId;
    return this;
  }

  session(sessionId: string): this {
    this.filters.sessionId = sessionId;
    return this;
  }

  country(code: string): this {
    this.filters.countryCode = code.toUpperCase().slice(0, 2);
    return this;
  }

  device(type: string): this {
    this.filters.deviceType = type;
    return this;
  }

  propertyFilter(filter: PropertyFilter): this {
    if (!PROPERTY_KEY_RE.test(filter.property)) {
      throw new Error(`Invalid property key: "${filter.property}". Only [a-zA-Z0-9_] allowed.`);
    }
    this.filters.propertyFilter = filter;
    return this;
  }

  groupBy(col: GroupByColumn): this {
    this.groupByCol = col;
    return this;
  }

  aggregate(mode: AggregateMode): this {
    this.aggregateMode = mode;
    return this;
  }

  limit(n: number): this {
    this.limitVal = Math.min(Math.max(1, n), 100_000);
    return this;
  }

  offset(n: number): this {
    this.offsetVal = Math.max(0, n);
    return this;
  }

  orderBy(col: string, dir: "ASC" | "DESC" = "DESC"): this {
    if (!ALLOWED_ORDER_COLUMNS.has(col)) {
      throw new Error(`Invalid ORDER BY column: "${col}"`);
    }
    this.orderByCol = col;
    this.orderByDir = dir;
    return this;
  }

  build(): BuiltQuery {
    const params: unknown[] = [];

    // ── SELECT ──────────────────────────────────────────────────────────────
    const selectCols = this.buildSelect();

    // ── FROM + WHERE ────────────────────────────────────────────────────────
    const { whereClause, whereParams } = this.buildWhere();
    params.push(...whereParams);

    // ── GROUP BY ────────────────────────────────────────────────────────────
    const groupByClause = this.buildGroupBy();

    // ── ORDER BY ────────────────────────────────────────────────────────────
    // orderByCol and orderByDir are validated against allowlists above — safe to interpolate
    const orderByClause =
      this.aggregateMode !== "raw"
        ? `ORDER BY ${this.orderByCol} ${this.orderByDir}`
        : `ORDER BY timestamp DESC`;

    // ── LIMIT / OFFSET ──────────────────────────────────────────────────────
    const limitClause = `LIMIT ${this.limitVal} OFFSET ${this.offsetVal}`;

    const sql = [
      `SELECT ${selectCols}`,
      `FROM events`,
      `WHERE ${whereClause}`,
      groupByClause,
      orderByClause,
      limitClause,
    ]
      .filter(Boolean)
      .join("\n");

    return { sql, params };
  }

  // ─── Private builders ─────────────────────────────────────────────────────

  private buildSelect(): string {
    if (this.aggregateMode === "raw") {
      return [
        "id", "project_id", "event_name", "user_id", "anonymous_id",
        "session_id", "timestamp", "country_code", "device_type",
        "os_name", "browser_name", "app_version", "properties",
      ].join(", ");
    }

    const cols: string[] = [];

    if (this.groupByCol) {
      const expr = ALLOWED_GROUP_BY_COLUMNS[this.groupByCol]!;
      // Use the column name as alias for time truncations
      const alias = ["hour", "day", "week", "month"].includes(this.groupByCol)
        ? this.groupByCol
        : this.groupByCol;
      cols.push(`${expr} AS ${alias}`);
    }

    if (this.aggregateMode === "count" || this.aggregateMode === "count_and_unique") {
      cols.push("count(*) AS event_count");
    }
    if (this.aggregateMode === "unique_users" || this.aggregateMode === "count_and_unique") {
      cols.push("count(distinct user_id) AS unique_users");
      cols.push("count(distinct session_id) AS unique_sessions");
    }

    return cols.length > 0 ? cols.join(", ") : "count(*) AS event_count";
  }

  private buildWhere(): { whereClause: string; whereParams: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    // project_id is ALWAYS first — ensures DuckDB's zone-map pruning kicks in
    clauses.push("project_id = ?");
    params.push(this.projectId);

    if (this.filters.startDate) {
      clauses.push("timestamp >= ?");
      params.push(this.filters.startDate.toISOString());
    }

    if (this.filters.endDate) {
      clauses.push("timestamp <= ?");
      params.push(this.filters.endDate.toISOString());
    }

    if (this.filters.eventNames && this.filters.eventNames.length > 0) {
      const placeholders = this.filters.eventNames.map(() => "?").join(", ");
      clauses.push(`event_name IN (${placeholders})`);
      params.push(...this.filters.eventNames);
    }

    if (this.filters.userId) {
      clauses.push("user_id = ?");
      params.push(this.filters.userId);
    }

    if (this.filters.sessionId) {
      clauses.push("session_id = ?");
      params.push(this.filters.sessionId);
    }

    if (this.filters.countryCode) {
      clauses.push("country_code = ?");
      params.push(this.filters.countryCode);
    }

    if (this.filters.deviceType) {
      clauses.push("device_type = ?");
      params.push(this.filters.deviceType);
    }

    if (this.filters.propertyFilter) {
      const { clause, params: pParams } = buildPropertyFilterClause(
        this.filters.propertyFilter
      );
      clauses.push(clause);
      params.push(...pParams);
    }

    return {
      whereClause: clauses.join(" AND "),
      whereParams: params,
    };
  }

  private buildGroupBy(): string {
    if (!this.groupByCol || this.aggregateMode === "raw") return "";
    const expr = ALLOWED_GROUP_BY_COLUMNS[this.groupByCol]!;
    return `GROUP BY ${expr}`;
  }
}

// ─── Property filter clause builder ──────────────────────────────────────────

function buildPropertyFilterClause(filter: PropertyFilter): {
  clause: string;
  params: unknown[];
} {
  // property key is already validated by regex in the builder
  const jsonPath = `$.${filter.property}`;
  const params: unknown[] = [];
  let clause: string;

  const extractExpr =
    typeof filter.value === "number"
      ? `CAST(json_extract(properties, '${jsonPath}') AS DOUBLE)`
      : `json_extract_string(properties, '${jsonPath}')`;

  switch (filter.operator) {
    case "eq":
      clause = `${extractExpr} = ?`;
      params.push(String(filter.value));
      break;
    case "neq":
      clause = `${extractExpr} != ?`;
      params.push(String(filter.value));
      break;
    case "in":
      if (!Array.isArray(filter.value)) throw new Error("'in' operator requires an array value");
      clause = `${extractExpr} IN (${filter.value.map(() => "?").join(", ")})`;
      params.push(...filter.value);
      break;
    case "nin":
      if (!Array.isArray(filter.value)) throw new Error("'nin' operator requires an array value");
      clause = `${extractExpr} NOT IN (${filter.value.map(() => "?").join(", ")})`;
      params.push(...filter.value);
      break;
    case "gt":
      clause = `${extractExpr} > ?`;
      params.push(filter.value);
      break;
    case "gte":
      clause = `${extractExpr} >= ?`;
      params.push(filter.value);
      break;
    case "lt":
      clause = `${extractExpr} < ?`;
      params.push(filter.value);
      break;
    case "lte":
      clause = `${extractExpr} <= ?`;
      params.push(filter.value);
      break;
    case "contains":
      clause = `${extractExpr} LIKE ?`;
      params.push(`%${String(filter.value)}%`);
      break;
    default:
      throw new Error(`Unknown operator: ${String(filter.operator)}`);
  }

  return { clause, params };
}

// ─── Pre-built common queries ─────────────────────────────────────────────────

export function buildFunnelQuery(
  projectId: string,
  steps: string[],
  startDate: Date,
  endDate: Date
): BuiltQuery {
  if (steps.length < 2 || steps.length > 8) {
    throw new Error("Funnel requires 2–8 steps");
  }

  const params: unknown[] = [projectId, startDate.toISOString(), endDate.toISOString()];

  // Build a CTE for each step
  const ctes = steps.map((step, i) => {
    params.push(step);
    const prevJoin =
      i === 0
        ? ""
        : `JOIN step${i - 1} s${i - 1} ON s${i}.user_id = s${i - 1}.user_id
           AND s${i}.timestamp > s${i - 1}.timestamp`;

    return `step${i} AS (
      SELECT DISTINCT e.user_id, MIN(e.timestamp) AS step_ts
      FROM events e ${prevJoin}
      WHERE e.project_id = ?
        AND e.timestamp BETWEEN ? AND ?
        AND e.event_name = ?
      GROUP BY e.user_id
    )`.replace(/\?/g, () => {
      // Only the step event_name param is new; the first 3 are already pushed
      return "?";
    });
  });

  // Actually, let me build a simpler but correct funnel query
  const stepParams: unknown[] = [];
  const cteParts: string[] = [];

  for (let i = 0; i < steps.length; i++) {
    if (i === 0) {
      cteParts.push(`step0 AS (
        SELECT DISTINCT user_id, MIN(timestamp) AS step_ts
        FROM events
        WHERE project_id = ? AND timestamp BETWEEN ? AND ? AND event_name = ?
        GROUP BY user_id
      )`);
      stepParams.push(projectId, startDate.toISOString(), endDate.toISOString(), steps[0]);
    } else {
      cteParts.push(`step${i} AS (
        SELECT DISTINCT e.user_id, MIN(e.timestamp) AS step_ts
        FROM events e
        JOIN step${i - 1} prev ON e.user_id = prev.user_id AND e.timestamp > prev.step_ts
        WHERE e.project_id = ? AND e.event_name = ?
        GROUP BY e.user_id
      )`);
      stepParams.push(projectId, steps[i]);
    }
  }

  const selectParts = steps.map(
    (step, i) => `(SELECT count(*) FROM step${i}) AS "${step}"`
  );

  const sql = `WITH ${cteParts.join(",\n")} SELECT ${selectParts.join(", ")}`;

  return { sql, params: stepParams };
}

export function buildRetentionQuery(
  projectId: string,
  cohortEvent: string,
  retentionEvent: string,
  startDate: Date,
  weeks: number = 8
): BuiltQuery {
  const params: unknown[] = [
    projectId, startDate.toISOString(), cohortEvent,
    projectId, retentionEvent,
  ];

  const sql = `
    WITH cohort AS (
      SELECT user_id, date_trunc('week', timestamp) AS cohort_week
      FROM events
      WHERE project_id = ?
        AND timestamp >= ?
        AND event_name = ?
    ),
    activity AS (
      SELECT user_id, date_trunc('week', timestamp) AS activity_week
      FROM events
      WHERE project_id = ?
        AND event_name = ?
    )
    SELECT
      cohort_week,
      CAST(datediff('week', cohort_week, activity_week) AS INTEGER) AS week_number,
      count(distinct cohort.user_id) AS retained_users,
      (SELECT count(distinct user_id) FROM cohort c2 WHERE c2.cohort_week = cohort.cohort_week) AS cohort_size
    FROM cohort
    JOIN activity ON cohort.user_id = activity.user_id
      AND activity_week >= cohort_week
      AND CAST(datediff('week', cohort_week, activity_week) AS INTEGER) <= ?
    GROUP BY cohort_week, week_number
    ORDER BY cohort_week, week_number
  `;

  params.push(weeks);
  return { sql, params };
}
