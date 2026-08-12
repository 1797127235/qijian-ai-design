import { createServer, type ServerResponse } from "node:http";
import type { ReadinessResult } from "../http/app.js";
import type { RuntimeMetrics } from "./metrics.js";

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function createMetricsServer(
  metrics: RuntimeMetrics,
  readiness: () => Promise<ReadinessResult>,
) {
  return createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    try {
      if (path === "/health") {
        json(response, 200, { ok: true });
        return;
      }
      if (path === "/ready") {
        const result = await readiness();
        json(response, result.ok ? 200 : 503, result);
        return;
      }
      if (path === "/metrics") {
        await readiness().catch(() => undefined);
        response.writeHead(200, { "content-type": metrics.contentType });
        response.end(await metrics.text());
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch {
      json(response, 503, { ok: false, error: "observability_unavailable" });
    }
  });
}
