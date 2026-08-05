import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { ChatGateway } from "./agent/chat-gateway.js";
import type { EventSink } from "./agent/events.js";
import { AgentSessionRegistry } from "./agent/session-registry.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { createHttpApp } from "./http/app.js";
import { ArtifactService } from "./services/artifact-service.js";
import { DeskStateService } from "./services/desk-state-service.js";
import { ExportService } from "./services/export-service.js";
import { FileStorage } from "./services/file-storage.js";
import { HttpImageGenerator } from "./services/image-generator.js";
import { ChatService } from "./services/chat-service.js";

const config = loadConfig();
const { db, pool } = createDatabase(config);
const artifacts = new ArtifactService(db);
const desks = new DeskStateService(db);
const files = new FileStorage(db, config);
const effects = new HttpImageGenerator(config, files);
const exports = new ExportService(desks, artifacts, files);
const chats = new ChatService(db);

let publish: EventSink = () => undefined;
const sessions = new AgentSessionRegistry({ artifacts, desks, effects, exports, chats, config, emit: (event) => publish(event) });
const chat = new ChatGateway(sessions, chats);
publish = chat.emit;

const app = createHttpApp({ config, db, artifacts, desks, files, exports, chats, sessions });
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Qijian agent server listening on http://localhost:${info.port}`);
});
const sockets = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const match = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/chat$/i);
  if (!match) return socket.destroy();
  sockets.handleUpgrade(request, socket, head, (webSocket) => chat.connect(match[1], webSocket));
});

async function shutdown() {
  for (const socket of sockets.clients) socket.close(1001, "server shutdown");
  sockets.close();
  server.close();
  await sessions.shutdown();
  await pool.end();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
