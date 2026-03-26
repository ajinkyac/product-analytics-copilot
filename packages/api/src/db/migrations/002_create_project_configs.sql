-- Migration 002: Project config cache in DuckDB
-- Stores a lightweight copy of project metadata so query-time auth checks
-- and schema lookups don't require a round-trip to PostgreSQL.
-- Refreshed on project create/update via the API layer.

CREATE TABLE IF NOT EXISTS project_configs (
  project_id        VARCHAR     PRIMARY KEY,
  workspace_id      VARCHAR     NOT NULL,
  name              VARCHAR     NOT NULL,

  -- Cached schema inference (updated hourly by the schema-refresh job)
  event_names       JSON        NOT NULL DEFAULT '[]',
  property_schema   JSON        NOT NULL DEFAULT '{}',
  last_schema_sync  TIMESTAMPTZ,

  -- Soft-delete mirror from PostgreSQL
  is_archived       BOOLEAN     NOT NULL DEFAULT false,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Saved query result cache ─────────────────────────────────────────────────
-- Stores the most recent execution result for each saved query so dashboards
-- can be served without re-executing DuckDB queries on every page load.
-- Keyed on (project_id, query_hash) — query_hash is SHA-256 of normalized SQL.

CREATE TABLE IF NOT EXISTS query_result_cache (
  project_id        VARCHAR     NOT NULL,
  query_hash        VARCHAR     NOT NULL,  -- SHA-256(project_id + normalized_sql)
  sql               VARCHAR     NOT NULL,
  result_json       JSON        NOT NULL,
  row_count         INTEGER     NOT NULL DEFAULT 0,
  execution_ms      INTEGER     NOT NULL DEFAULT 0,
  cached_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (project_id, query_hash)
);
