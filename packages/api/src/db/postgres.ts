import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

let _pool: Pool | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env["DATABASE_URL"],
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    _pool.on("error", (err) => {
      console.error("PostgreSQL pool error:", err);
    });
  }
  return _pool;
}

export function getPgDb() {
  if (!_db) {
    _db = drizzle(getPool());
  }
  return _db;
}

export async function runMigrations(): Promise<void> {
  // In a real project, this would use drizzle-kit's migrate() function.
  // For the scaffold, we run the baseline DDL directly.
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        name         TEXT        NOT NULL,
        slug         TEXT        NOT NULL UNIQUE,
        plan         TEXT        NOT NULL DEFAULT 'starter',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        max_events_per_month BIGINT DEFAULT 1000000,
        max_projects INTEGER DEFAULT 5
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        email           TEXT        NOT NULL UNIQUE,
        name            TEXT,
        avatar_url      TEXT,
        password_hash   TEXT,
        github_id       TEXT UNIQUE,
        google_id       TEXT UNIQUE,
        preferences     JSONB NOT NULL DEFAULT '{"theme":"system","defaultTimeRange":"7d","defaultChartType":"line"}',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_active_at  TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS workspace_members (
        id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role          TEXT        NOT NULL DEFAULT 'viewer',
        invited_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        accepted_at   TIMESTAMPTZ,
        UNIQUE (workspace_id, user_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id          UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name                  TEXT        NOT NULL,
        description           TEXT,
        color                 CHAR(7),
        write_key             TEXT        NOT NULL UNIQUE DEFAULT concat('wk_', replace(gen_random_uuid()::text, '-', '')),
        duckdb_table_suffix   TEXT        NOT NULL UNIQUE DEFAULT concat('proj_', replace(gen_random_uuid()::text, '-', '')),
        event_names           JSONB DEFAULT '[]',
        property_schema       JSONB DEFAULT '{}',
        last_schema_refresh   TIMESTAMPTZ,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        archived_at           TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS saved_queries (
        id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id        UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_by        UUID        NOT NULL REFERENCES users(id),
        title             TEXT        NOT NULL,
        description       TEXT,
        nl_question       TEXT,
        sql               TEXT        NOT NULL,
        ai_generated      BOOLEAN     NOT NULL DEFAULT false,
        ai_model          TEXT,
        ai_confidence     NUMERIC(3,2),
        ai_explanation    TEXT,
        last_run_at       TIMESTAMPTZ,
        last_run_ms       INTEGER,
        last_row_count    INTEGER,
        last_result_hash  TEXT,
        version           INTEGER     NOT NULL DEFAULT 1,
        is_draft          BOOLEAN     NOT NULL DEFAULT false,
        chart_type        TEXT        DEFAULT 'table',
        chart_config      JSONB       DEFAULT '{}',
        time_range        TEXT        DEFAULT '30d',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at        TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dashboards (
        id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id                UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_by                UUID        NOT NULL REFERENCES users(id),
        title                     TEXT        NOT NULL,
        description               TEXT,
        emoji                     TEXT        DEFAULT '📊',
        layout                    JSONB       NOT NULL DEFAULT '[]',
        is_public                 BOOLEAN     NOT NULL DEFAULT false,
        public_token              TEXT UNIQUE,
        refresh_interval_seconds  INTEGER,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at                TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dashboard_widgets (
        id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        dashboard_id          UUID        NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        saved_query_id        UUID        REFERENCES saved_queries(id) ON DELETE SET NULL,
        widget_type           TEXT        NOT NULL DEFAULT 'chart',
        content               TEXT,
        title_override        TEXT,
        chart_type_override   TEXT,
        chart_config_override JSONB,
        grid_x                INTEGER     NOT NULL DEFAULT 0,
        grid_y                INTEGER     NOT NULL DEFAULT 0,
        grid_w                INTEGER     NOT NULL DEFAULT 6,
        grid_h                INTEGER     NOT NULL DEFAULT 4,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query("COMMIT");
    console.log("✅ PostgreSQL migrations applied");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
