import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { randomBytes } from "crypto";
import { getPool } from "../db/postgres.js";
import { inferProjectSchema } from "../db/duckdb.js";

export const projectRouter = Router();

const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

projectRouter.post("/", async (req: Request, res: Response) => {
  const parse = createProjectSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "validation_error", message: parse.error.message });
  }

  const { name, description, color } = parse.data;
  const workspaceId = req.workspaceId;
  const pool = getPool();

  const suffix = `proj_${randomBytes(8).toString("hex")}`;
  const result = await pool.query(
    `INSERT INTO projects (workspace_id, name, description, color, duckdb_table_suffix)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [workspaceId, name, description ?? null, color ?? null, suffix]
  );

  return res.status(201).json(result.rows[0]);
});

projectRouter.get("/", async (req: Request, res: Response) => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM projects WHERE workspace_id = $1 AND archived_at IS NULL ORDER BY created_at DESC`,
    [req.workspaceId]
  );
  return res.json({ data: result.rows });
});

projectRouter.get("/:id", async (req: Request, res: Response) => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM projects WHERE id = $1 AND workspace_id = $2`,
    [req.params["id"], req.workspaceId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "not_found", message: "Project not found" });
  }

  return res.json(result.rows[0]);
});

// Refresh schema inference
projectRouter.post("/:id/refresh-schema", async (req: Request, res: Response) => {
  const projectId = req.params["id"]!;
  const pool = getPool();

  const { eventNames, propertySchema } = await inferProjectSchema(projectId);

  await pool.query(
    `UPDATE projects SET event_names = $1, property_schema = $2, last_schema_refresh = now(), updated_at = now() WHERE id = $3`,
    [JSON.stringify(eventNames), JSON.stringify(propertySchema), projectId]
  );

  return res.json({ eventNames, propertySchema, refreshedAt: new Date().toISOString() });
});
