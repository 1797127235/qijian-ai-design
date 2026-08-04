import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { ChatGateway } from "./agent/chat-gateway.js";
import type { EventSink } from "./agent/events.js";
import { PermissionGate } from "./agent/permission-gate.js";
import { AgentSessionRegistry } from "./agent/session-registry.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { createHttpApp } from "./http/app.js";
import { ArtifactService } from "./services/artifact-service.js";
import { DeskStateService } from "./services/desk-state-service.js";
import { ExportService } from "./services/export-service.js";
import { FileStorage } from "./services/file-storage.js";
import { HttpImageGenerator } from "./services/image-generator.js";

const config = loadConfig();
const { db, pool } = createDatabase(config);
const artifacts = new ArtifactService(db);
const desks = new DeskStateService(db);
const files = new FileStorage(db, config);
const effects = new HttpImageGenerator(config);
const exports = new ExportService(desks, artifacts, files);

let publish: EventSink = () => undefined;
const gate = new PermissionGate(desks, (event) => publish(event));
const sessions = new AgentSessionRegistry({ artifacts, desks, effects, exports, gate, config, emit: (event) => publish(event) });
const chat = new ChatGateway(sessions, gate);
publish = chat.emit;

const app = createHttpApp({ config, db, artifacts, desks, files, exports });
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
  sockets.close();
  server.close();
  await pool.end();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
