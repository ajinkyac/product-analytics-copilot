import { Database } from "duckdb-async";
import path from "path";
import fs from "fs";

let _db: Database | null = null;

export async function initDuckDB(): Promise<Database> {
  if (_db) return _db;

  const dbPath = process.env["DUCKDB_PATH"] ?? "./data/analytics.duckdb";
  const memoryLimit = process.env["DUCKDB_MEMORY_LIMIT"] ?? "2GB";
  const threads = parseInt(process.env["DUCKDB_THREADS"] ?? "4", 10);

  // Ensure data directory exists for file-based databases
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  _db = await Database.create(dbPath);

  // Apply configuration
  await _db.run(`SET memory_limit='${memoryLimit}'`);
  await _db.run(`SET threads=${threads}`);
  await _db.run(`SET enable_progress_bar=false`);

  // Create core schema if not exists
  await _db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id                UUID        NOT NULL DEFAULT gen_random_uuid(),
      project_id        VARCHAR     NOT NULL,
      event_name        VARCHAR     NOT NULL,
      event_uuid        VARCHAR     NOT NULL,
      user_id           VARCHAR     NOT NULL,
      anonymous_id      VARCHAR,
      session_id        VARCHAR,
      received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at           TIMESTAMPTZ,
      timestamp         TIMESTAMPTZ NOT NULL,
      ip_address        VARCHAR,
      country_code      VARCHAR(2),
      city              VARCHAR,
      device_type       VARCHAR,
      os_name           VARCHAR,
      browser_name      VARCHAR,
      app_version       VARCHAR,
      properties        JSON,
      ingest_batch_id   VARCHAR,
      schema_version    TINYINT     NOT NULL DEFAULT 1,
      PRIMARY KEY (project_id, id)
    )
  `);

  console.log(`✅ DuckDB initialized — ${dbPath}`);
  return _db;
}

export function getDuckDB(): Database {
  if (!_db) throw new Error("DuckDB not initialized. Call initDuckDB() first.");
  return _db;
}

// ─── Query execution with project scoping ─────────────────────────────────────

export interface QueryOptions {
  sql: string;
  params?: unknown[];
  projectId: string;
  timeoutMs?: number;
  maxRows?: number;
}

export interface QueryExecResult {
  columns: Array<{ name: string; type: string }>;
  rows: Record<string, unknown>[];
  rowCount: number;
  executionMs: number;
  truncated: boolean;
}

export async function executeQuery(options: QueryOptions): Promise<QueryExecResult> {
  const db = getDuckDB();
  const { sql, params = [], timeoutMs = 30_000, maxRows = 10_000 } = options;

  // Wrap with row limit
  const limitedSql = /\blimit\b/i.test(sql) ? sql : `${sql} LIMIT ${maxRows + 1}`;

  const start = Date.now();

  // DuckDB doesn't have a built-in query timeout via the node binding;
  // we implement it with a Promise.race against a timeout rejection.
  const queryPromise = db.all(limitedSql, ...params);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Query timeout after ${timeoutMs}ms`)), timeoutMs)
  );

  const rawRows = await Promise.race([queryPromise, timeoutPromise]);
  const executionMs = Date.now() - start;

  const truncated = rawRows.length > maxRows;
  const rows = truncated ? rawRows.slice(0, maxRows) : rawRows;

  // Infer column metadata from first row
  const columns =
    rows.length > 0
      ? Object.keys(rows[0]!).map((name) => ({
          name,
          type: inferColumnType(rows[0]![name]),
        }))
      : [];

  return {
    columns,
    rows: rows as Record<string, unknown>[],
    rowCount: rows.length,
    executionMs,
    truncated,
  };
}

function inferColumnType(value: unknown): string {
  if (value === null || value === undefined) return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "date";
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "date";
  }
  return "string";
}

// ─── Schema inference ─────────────────────────────────────────────────────────

export async function inferProjectSchema(
  projectId: string
): Promise<{ eventNames: string[]; propertySchema: Record<string, string> }> {
  const db = getDuckDB();

  // Get distinct event names
  const eventNamesResult = await db.all(
    `SELECT DISTINCT event_name FROM events WHERE project_id = ? ORDER BY event_name`,
    projectId
  );
  const eventNames = eventNamesResult.map((r) => r["event_name"] as string);

  // Sample properties to infer schema
  const sampleResult = await db.all(
    `SELECT properties FROM events WHERE project_id = ? AND properties IS NOT NULL LIMIT 1000`,
    projectId
  );

  const propertySchema: Record<string, string> = {};
  for (const row of sampleResult) {
    try {
      const props =
        typeof row["properties"] === "string"
          ? JSON.parse(row["properties"] as string)
          : row["properties"];
      if (props && typeof props === "object") {
        for (const [key, value] of Object.entries(props)) {
          if (!(key in propertySchema)) {
            propertySchema[key] = typeof value === "number" ? "number" : "string";
          }
        }
      }
    } catch {
      // Skip unparseable properties
    }
  }

  return { eventNames, propertySchema };
}
