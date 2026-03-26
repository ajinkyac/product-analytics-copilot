import { randomUUID } from "crypto";
import { z } from "zod";
import { getDuckDB, executeQuery, bulkInsert } from "../db/duckdb.js";
import { EventQueryBuilder, buildFunnelQuery, type EventFilters, type GroupByColumn, type AggregateMode } from "../db/queries.js";

// ─── Ingest types ─────────────────────────────────────────────────────────────

export const ingestEventSchema = z.object({
  event:       z.string().min(1).max(200).trim(),
  userId:      z.string().max(500).optional(),
  anonymousId: z.string().max(500).optional(),
  sessionId:   z.string().max(200).optional(),
  timestamp:   z.string().datetime({ offset: true }).optional(),
  sentAt:      z.string().datetime({ offset: true }).optional(),
  properties:  z.record(z.unknown()).optional().default({}),
  context: z.object({
    ip:        z.string().ip().optional(),
    userAgent: z.string().max(500).optional(),
    locale:    z.string().max(20).optional(),
    page: z.object({
      url:      z.string().url().optional(),
      path:     z.string().max(500).optional(),
      title:    z.string().max(500).optional(),
      referrer: z.string().optional(),
    }).optional(),
    device: z.object({
      type:         z.string().optional(),
      manufacturer: z.string().optional(),
      model:        z.string().optional(),
    }).optional(),
    os:  z.object({ name: z.string().optional(), version: z.string().optional() }).optional(),
    app: z.object({ name: z.string().optional(), version: z.string().optional() }).optional(),
  }).optional(),
});

export type IngestEvent = z.infer<typeof ingestEventSchema>;

export interface IngestResult {
  accepted: number;
  rejected: number;
  batchId: string;
  rejectionReasons?: Record<string, number>;
}

// ─── Query types ──────────────────────────────────────────────────────────────

export interface QueryEventsOptions {
  projectId: string;
  startDate?: Date;
  endDate?: Date;
  eventNames?: string[];
  userId?: string;
  sessionId?: string;
  countryCode?: string;
  deviceType?: string;
  groupBy?: GroupByColumn;
  aggregation?: AggregateMode;
  propertyFilter?: EventFilters["propertyFilter"];
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDir?: "ASC" | "DESC";
}

export interface EventQueryResult {
  columns: Array<{ name: string; type: string }>;
  rows: Record<string, unknown>[];
  rowCount: number;
  executionMs: number;
  truncated: boolean;
  sql: string;
}

// ─── Stats types ──────────────────────────────────────────────────────────────

export interface EventStats {
  projectId: string;
  period: { start: string; end: string };
  totals: {
    events: number;
    uniqueUsers: number;
    uniqueSessions: number;
    eventsToday: number;
    eventsTodayChange: number;   // % change vs yesterday
  };
  topEvents: Array<{ eventName: string; count: number; uniqueUsers: number }>;
  dauSparkline: Array<{ date: string; dau: number }>;
  deviceBreakdown: Array<{ deviceType: string; count: number; pct: number }>;
  countryBreakdown: Array<{ country: string; count: number; pct: number }>;
  hourlyDistribution: Array<{ hour: number; count: number }>;
}

// ─── ingestEvents ─────────────────────────────────────────────────────────────

export async function ingestEvents(
  projectId: string,
  events: IngestEvent[],
  batchId?: string
): Promise<IngestResult> {
  const resolvedBatchId = batchId ?? `batch_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();
  const MAX_FUTURE_MS = 7 * 24 * 60 * 60 * 1000;

  let accepted = 0;
  let rejected = 0;
  const rejectionReasons: Record<string, number> = {};

  const validRows: unknown[][] = [];

  for (const event of events) {
    // At least one identity is required
    if (!event.userId && !event.anonymousId) {
      rejected++;
      rejectionReasons["missing_user_identity"] = (rejectionReasons["missing_user_identity"] ?? 0) + 1;
      continue;
    }

    // Reject events with timestamps too far in the future
    const ts = event.timestamp ? new Date(event.timestamp) : new Date();
    if (ts.getTime() > Date.now() + MAX_FUTURE_MS) {
      rejected++;
      rejectionReasons["future_timestamp"] = (rejectionReasons["future_timestamp"] ?? 0) + 1;
      continue;
    }

    // Truncate properties to keep row size sane (guard against accidentally
    // sending large blobs in properties)
    const propsJson = JSON.stringify(event.properties ?? {});
    if (propsJson.length > 64_000) {
      rejected++;
      rejectionReasons["properties_too_large"] = (rejectionReasons["properties_too_large"] ?? 0) + 1;
      continue;
    }

    validRows.push([
      randomUUID(),                              // id
      projectId,                                 // project_id
      event.event,                               // event_name
      randomUUID(),                              // event_uuid
      event.userId ?? "",                        // user_id
      event.anonymousId ?? null,                 // anonymous_id
      event.sessionId ?? null,                   // session_id
      now,                                       // received_at
      event.sentAt ?? null,                      // sent_at
      ts.toISOString(),                          // timestamp
      event.context?.ip ?? null,                 // ip_address
      null,                                      // country_code (GeoIP in v2)
      null,                                      // city
      event.context?.device?.type ?? null,       // device_type
      event.context?.os?.name ?? null,           // os_name
      null,                                      // browser_name
      event.context?.app?.version ?? null,       // app_version
      propsJson,                                 // properties
      resolvedBatchId,                           // ingest_batch_id
      1,                                         // schema_version
    ]);

    accepted++;
  }

  if (validRows.length > 0) {
    await bulkInsert("events", [
      "id", "project_id", "event_name", "event_uuid",
      "user_id", "anonymous_id", "session_id",
      "received_at", "sent_at", "timestamp",
      "ip_address", "country_code", "city",
      "device_type", "os_name", "browser_name", "app_version",
      "properties", "ingest_batch_id", "schema_version",
    ], validRows);
  }

  return {
    accepted,
    rejected,
    batchId: resolvedBatchId,
    ...(rejected > 0 ? { rejectionReasons } : {}),
  };
}

// ─── queryEvents ──────────────────────────────────────────────────────────────

export async function queryEvents(
  opts: QueryEventsOptions
): Promise<EventQueryResult> {
  const builder = new EventQueryBuilder(opts.projectId);

  // Apply all filters
  if (opts.startDate && opts.endDate) builder.dateRange(opts.startDate, opts.endDate);
  if (opts.eventNames?.length) builder.eventNames(opts.eventNames);
  if (opts.userId) builder.user(opts.userId);
  if (opts.sessionId) builder.session(opts.sessionId);
  if (opts.countryCode) builder.country(opts.countryCode);
  if (opts.deviceType) builder.device(opts.deviceType);
  if (opts.groupBy) builder.groupBy(opts.groupBy);
  if (opts.aggregation) builder.aggregate(opts.aggregation);
  if (opts.propertyFilter) builder.propertyFilter(opts.propertyFilter);
  if (opts.limit) builder.limit(opts.limit);
  if (opts.offset) builder.offset(opts.offset);
  if (opts.orderBy) builder.orderBy(opts.orderBy, opts.orderDir);

  const { sql, params } = builder.build();

  const result = await executeQuery({
    sql,
    params,
    projectId: opts.projectId,
  });

  return { ...result, sql };
}

// ─── getEventStats ────────────────────────────────────────────────────────────

export async function getEventStats(
  projectId: string,
  daysBack = 30
): Promise<EventStats> {
  const db = getDuckDB();

  // Run all stat queries in parallel
  const [
    totalsResult,
    topEventsResult,
    dauResult,
    deviceResult,
    countryResult,
    hourlyResult,
  ] = await Promise.all([
    // Totals: current period vs yesterday for % change
    db.all(`
      SELECT
        count(*)                               AS total_events,
        count(distinct user_id)                AS unique_users,
        count(distinct session_id)             AS unique_sessions,
        count(*) FILTER (
          WHERE timestamp >= current_date
        )                                      AS events_today,
        count(*) FILTER (
          WHERE timestamp >= current_date - INTERVAL '1 day'
            AND timestamp < current_date
        )                                      AS events_yesterday
      FROM events
      WHERE project_id = ?
        AND timestamp >= now() - INTERVAL '${daysBack} days'
    `, projectId),

    // Top 10 events by count
    db.all(`
      SELECT
        event_name,
        count(*)                   AS event_count,
        count(distinct user_id)    AS unique_users
      FROM events
      WHERE project_id = ?
        AND timestamp >= now() - INTERVAL '${daysBack} days'
      GROUP BY event_name
      ORDER BY event_count DESC
      LIMIT 10
    `, projectId),

    // DAU sparkline — last 14 days
    db.all(`
      SELECT
        date_trunc('day', timestamp)::VARCHAR AS date,
        count(distinct user_id)               AS dau
      FROM events
      WHERE project_id = ?
        AND timestamp >= now() - INTERVAL '14 days'
      GROUP BY date_trunc('day', timestamp)
      ORDER BY 1
    `, projectId),

    // Device breakdown
    db.all(`
      SELECT
        coalesce(device_type, 'unknown') AS device_type,
        count(*)                         AS event_count
      FROM events
      WHERE project_id = ?
        AND timestamp >= now() - INTERVAL '${daysBack} days'
      GROUP BY device_type
      ORDER BY event_count DESC
    `, projectId),

    // Top 10 countries
    db.all(`
      SELECT
        coalesce(country_code, 'XX') AS country,
        count(*)                     AS event_count
      FROM events
      WHERE project_id = ?
        AND timestamp >= now() - INTERVAL '${daysBack} days'
      GROUP BY country_code
      ORDER BY event_count DESC
      LIMIT 10
    `, projectId),

    // Hourly distribution (0–23) across the whole period
    db.all(`
      SELECT
        CAST(hour(timestamp) AS INTEGER)  AS hour,
        count(*)                           AS event_count
      FROM events
      WHERE project_id = ?
        AND timestamp >= now() - INTERVAL '${daysBack} days'
      GROUP BY hour(timestamp)
      ORDER BY hour
    `, projectId),
  ]);

  const totals = totalsResult[0] ?? {};
  const eventsToday = Number(totals["events_today"] ?? 0);
  const eventsYesterday = Number(totals["events_yesterday"] ?? 0);
  const changePct =
    eventsYesterday === 0
      ? 0
      : Math.round(((eventsToday - eventsYesterday) / eventsYesterday) * 100);

  const totalDeviceEvents = deviceResult.reduce(
    (s, r) => s + Number(r["event_count"] ?? 0), 0
  );
  const totalCountryEvents = countryResult.reduce(
    (s, r) => s + Number(r["event_count"] ?? 0), 0
  );

  const start = new Date(Date.now() - daysBack * 86_400_000).toISOString();
  const end = new Date().toISOString();

  return {
    projectId,
    period: { start, end },
    totals: {
      events:             Number(totals["total_events"] ?? 0),
      uniqueUsers:        Number(totals["unique_users"] ?? 0),
      uniqueSessions:     Number(totals["unique_sessions"] ?? 0),
      eventsToday,
      eventsTodayChange:  changePct,
    },
    topEvents: topEventsResult.map((r) => ({
      eventName:   String(r["event_name"] ?? ""),
      count:       Number(r["event_count"] ?? 0),
      uniqueUsers: Number(r["unique_users"] ?? 0),
    })),
    dauSparkline: dauResult.map((r) => ({
      date: String(r["date"] ?? ""),
      dau:  Number(r["dau"] ?? 0),
    })),
    deviceBreakdown: deviceResult.map((r) => ({
      deviceType: String(r["device_type"] ?? "unknown"),
      count:      Number(r["event_count"] ?? 0),
      pct:        totalDeviceEvents > 0
        ? Math.round((Number(r["event_count"]) / totalDeviceEvents) * 100)
        : 0,
    })),
    countryBreakdown: countryResult.map((r) => ({
      country: String(r["country"] ?? "XX"),
      count:   Number(r["event_count"] ?? 0),
      pct:     totalCountryEvents > 0
        ? Math.round((Number(r["event_count"]) / totalCountryEvents) * 100)
        : 0,
    })),
    hourlyDistribution: hourlyResult.map((r) => ({
      hour:  Number(r["hour"] ?? 0),
      count: Number(r["event_count"] ?? 0),
    })),
  };
}

// ─── Funnel analysis ──────────────────────────────────────────────────────────

export interface FunnelResult {
  steps: Array<{
    eventName: string;
    users: number;
    conversionFromPrev: number | null;  // null for step 0
    dropOff: number | null;
  }>;
  overallConversion: number;
  sql: string;
}

export async function getFunnelStats(
  projectId: string,
  steps: string[],
  startDate: Date,
  endDate: Date
): Promise<FunnelResult> {
  const { sql, params } = buildFunnelQuery(projectId, steps, startDate, endDate);
  const db = getDuckDB();
  const rows = await db.all(sql, ...params);

  const row = rows[0] ?? {};
  const counts = steps.map((step) => Number(row[step] ?? 0));

  const resultSteps = steps.map((eventName, i) => ({
    eventName,
    users: counts[i]!,
    conversionFromPrev:
      i === 0
        ? null
        : counts[i - 1]! > 0
          ? Math.round((counts[i]! / counts[i - 1]!) * 100)
          : 0,
    dropOff:
      i === 0
        ? null
        : counts[i - 1]! - counts[i]!,
  }));

  const overallConversion =
    counts[0]! > 0 ? Math.round((counts[counts.length - 1]! / counts[0]!) * 100) : 0;

  return { steps: resultSteps, overallConversion, sql };
}
