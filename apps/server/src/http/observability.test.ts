import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { StructuredLogger } from "../observability/logger.js";
import { RuntimeMetrics } from "../observability/metrics.js";
import { createHttpApp } from "./app.js";

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    config: loadConfig({}),
    artifacts: {} as never,
    desks: {} as never,
    files: {} as never,
    chats: {} as never,
    sessions: {} as never,
    ...overrides,
  };
}

describe("HTTP observability", () => {
  it("exposes liveness, dependency readiness, metrics, and request correlation", async () => {
    const sink = vi.fn();
    const metrics = new RuntimeMetrics("test-api", { defaultMetrics: false });
    const readiness = vi.fn(async () => ({
      ok: true,
      checks: { postgres: true, redis: true, worker: true },
    }));
    const app = createHttpApp(dependencies({
      metrics,
      readiness,
      logger: new StructuredLogger("test-api", { sink }),
    }));

    const health = await app.request("/health", { headers: { "x-request-id": "req-test-1" } });
    const ready = await app.request("/ready");
    const metricResponse = await app.request("/metrics");

    expect(health.status).toBe(200);
    expect(health.headers.get("x-request-id")).toBe("req-test-1");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ok: true, checks: { postgres: true, redis: true, worker: true } });
    expect(metricResponse.headers.get("content-type")).toContain("text/plain");
    expect(await metricResponse.text()).toContain("qijian_http_requests_total");
    expect(readiness).toHaveBeenCalledTimes(2);
    const log = JSON.parse(sink.mock.calls[0][0]);
    expect(log).toMatchObject({
      event: "http_request_completed",
      request_id: "req-test-1",
      method: "GET",
      route: "/health",
      path: "/health",
    });

    const alertResponse = await app.request("/internal/monitoring/alerts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alerts: [{ status: "firing", labels: { alertname: "WorkerDown", severity: "page" } }] }),
    });
    expect(alertResponse.status).toBe(200);
    expect(sink.mock.calls.map(([line]) => JSON.parse(line)).some((entry) => (
      entry.event === "monitoring_alert_received"
      && entry.alert === "WorkerDown"
      && entry.severity === "page"
    ))).toBe(true);
  });

  it("returns 503 when a required dependency is unavailable", async () => {
    const app = createHttpApp(dependencies({
      readiness: async () => ({
        ok: false,
        checks: { postgres: true, redis: true, worker: false },
      }),
    }));

    const response = await app.request("/ready");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, checks: { worker: false } });
  });

  it("keeps metrics scrapeable when the readiness probe itself fails", async () => {
    const metrics = new RuntimeMetrics("test-api", { defaultMetrics: false });
    const app = createHttpApp(dependencies({
      metrics,
      readiness: vi.fn().mockRejectedValue(new Error("dependency probe failed")),
    }));

    const response = await app.request("/metrics");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("qijian_http_requests_total");
  });

  it("records the project id when a project is deleted", async () => {
    const sink = vi.fn();
    const projectId = "6f42ee2a-bad6-4e93-828e-27d90232debe";
    const cancelFileGc = vi.fn();
    const app = createHttpApp(dependencies({
      logger: new StructuredLogger("test-api", { sink }),
      sessions: { forgetProject: vi.fn(async () => undefined) },
      desks: { deleteProject: vi.fn(async () => ({ objectKeys: ["a.png"] })) },
      files: { removeProjectFiles: vi.fn(async () => undefined) },
      cancelFileGc,
    }));

    const response = await app.request(`/api/projects/${projectId}`, { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(cancelFileGc).toHaveBeenCalledWith(projectId);
    const events = sink.mock.calls.map(([line]) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({
      event: "project_deleted",
      project_id: projectId,
      file_count: 1,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "http_request_completed",
      method: "DELETE",
      route: "/api/projects/:id",
      path: `/api/projects/${projectId}`,
      status: 204,
    }));
  });
});
