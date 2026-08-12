import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { RuntimeMetrics } from "./metrics.js";
import { createMetricsServer } from "./metrics-server.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Worker metrics server", () => {
  it("serves liveness, readiness, and Prometheus metrics", async () => {
    const metrics = new RuntimeMetrics("test-worker", { defaultMetrics: false });
    let readinessCalls = 0;
    const server = createMetricsServer(metrics, async () => {
      readinessCalls += 1;
      return ({
      ok: true,
      checks: { postgres: true, redis: true, worker: true },
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const base = `http://127.0.0.1:${address.port}`;

    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/ready`)).status).toBe(200);
    const metricResponse = await fetch(`${base}/metrics`);
    expect(metricResponse.status).toBe(200);
    expect(await metricResponse.text()).toContain('service="test-worker"');
    expect(readinessCalls).toBe(2);
  });

  it("returns 503 for an unhealthy worker", async () => {
    const metrics = new RuntimeMetrics("test-worker", { defaultMetrics: false });
    const server = createMetricsServer(metrics, async () => ({
      ok: false,
      checks: { postgres: true, redis: false, worker: false },
    }));
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");

    const response = await fetch(`http://127.0.0.1:${address.port}/ready`);
    expect(response.status).toBe(503);
  });

  it("keeps metrics scrapeable when the readiness probe throws", async () => {
    const metrics = new RuntimeMetrics("test-worker", { defaultMetrics: false });
    const server = createMetricsServer(metrics, async () => {
      throw new Error("probe failed");
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");

    const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('service="test-worker"');
  });
});
