import { describe, expect, it, vi } from "vitest";
import type { DeskSnapshot } from "../domain/types.js";
import { AssetTaskSubmissionService } from "./asset-task-submission.js";
import { AssetBatchSubmissionService } from "./asset-batch-submission.js";

function desk(): DeskSnapshot {
  const projectId = crypto.randomUUID();
  return {
    project: { id: projectId, name: "memory-submit" },
    artifacts: ["bedroom", "living"].map((name) => ({
      id: crypto.randomUUID(),
      artifactType: "canvas_image" as const,
      versionId: crypto.randomUUID(),
      versionNo: 1,
      status: "confirmed" as const,
      payload: { file_id: crypto.randomUUID(), name },
      inputRefs: [],
      createdBy: "designer" as const,
      createdAt: new Date(),
    })),
    deskState: { objects: [], connections: [], viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: new Date() },
  };
}

function frozen(revision: number, label: string) {
  return {
    checkpoint_revision: revision,
    stable_keys: [label],
    compiled_design_context: `[PROJECT_MEMORY revision=${revision}]\n- ${label}`,
  };
}

function prepared(taskId: string) {
  return {
    pending: {
      artifact: { id: taskId },
      version: { id: crypto.randomUUID(), status: "draft" },
      object: { artifact_id: taskId, kind: "effect_image", x: 0, y: 0, rot: 0 },
      status: "pending" as const,
    },
    composedPrompt: "prompt",
    userPrompt: "prompt",
    referenceFileIds: [],
    origin: "agent_chat" as const,
    createdBy: "agent" as const,
    lockKey: taskId,
  };
}

describe("generation submission freezes project memory", () => {
  it("freezes Agent image memory before durable acceptance", async () => {
    const snapshot = desk();
    let accepted: {
      payload: Record<string, unknown>;
      traceContext?: {
        traceId: string;
        parentRunId: string;
        langsmithTrace: string;
      };
    } | undefined;
    const store = {
      accept: async (input: { payload: Record<string, unknown>; prepare: (tx: never) => Promise<unknown> }) => {
        accepted = input;
        await input.prepare(undefined as never);
      },
    };
    const generate = { prepare: async () => prepared(crypto.randomUUID()) };
    const memory = { freezeForGeneration: vi.fn(async () => frozen(3, "卧室木色更暖")) };
    const trackJob = vi.fn();
    const runId = crypto.randomUUID();
    const traces = {
      get: vi.fn(() => ({
        root: { id: "trace-root-1", runId },
        toolSpans: new Map([["call-1", { id: "trace-tool-1", runId }]]),
      })),
      captureContext: vi.fn(() => ({
        traceId: "trace-root-1",
        parentRunId: "trace-tool-1",
        langsmithTrace: "20260812T000000000001Ztrace-root-1.20260812T000001000002Ztrace-tool-1",
      })),
      trackJob,
    };
    const service = new AssetTaskSubmissionService(
      store as never,
      generate as never,
      { snapshot: async () => snapshot, notifyDeskChanged: vi.fn() } as never,
      { imageModel: "image-model" },
      memory as never,
      traces as never,
    );

    await service.submitAgentImage({
      projectId: snapshot.project.id,
      threadId: crypto.randomUUID(),
      runId,
      prompt: "继续修改卧室",
      toolName: "generate_from_desk",
      toolCallId: "call-1",
      placement: { mode: "beside", sourceArtifactId: snapshot.artifacts[0].id, referenceArtifactIds: [] },
    });

    expect(memory.freezeForGeneration).toHaveBeenCalledWith(snapshot.project.id);
    expect(accepted?.payload).toMatchObject({
      generation_memory: { checkpoint_revision: 3 },
    });
    expect(String(accepted?.payload.prompt)).toMatch(/PROJECT_MEMORY[\s\S]*CURRENT_GENERATION_REQUEST/);
    expect(accepted).toMatchObject({
      traceContext: {
        traceId: "trace-root-1",
        parentRunId: "trace-tool-1",
      },
    });
    expect(trackJob).toHaveBeenCalledWith(runId, expect.any(String));
  });

  it("retrieves local memory independently for every batch item", async () => {
    const snapshot = desk();
    const acceptedPayloads: Array<Record<string, unknown>> = [];
    let call = 0;
    const memory = {
      freezeForGeneration: vi.fn(async () => {
        call += 1;
        return frozen(call, call === 1 ? "卧室局部规则" : "客厅局部规则");
      }),
    };
    const store = {
      acceptBatch: async (input: { tasks: Array<{ payload: Record<string, unknown>; prepare: (tx: never) => Promise<unknown> }> }) => {
        acceptedPayloads.push(...input.tasks.map((task) => task.payload));
        for (const task of input.tasks) await task.prepare(undefined as never);
        return {
          batch: { id: crypto.randomUUID(), total: input.tasks.length },
          tasks: input.tasks.map((task) => ({ id: String(task.payload.task_id) })),
        };
      },
    };
    const service = new AssetBatchSubmissionService(
      store as never,
      { prepare: async () => prepared(crypto.randomUUID()) } as never,
      { snapshot: async () => snapshot, notifyDeskChanged: vi.fn() } as never,
      { imageModel: "image-model" },
      memory as never,
    );

    await service.submit({
      projectId: snapshot.project.id,
      createdBy: "designer",
      requests: snapshot.artifacts.map((artifact) => ({ prompt: "生成", sourceArtifactId: artifact.id })),
    });

    expect(memory.freezeForGeneration).toHaveBeenCalledTimes(2);
    expect(acceptedPayloads.map((payload) => (payload.generation_memory as { checkpoint_revision: number }).checkpoint_revision)).toEqual([1, 2]);
    expect(String(acceptedPayloads[0].prompt)).toContain("卧室局部规则");
    expect(String(acceptedPayloads[1].prompt)).toContain("客厅局部规则");
  });
});
