import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { randomBytes } from "crypto";
import { getPool } from "../db/postgres.js";

export const dashboardRouter = Router();

const createDashboardSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  emoji: z.string().optional().default("📊"),
});

const updateLayoutSchema = z.object({
  layout: z.array(z.object({
    i: z.string(),
    x: z.number().int(),
    y: z.number().int(),
    w: z.number().int().min(1),
    h: z.number().int().min(1),
  })),
});

dashboardRouter.post("/", async (req: Request, res: Response) => {
  const parse = createDashboardSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "validation_error", message: parse.error.message });
  }

  const { projectId, title, description, emoji } = parse.data;
  const pool = getPool();

  const result = await pool.query(
    `INSERT INTO dashboards (project_id, created_by, title, description, emoji)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [projectId, req.userId, title, description ?? null, emoji]
  );

  return res.status(201).json(result.rows[0]);
});

dashboardRouter.get("/", async (req: Request, res: Response) => {
  const projectId = req.query["projectId"] as string;
  if (!projectId) {
    return res.status(400).json({ error: "missing_param", message: "projectId is required" });
  }

  const pool = getPool();
  const result = await pool.query(
    `SELECT d.*, array_agg(row_to_json(dw.*)) FILTER (WHERE dw.id IS NOT NULL) AS widgets
     FROM dashboards d
     LEFT JOIN dashboard_widgets dw ON dw.dashboard_id = d.id
     WHERE d.project_id = $1 AND d.deleted_at IS NULL
     GROUP BY d.id
     ORDER BY d.updated_at DESC`,
    [projectId]
  );

  return res.json({ data: result.rows });
});

dashboardRouter.get("/:id", async (req: Request, res: Response) => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT d.*, array_agg(row_to_json(dw.*)) FILTER (WHERE dw.id IS NOT NULL) AS widgets
     FROM dashboards d
     LEFT JOIN dashboard_widgets dw ON dw.dashboard_id = d.id
     WHERE d.id = $1 AND d.deleted_at IS NULL
     GROUP BY d.id`,
    [req.params["id"]]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "not_found", message: "Dashboard not found" });
  }

  return res.json(result.rows[0]);
});

dashboardRouter.patch("/:id/layout", async (req: Request, res: Response) => {
  const parse = updateLayoutSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "validation_error", message: parse.error.message });
  }

  const pool = getPool();
  await pool.query(
    `UPDATE dashboards SET layout = $1, updated_at = now() WHERE id = $2`,
    [JSON.stringify(parse.data.layout), req.params["id"]]
  );

  return res.status(204).send();
});

// Create public share link
dashboardRouter.post("/:id/share", async (req: Request, res: Response) => {
  const token = randomBytes(24).toString("base64url");
  const pool = getPool();

  await pool.query(
    `UPDATE dashboards SET is_public = true, public_token = $1, updated_at = now() WHERE id = $2`,
    [token, req.params["id"]]
  );

  return res.json({ publicToken: token });
});

dashboardRouter.delete("/:id", async (req: Request, res: Response) => {
  const pool = getPool();
  await pool.query(
    `UPDATE dashboards SET deleted_at = now() WHERE id = $1`,
    [req.params["id"]]
  );
  return res.status(204).send();
});
