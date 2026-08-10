import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../../db/client.js";
import { generationOperations } from "../../db/schema.js";
import { DeskStateService } from "../../services/desk-state-service.js";
import { GenerationOperationStore } from "../generation-operation-store.js";
import { TaskStore } from "../task-store.js";
import type { ImageGenerateTaskV1 } from "../types.js";
import {
  AmbiguousProviderResultError,
  handleImageGenerateTask,
} from "./image-generate.js";

const DATABASE_URL = process.env.QIJIAN_TEST_DATABASE_URL
  ?? "postgresql://qijian:qijian@localhost:5433/qijian";
let db: Database | undefined;
let pool: { end: () => Promise<void> } | undefined;
let available = false;
try {
  const created = createDatabase({ databaseUrl: DATABASE_URL });
  db = created.db;
  pool = created.pool;
  await db.select({ id: generationOperations.id }).from(generationOperations).limit(1);
  available = true;
} catch {
  console.warn("[integration] image handler database unavailable - skipping");
}
afterAll(async () => { if (pool) await pool.end(); });
const itDb = (...args: Parameters<typeof it>) => (available ? it(...args) : it.skip(...args));

function imageTask(projectId: string): ImageGenerateTaskV1 {
  return {
    schema_version: 1,
    kind: "image.generate",
    operation: "spawn",
    project_id: projectId,
    task_id: crypto.randomUUID(),
    references: [],
    target_version: 0,
    prompt: "handler test",
    model: "fake-model",
    origin: { type: "panel", name: "test" },
  };
}

async function acceptTask(tasks: TaskStore, task: ImageGenerateTaskV1) {
  await tasks.accept({ payload: task, taskKind: "handler-test" });
}

describe("handleImageGenerateTask (integration)", () => {
  itDb("does not generate or finalize twice when the same task is consumed again", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("image-handler-idempotent");
    const task = imageTask(project.id);
    const tasks = new TaskStore(db!);
    const operations = new GenerationOperationStore(db!);
    let generates = 0;
    let finalizes = 0;
    try {
      await acceptTask(tasks, task);
      const context = {
        operations,
        generate: async () => {
          generates += 1;
          return { result: { fileId: "file-1" } };
        },
        finalize: async () => {
          finalizes += 1;
          return { artifactId: "artifact-1", versionId: "version-1" };
        },
      };

      const first = await handleImageGenerateTask(task, context);
      const repeated = await handleImageGenerateTask(task, context);

      expect(first).toMatchObject({
        status: "succeeded",
        result: { artifactId: "artifact-1", versionId: "version-1" },
        replayed: false,
      });
      expect(repeated).toMatchObject({ status: "succeeded", replayed: true, result: first.result });
      expect({ generates, finalizes }).toEqual({ generates: 1, finalizes: 1 });
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("moves an ambiguous provider timeout to needs_review without retrying generation", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("image-handler-review");
    const task = imageTask(project.id);
    const tasks = new TaskStore(db!);
    const operations = new GenerationOperationStore(db!);
    let generates = 0;
    try {
      await acceptTask(tasks, task);
      const context = {
        operations,
        generate: async () => {
          generates += 1;
          throw new AmbiguousProviderResultError("provider timed out after accepting request");
        },
        finalize: async () => ({ artifactId: "never", versionId: "never" }),
      };

      expect(await handleImageGenerateTask(task, context)).toMatchObject({ status: "needs_review" });
      expect(await handleImageGenerateTask(task, context)).toMatchObject({ status: "needs_review" });
      expect(generates).toBe(1);
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("retries clear transient provider failures within the attempt budget", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("image-handler-retry");
    const task = imageTask(project.id);
    const tasks = new TaskStore(db!);
    const operations = new GenerationOperationStore(db!);
    let generates = 0;
    const sleeps: number[] = [];
    try {
      await acceptTask(tasks, task);
      const result = await handleImageGenerateTask(task, {
        operations,
        maxAttempts: 3,
        backoffMs: 10,
        sleep: async (ms) => { sleeps.push(ms); },
        generate: async () => {
          generates += 1;
          if (generates < 3) {
            throw new Error("图像服务调用失败：503：upstream busy");
          }
          return { result: { fileId: "file-ok" } };
        },
        finalize: async () => ({ artifactId: "artifact-ok", versionId: "version-ok" }),
      });
      expect(result).toMatchObject({ status: "succeeded", result: { artifactId: "artifact-ok" } });
      expect(generates).toBe(3);
      expect(sleeps).toEqual([10, 20]);
      expect(await operations.get(task.task_id)).toMatchObject({ status: "finalized", attempt: 3 });
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("does not retry validation errors", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("image-handler-validation");
    const task = imageTask(project.id);
    const tasks = new TaskStore(db!);
    const operations = new GenerationOperationStore(db!);
    let generates = 0;
    try {
      await acceptTask(tasks, task);
      await expect(handleImageGenerateTask(task, {
        operations,
        maxAttempts: 3,
        sleep: async () => undefined,
        generate: async () => {
          generates += 1;
          throw new Error("未知生图 model：bad");
        },
        finalize: async () => ({ artifactId: "never", versionId: "never" }),
      })).rejects.toThrow(/未知生图 model/);
      expect(generates).toBe(1);
      expect(await operations.get(task.task_id)).toMatchObject({ status: "failed" });
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("reports cancelled_with_side_effect when cancellation arrives after provider output", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("image-handler-cancel-late");
    const task = imageTask(project.id);
    const tasks = new TaskStore(db!);
    const operations = new GenerationOperationStore(db!);
    let cancelled = false;
    let finalizes = 0;
    try {
      await acceptTask(tasks, task);
      const result = await handleImageGenerateTask(task, {
        operations,
        isCancellationRequested: async () => cancelled,
        generate: async () => {
          cancelled = true;
          return { result: { fileId: "already-created" } };
        },
        finalize: async () => {
          finalizes += 1;
          return { artifactId: "never", versionId: "never" };
        },
      });

      expect(result).toEqual({
        status: "cancelled_with_side_effect",
        result: { fileId: "already-created" },
      });
      expect(finalizes).toBe(0);
    } finally {
      await desks.deleteProject(project.id);
    }
  });
});
