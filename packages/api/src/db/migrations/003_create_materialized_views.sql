-- Migration 003: Analytical pre-aggregations
-- DuckDB doesn't auto-refresh materialized views, so these are CREATE OR REPLACE TABLE
-- statements that are re-executed by the scheduled refresh job (every 15–60 min).
-- The API falls back to live queries when the cache tables are empty or stale.

-- ─── Daily Active Users (refreshed hourly) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS mv_daily_active_users AS
SELECT
  project_id,
  date_trunc('day', timestamp)     AS date,
  count(distinct user_id)          AS dau,
  count(*)                         AS event_count
FROM events
WHERE timestamp >= current_date - INTERVAL '90 days'
GROUP BY project_id, date_trunc('day', timestamp);

-- ─── Event volume by name (refreshed every 15 min) ───────────────────────────
CREATE TABLE IF NOT EXISTS mv_event_volume AS
SELECT
  project_id,
  event_name,
  date_trunc('hour', timestamp)    AS hour,
  count(*)                         AS event_count,
  count(distinct user_id)          AS unique_users,
  count(distinct session_id)       AS unique_sessions
FROM events
WHERE timestamp >= current_date - INTERVAL '30 days'
GROUP BY project_id, event_name, date_trunc('hour', timestamp);

-- ─── Hourly active users for sparklines (refreshed every 15 min) ─────────────
CREATE TABLE IF NOT EXISTS mv_hourly_active_users AS
SELECT
  project_id,
  date_trunc('hour', timestamp)    AS hour,
  count(distinct user_id)          AS unique_users,
  count(*)                         AS event_count
FROM events
WHERE timestamp >= now() - INTERVAL '7 days'
GROUP BY project_id, date_trunc('hour', timestamp);

-- ─── Country breakdown (refreshed hourly) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS mv_country_breakdown AS
SELECT
  project_id,
  country_code,
  count(distinct user_id)          AS unique_users,
  count(*)                         AS event_count,
  date_trunc('day', now())         AS as_of_date
FROM events
WHERE timestamp >= current_date - INTERVAL '30 days'
  AND country_code IS NOT NULL
GROUP BY project_id, country_code;

-- ─── Device type breakdown (refreshed hourly) ────────────────────────────────
CREATE TABLE IF NOT EXISTS mv_device_breakdown AS
SELECT
  project_id,
  device_type,
  count(distinct user_id)          AS unique_users,
  count(*)                         AS event_count,
  date_trunc('day', now())         AS as_of_date
FROM events
WHERE timestamp >= current_date - INTERVAL '30 days'
  AND device_type IS NOT NULL
GROUP BY project_id, device_type;
