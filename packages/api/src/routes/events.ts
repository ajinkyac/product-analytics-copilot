/**
 * /api/events — event ingest, query, and stats endpoints.
 *
 * POST /api/events/ingest — accepts JSON batch or CSV file upload
 * GET  /api/events/query  — parameterized filter query
 * GET  /api/events/stats  — dashboard summary stats
 * POST /api/events/funnel — funnel analysis
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { parse as parseCsv } from "csv-parse";
import { z } from "zod";
import { getPool } from "../db/postgres.js";
import {
  ingestEvents,
  queryEvents,
  getEventStats,
  getFunnelStats,
  ingestEventSchema,
  type IngestEvent,
} from "../services/event-service.js";

// ─── Multer (in-memory, max 10MB) ─────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!["text/csv", "application/csv", "text/plain"].includes(file.mimetype)) {
      cb(new Error("Only CSV files are accepted"));
      return;
    }
    cb(null, true);
  },
});

// ─── Validation schemas ───────────────────────────────────────────────────────

const jsonIngestSchema = z.object({
  projectId: z.string().uuid(),
  batch:     z.array(ingestEventSchema).min(1).max(2000),
});

const queryParamsSchema = z.object({
  projectId:   z.string().uuid(),
  startDate:   z.string().datetime({ offset: true }).optional(),
  endDate:     z.string().datetime({ offset: true }).optional(),
  eventNames:  z.string().optional(),   // comma-separated
  userId:      z.string().optional(),
  sessionId:   z.string().optional(),
  countryCode: z.string().length(2).toUpperCase().optional(),
  deviceType:  z.enum(["desktop", "mobile", "tablet"]).optional(),
  groupBy:     z.enum([
    "event_name", "country_code", "device_type", "os_name", "browser_name",
    "user_id", "session_id", "hour", "day", "week", "month",
  ]).optional(),
  aggregation: z.enum(["count", "unique_users", "count_and_unique", "raw"]).optional(),
  propKey:     z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/).optional(),
  propOp:      z.enum(["eq", "neq", "in", "nin", "gt", "gte", "lt", "lte", "contains"]).optional(),
  propValue:   z.string().optional(),
  limit:       z.coerce.number().int().min(1).max(10000).default(1000),
  offset:      z.coerce.number().int().min(0).default(0),
  orderBy:     z.string().optional(),
  orderDir:    z.enum(["ASC", "DESC"]).default("DESC"),
});

const statsParamsSchema = z.object({
  projectId: z.string().uuid(),
  daysBack:  z.coerce.number().int().min(1).max(365).default(30),
});

const funnelBodySchema = z.object({
  projectId: z.string().uuid(),
  steps:     z.array(z.string().min(1).max(200)).min(2).max(8),
  startDate: z.string().datetime({ offset: true }),
  endDate:   z.string().datetime({ offset: true }),
});

// ─── Write-key auth middleware (used for ingest endpoints) ────────────────────

async function resolveProjectFromWriteKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Support both Authorization header and X-Write-Key header
  const authHeader = req.headers.authorization;
  const writeKeyHeader = req.headers["x-write-key"] as string | undefined;
  const writeKey = writeKeyHeader ?? (authHeader?.startsWith("Bearer wk_") ? authHeader.slice(7) : null);

  if (!writeKey) {
    res.status(401).json({ error: "unauthorized", message: "Missing write key. Use Authorization: Bearer wk_... or X-Write-Key header." });
    return;
  }

  const pool = getPool();
  const result = await pool.query(
    `SELECT id FROM projects WHERE write_key = $1 AND archived_at IS NULL`,
    [writeKey]
  );

  if (result.rows.length === 0) {
    res.status(401).json({ error: "unauthorized", message: "Invalid or revoked write key" });
    return;
  }

  (req as Request & { resolvedProjectId: string }).resolvedProjectId =
    result.rows[0]!["id"] as string;

  next();
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const eventsRouter = Router();

// ─── POST /api/events/ingest (JSON) ──────────────────────────────────────────

eventsRouter.post(
  "/ingest",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parse = jsonIngestSchema.safeParse(req.body);
      if (!parse.success) {
        return res.status(400).json({
          error:   "validation_error",
          message: parse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        });
      }

      const { projectId, batch } = parse.data;

      // Verify project exists (JWT-auth path — project comes from body, not write key)
      const pool = getPool();
      const projectRow = await pool.query(
        `SELECT id FROM projects WHERE id = $1 AND archived_at IS NULL`,
        [projectId]
      );
      if (projectRow.rows.length === 0) {
        return res.status(404).json({ error: "not_found", message: "Project not found" });
      }

      const result = await ingestEvents(projectId, batch as IngestEvent[]);
      return res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/events/ingest/csv — CSV file upload ────────────────────────────
// Accepts multipart/form-data with:
//   - file: the CSV file
//   - projectId: target project UUID

eventsRouter.post(
  "/ingest/csv",
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "missing_file", message: "No CSV file uploaded" });
      }

      const projectId = req.body["projectId"] as string | undefined;
      if (!projectId) {
        return res.status(400).json({ error: "missing_field", message: "projectId is required" });
      }

      // Parse the CSV buffer
      const events = await parseCsvBuffer(req.file.buffer);

      if (events.length === 0) {
        return res.status(400).json({ error: "empty_file", message: "CSV contains no valid rows" });
      }

      // Cap at 50k rows per upload
      const batch = events.slice(0, 50_000);

      const result = await ingestEvents(projectId, batch);
      return res.status(200).json({
        ...result,
        totalRows: events.length,
        processedRows: batch.length,
        skippedRows: events.length - batch.length,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/events/ingest/sdk — write-key authenticated ingest ─────────────
// Used by client SDKs. Identical to the JWT route but auth is via write key.

eventsRouter.post(
  "/ingest/sdk",
  resolveProjectFromWriteKey,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = (req as Request & { resolvedProjectId: string }).resolvedProjectId;

      const batchParse = z
        .object({ batch: z.array(ingestEventSchema).min(1).max(500) })
        .safeParse(req.body);

      if (!batchParse.success) {
        return res.status(400).json({
          error:   "validation_error",
          message: batchParse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        });
      }

      const result = await ingestEvents(projectId, batchParse.data.batch as IngestEvent[]);
      return res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/events/query ────────────────────────────────────────────────────

eventsRouter.get(
  "/query",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parse = queryParamsSchema.safeParse(req.query);
      if (!parse.success) {
        return res.status(400).json({
          error:   "validation_error",
          message: parse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        });
      }

      const q = parse.data;

      // Resolve property filter (all three parts must be present together)
      let propertyFilter: Parameters<typeof queryEvents>[0]["propertyFilter"];
      if (q.propKey && q.propOp && q.propValue !== undefined) {
        propertyFilter = {
          property: q.propKey,
          operator: q.propOp,
          value:    q.propOp === "in" || q.propOp === "nin"
            ? q.propValue.split(",").map((v) => v.trim())
            : q.propValue,
        };
      }

      const result = await queryEvents({
        projectId:      q.projectId,
        startDate:      q.startDate ? new Date(q.startDate) : undefined,
        endDate:        q.endDate ? new Date(q.endDate) : undefined,
        eventNames:     q.eventNames ? q.eventNames.split(",").map((e) => e.trim()) : undefined,
        userId:         q.userId,
        sessionId:      q.sessionId,
        countryCode:    q.countryCode,
        deviceType:     q.deviceType,
        groupBy:        q.groupBy,
        aggregation:    q.aggregation,
        propertyFilter,
        limit:          q.limit,
        offset:         q.offset,
        orderBy:        q.orderBy,
        orderDir:       q.orderDir,
      });

      return res.json({
        data:        result.rows,
        columns:     result.columns,
        rowCount:    result.rowCount,
        executionMs: result.executionMs,
        truncated:   result.truncated,
        sql:         result.sql,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/events/stats ────────────────────────────────────────────────────

eventsRouter.get(
  "/stats",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parse = statsParamsSchema.safeParse(req.query);
      if (!parse.success) {
        return res.status(400).json({
          error:   "validation_error",
          message: parse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        });
      }

      const stats = await getEventStats(parse.data.projectId, parse.data.daysBack);
      return res.json(stats);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/events/funnel ──────────────────────────────────────────────────

eventsRouter.post(
  "/funnel",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parse = funnelBodySchema.safeParse(req.body);
      if (!parse.success) {
        return res.status(400).json({
          error:   "validation_error",
          message: parse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        });
      }

      const { projectId, steps, startDate, endDate } = parse.data;

      const result = await getFunnelStats(
        projectId,
        steps,
        new Date(startDate),
        new Date(endDate)
      );

      return res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ─── CSV parser ───────────────────────────────────────────────────────────────

/**
 * Expected CSV columns (all optional except event_name and at least one identity):
 *   event_name, user_id, anonymous_id, session_id, timestamp,
 *   country_code, device_type, properties_json
 */
async function parseCsvBuffer(buffer: Buffer): Promise<IngestEvent[]> {
  return new Promise((resolve, reject) => {
    const events: IngestEvent[] = [];

    const parser = parseCsv(buffer, {
      columns:          true,
      skip_empty_lines: true,
      trim:             true,
      bom:              true,
    });

    parser.on("data", (row: Record<string, string>) => {
      const eventName = row["event_name"] ?? row["event"];
      if (!eventName) return; // skip rows with no event name

      let properties: Record<string, unknown> = {};
      const propsRaw = row["properties_json"] ?? row["properties"];
      if (propsRaw) {
        try {
          properties = JSON.parse(propsRaw) as Record<string, unknown>;
        } catch {
          // If properties aren't JSON, treat them as a single string value
          properties = { raw: propsRaw };
        }
      }

      // Map any extra columns not explicitly handled into properties
      const knownColumns = new Set([
        "event_name", "event", "user_id", "anonymous_id", "session_id",
        "timestamp", "sent_at", "country_code", "device_type",
        "os_name", "browser_name", "app_version",
        "properties_json", "properties",
      ]);
      for (const [k, v] of Object.entries(row)) {
        if (!knownColumns.has(k) && v) properties[k] = v;
      }

      events.push({
        event:       eventName,
        userId:      row["user_id"] || undefined,
        anonymousId: row["anonymous_id"] || undefined,
        sessionId:   row["session_id"] || undefined,
        timestamp:   row["timestamp"] || undefined,
        sentAt:      row["sent_at"] || undefined,
        properties,
        context: {
          device: row["device_type"] ? { type: row["device_type"] } : undefined,
          os:     row["os_name"] ? { name: row["os_name"] } : undefined,
          app:    row["app_version"] ? { version: row["app_version"] } : undefined,
        },
      });
    });

    parser.on("error", reject);
    parser.on("end", () => resolve(events));
  });
}
