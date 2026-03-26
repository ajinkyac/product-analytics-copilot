import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

const IS_DEV = process.env["NODE_ENV"] !== "production";

// ANSI color codes (dev only — disabled in prod for structured log parsing)
const C = {
  reset:  "\x1b[0m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  cyan:   "\x1b[36m",
  blue:   "\x1b[34m",
  white:  "\x1b[37m",
};

function statusColor(code: number): string {
  if (!IS_DEV) return "";
  if (code >= 500) return C.red;
  if (code >= 400) return C.yellow;
  if (code >= 300) return C.cyan;
  return C.green;
}

function methodColor(method: string): string {
  if (!IS_DEV) return "";
  const map: Record<string, string> = {
    GET: C.green, POST: C.blue, PUT: C.cyan,
    PATCH: C.yellow, DELETE: C.red,
  };
  return map[method] ?? C.white;
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      startTime: number;
    }
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  req.requestId = randomUUID().slice(0, 8);
  req.startTime = Date.now();

  // Attach request ID to response headers (useful for client-side correlation)
  res.setHeader("X-Request-Id", req.requestId);

  res.on("finish", () => {
    const durationMs = Date.now() - req.startTime;
    const status = res.statusCode;
    const method = req.method;
    const url = req.originalUrl || req.url;

    if (IS_DEV) {
      // Pretty dev format:
      //   [abc12345] GET /v1/events/stats 200 42ms
      const sc = statusColor(status);
      const mc = methodColor(method);
      const r = C.reset;
      const dim = C.dim;

      const contentLength = res.getHeader("content-length");
      const sizeStr = contentLength ? ` ${dim}${formatBytes(Number(contentLength))}${r}` : "";

      console.log(
        `${dim}[${req.requestId}]${r} ${mc}${method}${r} ${url} ${sc}${status}${r} ${durationMs}ms${sizeStr}`
      );

      // Log slow requests as a warning
      if (durationMs > 2000) {
        console.warn(`  ⚠️  Slow request: ${method} ${url} took ${durationMs}ms`);
      }
    } else {
      // Structured JSON for production log aggregators
      process.stdout.write(
        JSON.stringify({
          level:      status >= 500 ? "error" : status >= 400 ? "warn" : "info",
          type:       "request",
          requestId:  req.requestId,
          method,
          url,
          status,
          durationMs,
          userAgent:  req.headers["user-agent"] ?? null,
          ip:         req.ip ?? req.socket.remoteAddress ?? null,
        }) + "\n"
      );
    }
  });

  next();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
