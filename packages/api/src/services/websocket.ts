import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import jwt from "jsonwebtoken";
import type { WSMessage, AIQueryResponse } from "@copilot/shared";

// Map of queryId → Set of WebSocket connections waiting for it
const querySubscriptions = new Map<string, Set<WebSocket>>();

// Map of userId → WebSocket connection (one connection per user for simplicity)
const userConnections = new Map<string, WebSocket>();

export function setupWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // Authenticate via token in query string: ?token=<jwt>
    const url = new URL(req.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token");

    if (!token) {
      ws.close(1008, "Authentication required");
      return;
    }

    let userId: string;
    try {
      const payload = jwt.verify(token, process.env["JWT_SECRET"] ?? "") as { userId: string };
      userId = payload.userId;
    } catch {
      ws.close(1008, "Invalid token");
      return;
    }

    userConnections.set(userId, ws);

    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as WSMessage;

        if (message.type === "ping") {
          const pong: WSMessage = { type: "pong" };
          ws.send(JSON.stringify(pong));
        }
      } catch {
        // Ignore unparseable messages
      }
    });

    ws.on("close", () => {
      userConnections.delete(userId);
    });

    ws.on("error", (err) => {
      console.error(`WebSocket error for user ${userId}:`, err.message);
    });
  });

  // Heartbeat every 30s
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    });
  }, 30_000);
}

export function notifyQueryComplete(queryId: string, result: AIQueryResponse): void {
  const subscribers = querySubscriptions.get(queryId);
  if (!subscribers) return;

  const message: WSMessage = { type: "query.completed", queryId, result };
  const payload = JSON.stringify(message);

  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }

  querySubscriptions.delete(queryId);
}

export function subscribeToQuery(queryId: string, ws: WebSocket): void {
  if (!querySubscriptions.has(queryId)) {
    querySubscriptions.set(queryId, new Set());
  }
  querySubscriptions.get(queryId)!.add(ws);
}
