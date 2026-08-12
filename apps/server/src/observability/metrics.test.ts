import { describe, expect, it } from "vitest";
import { RuntimeMetrics } from "./metrics.js";

describe("RuntimeMetrics", () => {
  it("exports bounded-label HTTP RED metrics", async () => {
    const metrics = new RuntimeMetrics("test-api", { defaultMetrics: false });
    metrics.observeHttp({ method: "GET", route: "/api/projects/:id", status: 200, durationSeconds: 0.125 });

    const output = await metrics.text();

    expect(output).toContain('qijian_http_requests_total{method="GET",route="/api/projects/:id",status_class="2xx",service="test-api"} 1');
    expect(output).toContain("qijian_http_request_duration_seconds_bucket");
    expect(output).not.toContain("project-123");
  });

  it("exports Agent cache and task outcome metrics", async () => {
    const metrics = new RuntimeMetrics("test-worker", { defaultMetrics: false });
    metrics.observeModelUsage({ input: 100, output: 20, cacheRead: 900, cacheWrite: 0, hitRate: 0.9 });
    metrics.observeTask({ kind: "image.generate", status: "succeeded", durationSeconds: 2.5 });
    metrics.observeDispatcher({ claimed: 2, enqueued: 1, released: 1, failed: 0, deadLettered: 0 });
    metrics.observeReconciler({ reclaimed: 1, requeued: 1, needsReview: 0, redisErrors: 0 });
    metrics.observeTraceDrop();
    metrics.observeTraceError();
    metrics.observeAlert("firing", 2);

    const output = await metrics.text();

    expect(output).toContain('qijian_agent_model_tokens_total{kind="cache_read",service="test-worker"} 900');
    expect(output).toContain("qijian_agent_cache_read_hit_ratio_bucket");
    expect(output).toContain('qijian_tasks_total{kind="image.generate",status="succeeded",service="test-worker"} 1');
    expect(output).toContain('qijian_dispatcher_tasks_total{outcome="enqueued",service="test-worker"} 1');
    expect(output).toContain('qijian_reconciler_actions_total{outcome="requeued",service="test-worker"} 1');
    expect(output).toContain('qijian_trace_export_dropped_total{service="test-worker"} 1');
    expect(output).toContain('qijian_trace_export_errors_total{service="test-worker"} 1');
    expect(output).toContain('qijian_alert_notifications_total{status="firing",service="test-worker"} 2');
  });

  it("collects queue saturation and worker availability at scrape time", async () => {
    const metrics = new RuntimeMetrics("test-api", { defaultMetrics: false });
    metrics.bindQueueCollector(async () => ({
      waiting: 4,
      delayed: 2,
      active: 1,
      failed: 3,
      workers: 2,
      oldestWaitingSeconds: 12,
    }));

    const output = await metrics.text();

    expect(output).toContain('qijian_queue_jobs{state="waiting",service="test-api"} 4');
    expect(output).toContain('qijian_queue_workers{service="test-api"} 2');
    expect(output).toContain('qijian_queue_oldest_waiting_seconds{service="test-api"} 12');
    expect(output).toContain('qijian_queue_snapshot_available{service="test-api"} 1');
  });

  it("keeps metrics available when the queue snapshot cannot be collected", async () => {
    const metrics = new RuntimeMetrics("test-api", { defaultMetrics: false });
    metrics.setReady("redis", false);
    metrics.bindQueueCollector(async () => {
      throw new Error("redis unavailable");
    });

    const output = await metrics.text();

    expect(output).toContain('qijian_subsystem_ready{subsystem="redis",service="test-api"} 0');
    expect(output).toContain('qijian_queue_snapshot_available{service="test-api"} 0');
  });
});
