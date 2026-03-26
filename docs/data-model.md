# Data Model

## Overview

The data model spans two storage layers:

- **DuckDB** — append-only analytical data (events). Optimised for aggregations and time-series scans.
- **PostgreSQL** — operational/relational data (projects, users, saved queries, dashboards). Optimised for point lookups and transactional updates.

All IDs use `uuid_generate_v4()` (PostgreSQL) or `gen_random_uuid()` (DuckDB). Timestamps are stored as UTC ISO-8601.

---

## 1. Event Schema (DuckDB)

### Table: `events`

This is the core analytical table. All product events land here after passing through the ingest worker.

```sql
CREATE TABLE events (
  -- Identity
  id           UUID        NOT NULL DEFAULT gen_random_uuid(),
  project_id   UUID        NOT NULL,  -- tenant isolation key; always bound in queries

  -- Event identity
  event_name   VARCHAR     NOT NULL,  -- 'user_signed_up', 'button_clicked', etc.
  event_uuid   VARCHAR     NOT NULL,  -- client-generated idempotency key

  -- Actor
  user_id      VARCHAR     NOT NULL,  -- your product's user identifier (opaque string)
  anonymous_id VARCHAR,               -- pre-identification anonymous id (from cookie/device)
  session_id   VARCHAR,               -- client session identifier

  -- Timing
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when the API received the event
  sent_at      TIMESTAMPTZ,                         -- when the client sent (clock skew detection)
  timestamp    TIMESTAMPTZ NOT NULL,                -- canonical event time (use this for analysis)

  -- Context (extracted from SDK context block for query performance)
  ip_address   VARCHAR,
  country_code CHAR(2),
  city         VARCHAR,
  device_type  VARCHAR,    -- 'desktop', 'mobile', 'tablet'
  os_name      VARCHAR,
  browser_name VARCHAR,
  app_version  VARCHAR,

  -- Flexible payload
  properties   JSON,       -- arbitrary key-value bag; sdk decides what goes here

  -- Ingest metadata
  ingest_batch_id VARCHAR,  -- for debugging; links to ingest_batches table
  schema_version  TINYINT NOT NULL DEFAULT 1,

  PRIMARY KEY (project_id, id)
);

-- Partitioning hint for large deployments (DuckDB 0.10+ PARTITION BY)
-- For S3 Parquet export, partition by: project_id, date_trunc('day', timestamp)
```

#### Indexes (DuckDB zone-map based, declared for documentation)

```sql
-- DuckDB uses min/max zone maps automatically. Useful sort orders:
-- For time-series dashboards:
--   ORDER BY project_id, timestamp
-- For funnel queries (user-scoped):
--   ORDER BY project_id, user_id, timestamp
-- For event-name aggregations:
--   ORDER BY project_id, event_name, timestamp
```

#### Properties Conventions

The `properties` JSON column follows a loose convention. SDKs are encouraged to follow this schema for property names to enable the query builder's autocomplete:

```jsonc
{
  // Revenue
  "revenue":       123.45,         // float, in USD
  "currency":      "USD",

  // Feature context
  "plan":          "pro",          // user's subscription plan at event time
  "feature_flag":  "new_onboarding",

  // Page / screen
  "url":           "https://app.example.com/dashboard",
  "path":          "/dashboard",
  "title":         "Dashboard — Acme Corp",
  "referrer":      "https://google.com",

  // Component context
  "component":     "upgrade_modal",
  "action":        "confirm",

  // Experiment
  "experiment_id": "exp_123",
  "variant":       "control"
}
```

---

### Materialized Views (DuckDB)

DuckDB doesn't support auto-refreshing materialized views, so these are pre-built via periodic `CREATE OR REPLACE TABLE` jobs executed by the API's scheduler.

```sql
-- Daily Active Users (refreshed hourly)
CREATE OR REPLACE TABLE mv_daily_active_users AS
SELECT
  project_id,
  date_trunc('day', timestamp) AS date,
  count(distinct user_id)      AS dau
FROM events
WHERE timestamp >= current_date - INTERVAL 90 DAY
GROUP BY 1, 2;

-- Event volume by name (refreshed every 15 min)
CREATE OR REPLACE TABLE mv_event_volume AS
SELECT
  project_id,
  event_name,
  date_trunc('hour', timestamp) AS hour,
  count(*)                       AS event_count,
  count(distinct user_id)        AS unique_users
FROM events
WHERE timestamp >= current_date - INTERVAL 30 DAY
GROUP BY 1, 2, 3;
```

---

## 2. Operational Schema (PostgreSQL)

### Table: `workspaces`

A workspace is the top-level tenant (typically a company).

```sql
CREATE TABLE workspaces (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  slug         TEXT        NOT NULL UNIQUE,  -- used in URLs: app.example.com/ws/acme
  plan         TEXT        NOT NULL DEFAULT 'starter',  -- 'starter' | 'pro' | 'enterprise'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Limits
  max_events_per_month  BIGINT  DEFAULT 1000000,
  max_projects          INTEGER DEFAULT 5
);
```

### Table: `projects`

A project maps to a product (mobile app, web app, internal tool).

```sql
CREATE TABLE projects (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  name          TEXT        NOT NULL,
  description   TEXT,
  color         CHAR(7),    -- hex color for UI (#3B82F6)

  -- Ingest
  write_key     TEXT        NOT NULL UNIQUE DEFAULT concat('wk_', gen_random_uuid()::text),
  -- write_key is sent from SDK; never expose in client bundles in prod

  -- DuckDB reference
  duckdb_table_suffix  TEXT NOT NULL UNIQUE,  -- 'proj_' || id used in view names

  -- Event schema (cached from DuckDB inference, refreshed hourly)
  event_names          JSONB DEFAULT '[]',
  property_schema      JSONB DEFAULT '{}',  -- { "plan": "string", "revenue": "number" }
  last_schema_refresh  TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at   TIMESTAMPTZ
);

CREATE INDEX ON projects(workspace_id);
CREATE INDEX ON projects(write_key);
```

### Table: `workspace_members`

```sql
CREATE TABLE workspace_members (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  role          TEXT        NOT NULL DEFAULT 'viewer',
  -- 'owner' | 'editor' | 'viewer'

  invited_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at   TIMESTAMPTZ,

  UNIQUE (workspace_id, user_id)
);
```

### Table: `users`

```sql
CREATE TABLE users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT        NOT NULL UNIQUE,
  name            TEXT,
  avatar_url      TEXT,

  -- Auth
  password_hash   TEXT,       -- null if OAuth-only
  github_id       TEXT        UNIQUE,
  google_id       TEXT        UNIQUE,

  -- Preferences
  preferences     JSONB       NOT NULL DEFAULT '{
    "theme": "system",
    "defaultTimeRange": "7d",
    "defaultChartType": "line"
  }',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at  TIMESTAMPTZ
);
```

---

## 3. Saved Queries

### Table: `saved_queries`

A saved query is a named, versioned SQL query (or NL question + generated SQL) that can be pinned to dashboards.

```sql
CREATE TABLE saved_queries (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by    UUID        NOT NULL REFERENCES users(id),

  title         TEXT        NOT NULL,
  description   TEXT,

  -- The natural language question (if AI-generated)
  nl_question   TEXT,

  -- The canonical SQL (may be AI-generated, edited, or hand-written)
  sql           TEXT        NOT NULL,

  -- AI metadata
  ai_generated  BOOLEAN     NOT NULL DEFAULT false,
  ai_model      TEXT,                     -- 'gpt-4o', 'gpt-4o-mini'
  ai_confidence NUMERIC(3,2),             -- 0.00–1.00
  ai_explanation TEXT,                    -- human-readable explanation of the SQL

  -- Execution metadata (from last run)
  last_run_at       TIMESTAMPTZ,
  last_run_ms       INTEGER,
  last_row_count    INTEGER,
  last_result_hash  TEXT,         -- SHA256 of result for change detection

  -- Versioning
  version       INTEGER     NOT NULL DEFAULT 1,
  is_draft      BOOLEAN     NOT NULL DEFAULT false,

  -- Visualization hint
  chart_type    TEXT        DEFAULT 'table',
  -- 'table' | 'line' | 'bar' | 'area' | 'pie' | 'metric' | 'funnel' | 'heatmap'

  chart_config  JSONB       DEFAULT '{}',
  -- {
  --   "xAxis": "date",
  --   "yAxis": ["dau"],
  --   "groupBy": "country_code",
  --   "colorScheme": "blue"
  -- }

  -- Time range (relative, resolved at query time)
  time_range    TEXT        DEFAULT '30d',  -- '7d' | '30d' | '90d' | 'custom'

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX ON saved_queries(project_id);
CREATE INDEX ON saved_queries(created_by);

-- Full-text search on query title + nl_question
CREATE INDEX ON saved_queries USING gin(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(nl_question, '')));
```

### Table: `query_versions`

Append-only version history for auditing and rollback.

```sql
CREATE TABLE query_versions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  saved_query_id  UUID        NOT NULL REFERENCES saved_queries(id) ON DELETE CASCADE,
  version         INTEGER     NOT NULL,
  sql             TEXT        NOT NULL,
  changed_by      UUID        REFERENCES users(id),
  change_note     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (saved_query_id, version)
);
```

---

## 4. Dashboards

### Table: `dashboards`

```sql
CREATE TABLE dashboards (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by    UUID        NOT NULL REFERENCES users(id),

  title         TEXT        NOT NULL,
  description   TEXT,
  emoji         TEXT        DEFAULT '📊',

  -- Layout (react-grid-layout serialized positions)
  layout        JSONB       NOT NULL DEFAULT '[]',
  -- [{ i: "widget_uuid", x: 0, y: 0, w: 6, h: 4 }, ...]

  -- Access
  is_public     BOOLEAN     NOT NULL DEFAULT false,
  public_token  TEXT        UNIQUE,  -- random token for public share link

  -- Auto-refresh
  refresh_interval_seconds  INTEGER,  -- null = manual, 300 = 5 min

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX ON dashboards(project_id);
```

### Table: `dashboard_widgets`

```sql
CREATE TABLE dashboard_widgets (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id    UUID        NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  saved_query_id  UUID        REFERENCES saved_queries(id) ON DELETE SET NULL,

  -- Widget type
  widget_type     TEXT        NOT NULL DEFAULT 'chart',
  -- 'chart' | 'metric' | 'text' | 'image' | 'divider'

  -- For 'text' widgets (markdown)
  content         TEXT,

  -- Override title (defaults to saved_query.title)
  title_override  TEXT,

  -- Chart type override (defaults to saved_query.chart_type)
  chart_type_override  TEXT,
  chart_config_override JSONB,

  -- Layout position (mirrors dashboard.layout, denormalized for convenience)
  grid_x          INTEGER     NOT NULL DEFAULT 0,
  grid_y          INTEGER     NOT NULL DEFAULT 0,
  grid_w          INTEGER     NOT NULL DEFAULT 6,
  grid_h          INTEGER     NOT NULL DEFAULT 4,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON dashboard_widgets(dashboard_id);
CREATE INDEX ON dashboard_widgets(saved_query_id);
```

---

## 5. Ingest Infrastructure

### Table: `ingest_batches` (PostgreSQL)

Tracks batch-level ingest operations for debugging and replay.

```sql
CREATE TABLE ingest_batches (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID        NOT NULL REFERENCES projects(id),

  -- Source
  write_key_prefix TEXT,      -- first 8 chars of write_key (for debugging without exposing the key)
  source_ip       INET,
  user_agent      TEXT,

  -- Counts
  received_count  INTEGER     NOT NULL,
  accepted_count  INTEGER     NOT NULL DEFAULT 0,
  rejected_count  INTEGER     NOT NULL DEFAULT 0,

  -- Rejection details
  rejection_reasons JSONB     DEFAULT '{}',
  -- { "missing_event_name": 3, "future_timestamp": 1 }

  -- Timing
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  processing_ms   INTEGER
);

CREATE INDEX ON ingest_batches(project_id, received_at DESC);
```

---

## 6. Entity-Relationship Summary

```
workspaces
  │
  ├── workspace_members ──── users
  │
  └── projects
        │
        ├── [DuckDB: events]
        │
        ├── saved_queries
        │     └── query_versions
        │
        └── dashboards
              └── dashboard_widgets ──── saved_queries
```

---

## 7. Schema Evolution Strategy

1. **DuckDB (events):** `ALTER TABLE events ADD COLUMN` is safe (DuckDB fills `NULL` for existing rows). Property promotion (moving a `properties->>'revenue'` into a typed column) is done as a background job.

2. **PostgreSQL:** Migrations are managed by `drizzle-orm` with `drizzle-kit`. All migrations are in `packages/api/src/db/migrations/`. The migration runner checks for pending migrations on API startup and fails fast if any are unapplied.

3. **`properties` JSON:** No schema registry in v1. The API infers schema by sampling 10,000 recent events per project hourly and caches the result in `projects.property_schema`. The query builder's autocomplete uses this cache.
