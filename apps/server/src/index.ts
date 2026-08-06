import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { ChatGateway } from "./agent/chat-gateway.js";
import type { EventSink } from "./agent/events.js";
import { AgentSessionRegistry } from "./agent/session-registry.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { createHttpApp } from "./http/app.js";
import { ArtifactService } from "./services/artifact-service.js";
import { CanvasGenerateService } from "./services/canvas-generate-service.js";
import { DeskStateService } from "./services/desk-state-service.js";
import { FileStorage } from "./services/file-storage.js";
import { HttpImageGenerator } from "./services/image-generator.js";
import { ChatService } from "./services/chat-service.js";

const config = loadConfig();
const { db, pool } = createDatabase(config);
const artifacts = new ArtifactService(db);
const desks = new DeskStateService(db);
const files = new FileStorage(db, config);
const effects = new HttpImageGenerator(config, files);
const chats = new ChatService(db);
const generate = new CanvasGenerateService(db, artifacts, desks, files, effects);
files.setReferenceCheckers([chats, artifacts]);

let publish: EventSink = () => undefined;
// 预留桌面写路径依赖：业务 tools 暂时为空，但 Agent 仍是桌面行动者边界。
const sessions = new AgentSessionRegistry({ artifacts, desks, effects, chats, files, config, emit: (event) => publish(event) });
const chat = new ChatGateway(sessions, chats);
publish = chat.emit;

const app = createHttpApp({ config, artifacts, desks, files, chats, sessions, generate });
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
