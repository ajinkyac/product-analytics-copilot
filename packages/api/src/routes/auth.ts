import { Router, type Request, type Response } from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { createHash, randomBytes } from "crypto";
import { getPool } from "../db/postgres.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(100),
  workspaceName: z.string().min(1).max(100),
});

function hashPassword(password: string): string {
  // In production, use bcrypt. Using SHA-256 here for scaffold simplicity.
  return createHash("sha256").update(password).digest("hex");
}

function generateToken(userId: string, workspaceId: string, email: string): string {
  return jwt.sign(
    { userId, workspaceId, email },
    process.env["JWT_SECRET"] ?? "dev-secret",
    { expiresIn: process.env["JWT_EXPIRES_IN"] ?? "7d" }
  );
}

authRouter.post("/register", async (req: Request, res: Response) => {
  const parse = registerSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "validation_error", message: parse.error.message });
  }

  const { email, password, name, workspaceName } = parse.data;
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Create user
    const userResult = await client.query(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name`,
      [email, name, hashPassword(password)]
    );
    const user = userResult.rows[0]!;

    // Create workspace
    const slug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const wsResult = await client.query(
      `INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`,
      [workspaceName, `${slug}-${randomBytes(3).toString("hex")}`]
    );
    const workspace = wsResult.rows[0]!;

    // Add user as owner
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, accepted_at) VALUES ($1, $2, 'owner', now())`,
      [workspace["id"], user["id"]]
    );

    await client.query("COMMIT");

    const token = generateToken(user["id"] as string, workspace["id"] as string, user["email"] as string);
    return res.status(201).json({ token, user: { id: user["id"], email: user["email"], name: user["name"] } });
  } catch (err: unknown) {
    await client.query("ROLLBACK");
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: "conflict", message: "Email already in use" });
    }
    throw err;
  } finally {
    client.release();
  }
});

authRouter.post("/login", async (req: Request, res: Response) => {
  const parse = loginSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "validation_error", message: parse.error.message });
  }

  const { email, password } = parse.data;
  const pool = getPool();

  const userResult = await pool.query(
    `SELECT u.id, u.email, u.name, u.password_hash, wm.workspace_id
     FROM users u
     JOIN workspace_members wm ON wm.user_id = u.id
     WHERE u.email = $1
     LIMIT 1`,
    [email]
  );

  const user = userResult.rows[0];
  if (!user || user["password_hash"] !== hashPassword(password)) {
    return res.status(401).json({ error: "unauthorized", message: "Invalid email or password" });
  }

  await pool.query(`UPDATE users SET last_active_at = now() WHERE id = $1`, [user["id"]]);

  const token = generateToken(user["id"] as string, user["workspace_id"] as string, user["email"] as string);
  return res.json({ token, user: { id: user["id"], email: user["email"], name: user["name"] } });
});
