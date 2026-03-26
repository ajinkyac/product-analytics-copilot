import { Router, type Request, type Response } from "express";
import type { Database } from "duckdb-async";
import { z } from "zod";
import { randomUUID } from "crypto";
import { getPool } from "../db/postgres.js";

const MAX_BATCH_SIZE = parseInt(process.env["INGEST_MAX_BATCH_SIZE"] ?? "500", 10);

const eventSchema = z.object({
  event: z.string().min(1).max(200),
  userId: z.string().max(500).optional(),
  anonymousId: z.string().max(500).optional(),
  sessionId: z.string().max(200).optional(),
  timestamp: z.string().datetime().optional(),
  sentAt: z.string().datetime().optional(),
  properties: z.record(z.unknown()).optional().default({}),
  context: z
    .object({
      ip: z.string().optional(),
      userAgent: z.string().optional(),
      locale: z.string().optional(),
      page: z
        .object({
          url: z.string().optional(),
          path: z.string().optional(),
          title: z.string().optional(),
          referrer: z.string().optional(),
        })
        .optional(),
      device: z
        .object({ type: z.string().optional(), manufacturer: z.string().optional(), model: z.string().optional() })
        .optional(),
      os: z.object({ name: z.string().optional(), version: z.string().optional() }).optional(),
      app: z.object({ name: z.string().optional(), version: z.string().optional() }).optional(),
    })
    .optional(),
});

const batchSchema = z.object({
  batch: z.array(eventSchema).min(1).max(MAX_BATCH_SIZE),
});

export function ingestRouter(db: Database): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    // Authenticate via write key
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer wk_")) {
      return res.status(401).json({ error: "unauthorized", message: "Missing or invalid write key" });
    }
    const writeKey = authHeader.slice(7);

    // Resolve project from write key
    const pool = getPool();
    const projectResult = await pool.query(
      `SELECT id FROM projects WHERE write_key = $1 AND archived_at IS NULL`,
      [writeKey]
    );

    if (projectResult.rows.length === 0) {
      return res.status(401).json({ error: "unauthorized", message: "Invalid write key" });
    }

    const projectId = projectResult.rows[0]!["id"] as string;

    // Validate batch
    const parse = batchSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "validation_error", message: parse.error.message });
    }

    const { batch } = parse.data;
    const batchId = `batch_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();

    let accepted = 0;
    let rejected = 0;
    const rejectionReasons: Record<string, number> = {};

    const validEvents: unknown[][] = [];

    for (const event of batch) {
      // At least one of userId or anonymousId is required
      if (!event.userId && !event.anonymousId) {
        rejected++;
        rejectionReasons["missing_user_identity"] = (rejectionReasons["missing_user_identity"] ?? 0) + 1;
        continue;
      }

      // Reject events with timestamps more than 7 days in the future
      const ts = event.timestamp ? new Date(event.timestamp) : new Date();
      const maxFuture = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      if (ts > maxFuture) {
        rejected++;
        rejectionReasons["future_timestamp"] = (rejectionReasons["future_timestamp"] ?? 0) + 1;
        continue;
      }

      validEvents.push([
        randomUUID(),
        projectId,
        event.event,
        randomUUID(), // event_uuid
        event.userId ?? "",
        event.anonymousId ?? null,
        event.sessionId ?? null,
        now, // received_at
        event.sentAt ?? null,
        ts.toISOString(),
        event.context?.ip ?? null,
        null, // country_code (would be GeoIP-resolved in production)
        null, // city
        event.context?.device?.type ?? null,
        event.context?.os?.name ?? null,
        null, // browser_name
        event.context?.app?.version ?? null,
        JSON.stringify(event.properties ?? {}),
        batchId,
        1, // schema_version
      ]);

      accepted++;
    }

    // Bulk insert into DuckDB
    if (validEvents.length > 0) {
      const placeholders = validEvents
        .map(
          () =>
            "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .join(", ");

      await db.run(
        `INSERT INTO events (id, project_id, event_name, event_uuid, user_id, anonymous_id, session_id, received_at, sent_at, timestamp, ip_address, country_code, city, device_type, os_name, browser_name, app_version, properties, ingest_batch_id, schema_version) VALUES ${placeholders}`,
        ...validEvents.flat()
      );
    }

    return res.status(200).json({
      accepted,
      rejected,
      batchId,
      ...(rejected > 0 ? { rejectionReasons } : {}),
    });
  });

  // Segment-compatible /track endpoint
  router.post("/track", async (req: Request, res: Response) => {
    // Rewrite Segment's track payload to our batch format
    const { event, userId, anonymousId, properties, timestamp, sentAt, context } = req.body as Record<string, unknown>;

    req.body = {
      batch: [{ event, userId, anonymousId, properties, timestamp, sentAt, context }],
    };

    // Delegate to the main ingest handler
    return res.redirect(307, "/v1/ingest");
  });

  return router;
}
