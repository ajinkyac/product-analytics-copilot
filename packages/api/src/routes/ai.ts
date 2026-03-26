import { Router, type Request, type Response } from "express";
import type { Database } from "duckdb-async";
import { z } from "zod";
import { randomUUID } from "crypto";
import type { AIQueryRequest, AIQueryResponse } from "@copilot/shared";
import { generateSQL, narrateResult } from "../ai/sql-generator.js";
import { executeQuery, inferProjectSchema } from "../db/duckdb.js";
import { getPool } from "../db/postgres.js";
import { notifyQueryComplete } from "../services/websocket.js";

const requestSchema = z.object({
  question: z.string().min(3).max(500),
  projectId: z.string().uuid(),
  timeRange: z.enum(["1d", "7d", "14d", "30d", "90d", "180d", "365d", "custom"]).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export function aiRouter(db: Database): Router {
  const router = Router();

  /**
   * POST /v1/ai/query
   * Accepts a natural language question and returns SQL + executed result + narration.
   *
   * For fast queries (< 3s), responds synchronously.
   * For slow queries, returns { queryId } immediately and pushes result via WebSocket.
   */
  router.post("/query", async (req: Request, res: Response) => {
    const parse = requestSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "validation_error", message: parse.error.message });
    }

    const request: AIQueryRequest = parse.data;
    const queryId = randomUUID();

    // Verify project access
    const pool = getPool();
    const projectRow = await pool.query(
      `SELECT id, name, event_names, property_schema FROM projects WHERE id = $1`,
      [request.projectId]
    );

    if (projectRow.rows.length === 0) {
      return res.status(404).json({ error: "not_found", message: "Project not found" });
    }

    const project = projectRow.rows[0]!;

    // Use cached schema or infer fresh
    const schema = {
      projectId: request.projectId,
      projectName: project["name"] as string,
      eventNames: (project["event_names"] as string[]) ?? [],
      propertySchema: (project["property_schema"] as Record<string, string>) ?? {},
    };

    // For short questions, execute synchronously
    const isLikelyFast = !/funnel|cohort|retention/i.test(request.question);

    if (isLikelyFast) {
      const result = await runAIQuery(queryId, request, schema);
      return res.json(result);
    }

    // For complex queries, respond immediately with queryId and execute async
    res.status(202).json({ queryId, status: "processing" });

    runAIQuery(queryId, request, schema)
      .then((result) => notifyQueryComplete(queryId, result))
      .catch((err) => {
        console.error(`AI query ${queryId} failed:`, err);
        notifyQueryComplete(queryId, {
          queryId,
          sql: null,
          explanation: "Query failed",
          assumptions: [],
          confidence: 0,
          suggestedChartType: "table",
          answerable: false,
        });
      });
  });

  return router;
}

async function runAIQuery(
  queryId: string,
  request: AIQueryRequest,
  schema: { projectId: string; projectName: string; eventNames: string[]; propertySchema: Record<string, string> }
): Promise<AIQueryResponse> {
  // 1. Generate SQL
  const generated = await generateSQL(request, schema);

  if (!generated.answerable || !generated.sql) {
    return {
      queryId,
      sql: null,
      explanation: generated.explanation,
      assumptions: generated.assumptions,
      confidence: generated.confidence,
      suggestedChartType: generated.suggestedChartType,
      answerable: false,
    };
  }

  // 2. Execute the SQL
  const execResult = await executeQuery({
    sql: generated.sql,
    projectId: request.projectId,
    timeoutMs: 30_000,
    maxRows: 10_000,
  });

  // 3. Narrate the result
  const summary = await narrateResult(
    request.question,
    generated.sql,
    execResult.rows,
    execResult.rowCount
  );

  return {
    queryId,
    sql: generated.sql,
    explanation: generated.explanation,
    assumptions: generated.assumptions,
    confidence: generated.confidence,
    suggestedChartType: generated.suggestedChartType,
    answerable: true,
    result: {
      queryId,
      sql: generated.sql,
      columns: execResult.columns.map((c) => ({
        name: c.name,
        type: c.type as "string" | "number" | "boolean" | "date" | "json",
      })),
      rows: execResult.rows,
      rowCount: execResult.rowCount,
      executionMs: execResult.executionMs,
      cached: false,
      truncated: execResult.truncated,
    },
    summary,
    executionMs: execResult.executionMs,
  };
}
