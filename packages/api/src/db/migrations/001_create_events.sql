-- Migration 001: Core events table
-- DuckDB columnar store for all product analytics events.
-- project_id is the first column in the PRIMARY KEY to enable zone-map pruning per tenant.

CREATE TABLE IF NOT EXISTS events (
  id                UUID        NOT NULL DEFAULT gen_random_uuid(),
  project_id        VARCHAR     NOT NULL,

  -- Event identity
  event_name        VARCHAR     NOT NULL,
  event_uuid        VARCHAR     NOT NULL,   -- client-generated idempotency key

  -- Actor
  user_id           VARCHAR     NOT NULL,
  anonymous_id      VARCHAR,
  session_id        VARCHAR,

  -- Timing (always use `timestamp` for analysis; received_at is for debugging)
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ,
  timestamp         TIMESTAMPTZ NOT NULL,

  -- Context (extracted from SDK context block for query performance)
  ip_address        VARCHAR,
  country_code      VARCHAR(2),
  city              VARCHAR,
  device_type       VARCHAR,          -- 'desktop' | 'mobile' | 'tablet'
  os_name           VARCHAR,
  browser_name      VARCHAR,
  app_version       VARCHAR,

  -- Flexible payload
  properties        JSON,

  -- Ingest metadata
  ingest_batch_id   VARCHAR,
  schema_version    TINYINT     NOT NULL DEFAULT 1,

  PRIMARY KEY (project_id, id)
);
