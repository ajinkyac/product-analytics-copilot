import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

interface JWTPayload {
  userId: string;
  workspaceId: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      userId: string;
      workspaceId: string;
      userEmail: string;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized", message: "Missing authorization header" });
    return;
  }

  const token = authHeader.slice(7);
  const secret = process.env["JWT_SECRET"];

  if (!secret) {
    res.status(500).json({ error: "server_error", message: "JWT secret not configured" });
    return;
  }

  try {
    const payload = jwt.verify(token, secret) as JWTPayload;
    req.userId = payload.userId;
    req.workspaceId = payload.workspaceId;
    req.userEmail = payload.email;
    next();
  } catch {
    res.status(401).json({ error: "unauthorized", message: "Invalid or expired token" });
  }
}
