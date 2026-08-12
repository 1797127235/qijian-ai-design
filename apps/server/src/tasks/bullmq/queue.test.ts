import { afterAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import {
  BullMqQueueAdapter,
  TASK_JOB_RETENTION_SECONDS,
} from "./queue.js";
import type { ArtifactNameTaskV1, ImageGenerateTaskV1 } from "../types.js";

const REDIS_URL = process.env.QIJIAN_TEST_REDIS_URL ?? "redis://localhost:6379";

let available = false;
const probe = new Redis(REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
});
try {
  await probe.connect();
  await probe.ping();
  available = true;
} catch {
  console.warn("[integration] Redis unavailable - skipping BullMQ tests");
} finally {
  probe.disconnect();
}

const adapters: BullMqQueueAdapter[] = [];
afterAll(async () => {
  await Promise.all(adapters.map(async (adapter) => {
    try {
      await adapter.queue.obliterate({ force: true });
    } catch {
      // A shutdown test intentionally closes its connection before teardown.
    } finally {
      await adapter.shutdown();
    }
  }));
});

const itRedis = (...args: Parameters<typeof it>) => (available ? it(...args) : it.skip(...args));

function imageTask(): ImageGenerateTaskV1 {
  return {
    schema_version: 1,
    kind: "image.generate",
    operation: "spawn",
    project_id: crypto.randomUUID(),
    task_id: crypto.randomUUID(),
    references: [],
    target_version: 0,
    prompt: "generate a living room",
    model: "fake-model",
    origin: { type: "panel", name: "generate-image" },
  };
}

function nameTask(projectId: string): ArtifactNameTaskV1 {
  return {
    schema_version: 1,
    kind: "artifact.name",
    project_id: projectId,
    task_id: crypto.randomUUID(),
    artifact_id: crypto.randomUUID(),
    artifact_version_id: crypto.randomUUID(),
    name_version: 0,
    generation_token: crypto.randomUUID(),
    display_name_source: "system",
    naming_input: "a quiet living room",
  };
}

function createAdapter(): BullMqQueueAdapter {
  const adapter = new BullMqQueueAdapter({
    redisUrl: REDIS_URL,
    taskQueuePrefix: `qijian-test-${crypto.randomUUID()}`,
  });
  adapters.push(adapter);
  return adapter;
}

describe("BullMqQueueAdapter (Redis integration)", () => {
  itRedis("uses the business task id and deduplicates repeated enqueue", async () => {
    const adapter = createAdapter();
    const payload = imageTask();

    const first = await adapter.enqueue(payload);
    const repeated = await adapter.enqueue(payload);

    expect(first.id).toBe(payload.task_id);
    expect(repeated.id).toBe(payload.task_id);
    expect((await adapter.queue.getJobCounts("waiting")).waiting).toBe(1);
    expect(first.opts.removeOnComplete).toEqual({ age: TASK_JOB_RETENTION_SECONDS });
    expect(first.opts.removeOnFail).toEqual({ age: TASK_JOB_RETENTION_SECONDS });
    const snapshot = await adapter.snapshot();
    expect(snapshot.waiting).toBe(1);
    expect(snapshot.workers).toBe(0);
    expect(snapshot.oldestWaitingSeconds).toBeGreaterThanOrEqual(0);
  });

  itRedis("assigns stable task ids to every node in a flow", async () => {
    const adapter = createAdapter();
    const image = imageTask();
    const naming = nameTask(image.project_id);

    const flow = await adapter.enqueueFlow({
      payload: naming,
      children: [{ payload: image }],
    });

    expect(flow.job.id).toBe(naming.task_id);
    expect(flow.children?.[0]?.job.id).toBe(image.task_id);
  });

  itRedis("closes Queue and FlowProducer connections", async () => {
    const adapter = createAdapter();
    await adapter.waitUntilReady();
    const queueClient = await adapter.queue.client;
    const flowClient = await adapter.flowProducer.client;

    await adapter.shutdown();

    expect(queueClient.status).toBe("end");
    expect(flowClient.status).toBe("end");
  });
});
