import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createServer } from "http";

import { ingestRouter } from "./routes/ingest.js";
import { queryRouter } from "./routes/queries.js";
import { aiRouter } from "./routes/ai.js";
import { dashboardRouter } from "./routes/dashboards.js";
import { projectRouter } from "./routes/projects.js";
import { authRouter } from "./routes/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { authMiddleware } from "./middleware/auth.js";
import { requestLogger } from "./middleware/request-logger.js";
import { setupWebSocket } from "./services/websocket.js";
import { initDuckDB } from "./db/duckdb.js";
import { runMigrations } from "./db/postgres.js";

const PORT = parseInt(process.env["PORT"] ?? "3001", 10);
const CORS_ORIGINS = (process.env["CORS_ORIGINS"] ?? "http://localhost:5173").split(",");

async function bootstrap() {
  // Initialize databases
  await runMigrations();
  const db = await initDuckDB();

  const app = express();
  const httpServer = createServer(app);

  // ── Global middleware ──────────────────────────────────────────────────────
  app.use(helmet());
  app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
  app.use(express.json({ limit: `${process.env["INGEST_MAX_BODY_KB"] ?? 512}kb` }));
  app.use(requestLogger);

  // ── Health check (no auth) ─────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: "0.1.0", timestamp: new Date().toISOString() });
  });

  // ── Ingest (write-key auth, not JWT) ───────────────────────────────────────
  app.use("/v1/ingest", ingestRouter(db));

  // ── Auth routes (no JWT required) ─────────────────────────────────────────
  app.use("/v1/auth", authRouter);

  // ── Protected routes ───────────────────────────────────────────────────────
  app.use("/v1", authMiddleware);
  app.use("/v1/projects", projectRouter);
  app.use("/v1/queries", queryRouter(db));
  app.use("/v1/ai", aiRouter(db));
  app.use("/v1/dashboards", dashboardRouter);

  // ── Error handler (must be last) ──────────────────────────────────────────
  app.use(errorHandler);

  // ── WebSocket ─────────────────────────────────────────────────────────────
  setupWebSocket(httpServer);

  httpServer.listen(PORT, () => {
    console.log(`\n🚀 API server running on http://localhost:${PORT}`);
    console.log(`   WebSocket: ws://localhost:${PORT}`);
    console.log(`   Environment: ${process.env["NODE_ENV"] ?? "development"}\n`);
  });
}

bootstrap().catch((err) => {
  console.error("Failed to start API server:", err);
  process.exit(1);
});
