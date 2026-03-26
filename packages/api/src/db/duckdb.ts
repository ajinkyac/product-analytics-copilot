import { Database } from "duckdb-async";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db: Database | null = null;

// ─── Initialization ───────────────────────────────────────────────────────────

export async function initDuckDB(): Promise<Database> {
  if (_db) return _db;

  const dbPath = process.env["DUCKDB_PATH"] ?? "./data/analytics.duckdb";
  const memoryLimit = process.env["DUCKDB_MEMORY_LIMIT"] ?? "2GB";
  const threads = parseInt(process.env["DUCKDB_THREADS"] ?? "4", 10);

  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  _db = await Database.create(dbPath);

  await _db.run(`SET memory_limit='${memoryLimit}'`);
  await _db.run(`SET threads=${threads}`);
  await _db.run(`SET enable_progress_bar=false`);
  await _db.run(`SET timezone='UTC'`);

  await runMigrations(_db);

  console.log(`✅ DuckDB initialized — ${dbPath}`);
  return _db;
}

export function getDuckDB(): Database {
  if (!_db) throw new Error("DuckDB not initialized. Call initDuckDB() first.");
  return _db;
}

// ─── Migration runner ─────────────────────────────────────────────────────────

async function runMigrations(db: Database): Promise<void> {
  // Create the migration-tracking table first (idempotent)
  await db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          VARCHAR   PRIMARY KEY,
      filename    VARCHAR   NOT NULL,
      checksum    VARCHAR   NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const migrationsDir = path.join(__dirname, "migrations");

  if (!fs.existsSync(migrationsDir)) {
    console.warn(`⚠️  Migrations directory not found: ${migrationsDir}`);
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // lexicographic — filenames must be zero-padded (001_, 002_, …)

  const applied = await db.all(`SELECT id FROM schema_migrations`);
  const appliedIds = new Set(applied.map((r) => r["id"] as string));

  let ran = 0;
  for (const filename of files) {
    const id = filename.replace(".sql", "");
    if (appliedIds.has(id)) continue;

    const sqlPath = path.join(migrationsDir, filename);
    const sql = fs.readFileSync(sqlPath, "utf-8");
    const checksum = createHash("sha256").update(sql).digest("hex");

    // Split on semicolons to run each statement separately
    // (DuckDB's node binding executes one statement at a time)
    const statements = sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("--"));

    for (const stmt of statements) {
      await db.run(stmt);
    }

    await db.run(
      `INSERT INTO schema_migrations (id, filename, checksum) VALUES (?, ?, ?)`,
      id,
      filename,
      checksum
    );

    console.log(`  ✓ Migration applied: ${filename}`);
    ran++;
  }

  if (ran === 0) {
    console.log(`  ✓ DuckDB schema up to date (${files.length} migrations)`);
  }
}

// ─── Refresh materialized views ───────────────────────────────────────────────

export async function refreshMaterializedViews(projectId?: string): Promise<void> {
  const db = getDuckDB();
  const where = projectId ? `WHERE project_id = '${projectId}'` : "";

  const views: Array<{ table: string; sql: string }> = [
    {
      table: "mv_daily_active_users",
      sql: `
        CREATE OR REPLACE TABLE mv_daily_active_users AS
        SELECT
          project_id,
          date_trunc('day', timestamp)  AS date,
          count(distinct user_id)       AS dau,
          count(*)                      AS event_count
        FROM events
        ${where}
        WHERE timestamp >= current_date - INTERVAL '90 days'
        GROUP BY project_id, date_trunc('day', timestamp)
      `,
    },
    {
      table: "mv_event_volume",
      sql: `
        CREATE OR REPLACE TABLE mv_event_volume AS
        SELECT
          project_id,
          event_name,
          date_trunc('hour', timestamp) AS hour,
          count(*)                      AS event_count,
          count(distinct user_id)       AS unique_users,
          count(distinct session_id)    AS unique_sessions
        FROM events
        ${where}
        WHERE timestamp >= current_date - INTERVAL '30 days'
        GROUP BY project_id, event_name, date_trunc('hour', timestamp)
      `,
    },
  ];

  for (const view of views) {
    try {
      await db.run(view.sql.replace(/\s+/g, " ").trim());
    } catch (err) {
      console.error(`Failed to refresh ${view.table}:`, err);
    }
  }
}

// ─── Query execution ──────────────────────────────────────────────────────────

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

  // Append a LIMIT if not already present
  const limitedSql = /\blimit\b/i.test(sql) ? sql : `${sql} LIMIT ${maxRows + 1}`;

  const start = Date.now();

  const queryPromise = db.all(limitedSql, ...params);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Query timeout after ${timeoutMs}ms`)), timeoutMs)
  );

  const rawRows = await Promise.race([queryPromise, timeoutPromise]);
  const executionMs = Date.now() - start;

  const truncated = rawRows.length > maxRows;
  const rows = (truncated ? rawRows.slice(0, maxRows) : rawRows) as Record<string, unknown>[];

  const columns =
    rows.length > 0
      ? Object.keys(rows[0]!).map((name) => ({
          name,
          type: inferColumnType(rows[0]![name]),
        }))
      : [];

  return { columns, rows, rowCount: rows.length, executionMs, truncated };
}

function inferColumnType(value: unknown): string {
  if (value === null || value === undefined) return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "date";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return "date";
  return "string";
}

// ─── Schema inference ─────────────────────────────────────────────────────────

export async function inferProjectSchema(
  projectId: string
): Promise<{ eventNames: string[]; propertySchema: Record<string, string> }> {
  const db = getDuckDB();

  const eventNamesResult = await db.all(
    `SELECT DISTINCT event_name FROM events WHERE project_id = ? ORDER BY event_name`,
    projectId
  );
  const eventNames = eventNamesResult.map((r) => r["event_name"] as string);

  const sampleResult = await db.all(
    `SELECT properties FROM events WHERE project_id = ? AND properties IS NOT NULL LIMIT 1000`,
    projectId
  );

  const propertySchema: Record<string, string> = {};
  for (const row of sampleResult) {
    try {
      const props =
        typeof row["properties"] === "string"
          ? (JSON.parse(row["properties"] as string) as Record<string, unknown>)
          : (row["properties"] as Record<string, unknown>);
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

// ─── Bulk insert helper ───────────────────────────────────────────────────────

/**
 * Inserts rows in chunks to stay within DuckDB's parameter limit (~65535 params).
 * columns.length * CHUNK_SIZE must stay well below that limit.
 */
export async function bulkInsert(
  table: string,
  columns: string[],
  rows: unknown[][]
): Promise<void> {
  if (rows.length === 0) return;

  const db = getDuckDB();
  const CHUNK_SIZE = Math.floor(32_000 / columns.length);

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk
      .map(() => `(${columns.map(() => "?").join(", ")})`)
      .join(", ");

    const sql = `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES ${placeholders}`;
    await db.run(sql, ...chunk.flat());
  }
}
