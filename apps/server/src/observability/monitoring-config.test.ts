import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function text(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

describe("monitoring deployment configuration", () => {
  it("scrapes both API and worker runtimes", async () => {
    const prometheus = await text("monitoring/prometheus.yml");

    expect(prometheus).toContain("job_name: qijian-api");
    expect(prometheus).toContain('host.docker.internal:8787');
    expect(prometheus).toContain("job_name: qijian-worker");
    expect(prometheus).toContain('host.docker.internal:9465');
    expect(prometheus).toContain("/etc/prometheus/alerts.yml");
  });

  it("provides actionable alerts with matching runbook sections", async () => {
    const alerts = await text("monitoring/alerts.yml");
    const runbook = (await text("docs/runbooks/observability.md")).toLowerCase();
    const names = [
      "QijianApiDown",
      "QijianWorkerDown",
      "QijianDependencyNotReady",
      "QijianHttpErrorRateHigh",
      "QijianAgentErrorRateHigh",
      "QijianQueueBacklog",
      "QijianMetricsCollectionDegraded",
      "QijianTaskNeedsReview",
      "QijianCacheReuseLow",
      "QijianTraceExportDegraded",
      "QijianStaleAgentRun",
    ];

    for (const name of names) {
      expect(alerts).toContain(`alert: ${name}`);
      expect(alerts).toContain(`observability.md#${name.toLowerCase()}`);
      expect(runbook).toContain(`## ${name.toLowerCase()}`);
    }
  });

  it("ships a provisioned Grafana dashboard with all operating signals", async () => {
    const dashboard = JSON.parse(await text("monitoring/grafana/dashboards/qijian-runtime.json")) as {
      uid?: string;
      panels?: Array<{ title?: string }>;
    };
    const titles = dashboard.panels?.map((panel) => panel.title) ?? [];

    expect(dashboard.uid).toBe("qijian-runtime");
    expect(titles).toEqual(expect.arrayContaining([
      "API / Worker Up",
      "Ready Dependencies",
      "Agent Outcomes",
      "Prompt Cache Reuse",
      "Queue State",
      "Queue Metrics Fresh",
      "Tool p95 Duration",
      "Cache Read / Write Tokens",
      "Trace Export Health",
    ]));
  });
});
