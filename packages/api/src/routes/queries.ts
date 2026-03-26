import { Router, type Request, type Response } from "express";
import type { Database } from "duckdb-async";
import { z } from "zod";
import { LRUCache } from "lru-cache";
import { createHash } from "crypto";
import { executeQuery } from "../db/duckdb.js";
import { getPool } from "../db/postgres.js";
import type { QueryResult } from "@copilot/shared";

// ─── Query result cache ───────────────────────────────────────────────────────

const queryCache = new LRUCache<string, QueryResult>({
  max: 500,
  maxSize: 200 * 1024 * 1024, // 200MB
  sizeCalculation: (v) => JSON.stringify(v).length,
  ttl: 5 * 60 * 1000, // 5 minutes
});

function cacheKey(sql: string, projectId: string): string {
  return createHash("sha256")
    .update(`${projectId}:${sql.toLowerCase().replace(/\s+/g, " ").trim()}`)
    .digest("hex");
}

const executeSqlSchema = z.object({
  sql: z.string().min(1).max(10_000),
  projectId: z.string().uuid(),
  noCache: z.boolean().optional().default(false),
});

const saveQuerySchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  sql: z.string().min(1),
  description: z.string().optional(),
  nlQuestion: z.string().optional(),
  chartType: z.enum(["line", "bar", "area", "pie", "metric", "funnel", "table", "heatmap"]).optional(),
  chartConfig: z.record(z.unknown()).optional(),
  timeRange: z.enum(["1d", "7d", "14d", "30d", "90d", "180d", "365d", "custom"]).optional(),
  aiGenerated: z.boolean().optional(),
  aiModel: z.string().optional(),
  aiConfidence: z.number().optional(),
  aiExplanation: z.string().optional(),
});

export function queryRouter(db: Database): Router {
  const router = Router();

  // POST /v1/queries/execute — run arbitrary SQL
  router.post("/execute", async (req: Request, res: Response) => {
    const parse = executeSqlSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "validation_error", message: parse.error.message });
    }

    const { sql, projectId, noCache } = parse.data;

    // Basic mutation guard
    if (/^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)/i.test(sql)) {
      return res.status(400).json({ error: "forbidden_sql", message: "Only SELECT queries are allowed" });
    }

    const key = cacheKey(sql, projectId);
    if (!noCache) {
      const cached = queryCache.get(key);
      if (cached) {
        return res.json({ ...cached, cached: true });
      }
    }

    const result = await executeQuery({ sql, projectId, timeoutMs: 30_000 });

    const response: QueryResult = {
      queryId: key.slice(0, 8),
      sql,
      columns: result.columns.map((c) => ({
        name: c.name,
        type: c.type as "string" | "number" | "boolean" | "date" | "json",
      })),
      rows: result.rows,
      rowCount: result.rowCount,
      executionMs: result.executionMs,
      cached: false,
      truncated: result.truncated,
    };

    queryCache.set(key, response);
    return res.json(response);
  });

  // POST /v1/queries — save a query
  router.post("/", async (req: Request, res: Response) => {
    const parse = saveQuerySchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "validation_error", message: parse.error.message });
    }

    const data = parse.data;
    const userId = (req as Request & { userId: string }).userId;
    const pool = getPool();

    const result = await pool.query(
      `INSERT INTO saved_queries (project_id, created_by, title, description, nl_question, sql,
        ai_generated, ai_model, ai_confidence, ai_explanation,
        chart_type, chart_config, time_range)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        data.projectId,
        userId,
        data.title,
        data.description ?? null,
        data.nlQuestion ?? null,
        data.sql,
        data.aiGenerated ?? false,
        data.aiModel ?? null,
        data.aiConfidence ?? null,
        data.aiExplanation ?? null,
        data.chartType ?? "table",
        JSON.stringify(data.chartConfig ?? {}),
        data.timeRange ?? "30d",
      ]
    );

    return res.status(201).json(result.rows[0]);
  });

  // GET /v1/queries?projectId=... — list saved queries
  router.get("/", async (req: Request, res: Response) => {
    const projectId = req.query["projectId"] as string;
    if (!projectId) {
      return res.status(400).json({ error: "missing_param", message: "projectId is required" });
    }

    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM saved_queries WHERE project_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
      [projectId]
    );

    return res.json({ data: result.rows });
  });

  // GET /v1/queries/:id
  router.get("/:id", async (req: Request, res: Response) => {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM saved_queries WHERE id = $1 AND deleted_at IS NULL`,
      [req.params["id"]]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "not_found", message: "Query not found" });
    }

    return res.json(result.rows[0]);
  });

  // DELETE /v1/queries/:id — soft delete
  router.delete("/:id", async (req: Request, res: Response) => {
    const pool = getPool();
    await pool.query(
      `UPDATE saved_queries SET deleted_at = now() WHERE id = $1`,
      [req.params["id"]]
    );
    return res.status(204).send();
  });

  return router;
}
