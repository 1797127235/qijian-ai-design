import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CurrentContextFrameState,
  type CurrentContextFrameInput,
} from "./current-context-frame.js";
import { ContextResourceStore } from "./resource-store.js";

const roots: string[] = [];

async function frameState(contextEpoch = "ctx-1") {
  const root = await mkdtemp(join(tmpdir(), "qijian-context-frame-"));
  roots.push(root);
  return CurrentContextFrameState.open({
    filePath: join(root, "context-ledger.json"),
    contextEpoch,
    resourceStore: new ContextResourceStore(join(root, "resources")),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function input(patch: Partial<CurrentContextFrameInput> = {}): CurrentContextFrameInput {
  return {
    source: "interactive",
    mode: "designer",
    authority: "user_explicit",
    policyRevision: "capability-gate-v1",
    desk: {
      revision: "desk-1",
      fullText: "[DESK_CONTEXT current=true revision=desk-1]\n- A01 image art-1「客厅」 ready",
      requestText: "[选中]\n- A01 art-1\n\n[FOCUS]\n- core A01 art-1",
      manifest: {
        "art-1": {
          id: "art-1",
          alias: "A01",
          type: "canvas_image",
          label: "客厅",
          lifecycle: "ready",
          grid: "@(0,0)",
          x: 0,
          y: 0,
          fileId: "file-1",
          edgesIn: [],
          edgesOut: [],
        },
      },
      priorityArtifactIds: ["art-1"],
    },
    jobs: {
      revision: "jobs-1",
      fullText: "[后台任务]\n- running generate task=job-1",
      entries: {
        "job-1": {
          id: "job-1",
          kind: "generate",
          status: "running",
          artifactId: "art-1",
          label: "暖色客厅",
        },
      },
    },
    memory: {
      revision: 1,
      fullText: "[PROJECT_MEMORY revision=1]\n设计意图：\n- intent.mood: 安静",
      entries: {
        "intent.mood": {
          stableKey: "intent.mood",
          family: "design_intent",
          summary: "安静",
          body: "安静",
        },
      },
    },
    inspectText: "[INSPECT]\n- image_1 = A01 art-1",
    toolEpoch: 3,
    activeTools: ["search_tools", "look_at", "generate_from_desk"],
    loadedSkillRevisions: {},
    emittedSkillRevisions: {},
    injectedSkills: [],
    userRequest: "把 <客厅> 改得更温暖",
    ...patch,
  };
}

describe("CurrentContextFrameState", () => {
  it("emits a canonical full frame before the escaped user request", async () => {
    const state = await frameState();
    const prepared = await state.prepare(input());

    expect(prepared.frameText).toContain('<system_context_frame version="1" current="true" seq="1" context_epoch="ctx-1" trajectory_epoch="1">');
    expect(prepared.frameText).toContain('<desk revision="desk-1" state="full">');
    expect(prepared.frameText).toContain('<jobs revision="jobs-1" state="full">');
    expect(prepared.frameText).toContain('<memory revision="1" state="full">');
    expect(prepared.frameText).toContain('<skills loaded="" reload_required="" />');
    expect(prepared.promptText.indexOf("<system_context_frame")).toBeLessThan(
      prepared.promptText.indexOf("<user_request"),
    );
    expect(prepared.promptText).toContain("把 &lt;客厅&gt; 改得更温暖");
    expect(prepared.promptText.trimEnd().endsWith("</user_request>")).toBe(true);
  });

  it("renders loaded skill revisions in canonical id order", async () => {
    const state = await frameState();
    const prepared = await state.prepare(input({
      loadedSkillRevisions: {
        "desk-loop": "sha256:bbbb",
        "design-language": "sha256:aaaa",
      },
      emittedSkillRevisions: {
        "design-language": "sha256:aaaa",
      },
    }));

    expect(prepared.frameText).toContain(
      '<skills loaded="design-language@sha256:aaaa,desk-loop@sha256:bbbb" reload_required="desk-loop@sha256:bbbb" />',
    );
  });

  it("places newly injected skill bodies inside the current skills frame", async () => {
    const state = await frameState();
    const prepared = await state.prepare(input({
      loadedSkillRevisions: { "design-language": "sha256:aaaa" },
      emittedSkillRevisions: { "design-language": "sha256:aaaa" },
      injectedSkills: [{
        id: "design-language",
        revision: "sha256:aaaa",
        baseDir: "/trusted/skills/design-language",
        body: "先判断 <设计方向> 再执行",
      }],
    }));

    expect(prepared.frameText).toContain('<skill id="design-language" revision="sha256:aaaa"');
    expect(prepared.frameText).toContain("先判断 &lt;设计方向&gt; 再执行");
  });

  it("emits unchanged state while retaining request-scoped focus and inspect", async () => {
    const state = await frameState();
    const first = await state.prepare(input());
    state.commit(first);
    await state.flush();

    const second = await state.prepare(input({ userRequest: "继续看这张" }));
    expect(second.frameText).toContain('<desk revision="desk-1" state="unchanged" />');
    expect(second.frameText).toContain('<jobs revision="jobs-1" state="unchanged" />');
    expect(second.frameText).toContain('<memory revision="1" state="unchanged" />');
    expect(second.frameText).not.toContain("- running generate task=job-1");
    expect(second.frameText).not.toContain("intent.mood");
    expect(second.frameText).toContain("[FOCUS]");
    expect(second.frameText).toContain("[INSPECT]");
    expect(second.sequence).toBe(2);
  });

  it("emits deterministic desk and memory deltas", async () => {
    const state = await frameState();
    const first = await state.prepare(input());
    state.commit(first);
    await state.flush();

    const changed = input({
      desk: {
        revision: "desk-2",
        fullText: "full desk 2",
        requestText: "",
        manifest: {
          "art-2": {
            id: "art-2",
            alias: "A02",
            type: "effect_image",
            label: "新方向",
            lifecycle: "ready",
            grid: "@(2,0)",
            x: 800,
            y: 0,
            fileId: "file-2",
            edgesIn: [],
            edgesOut: [],
          },
        },
        priorityArtifactIds: ["art-2"],
      },
      jobs: {
        revision: "jobs-2",
        fullText: "[后台任务]\n- succeeded task=job-1",
        entries: {
          "job-1": {
            id: "job-1",
            kind: "generate",
            status: "succeeded",
            artifactId: "art-1",
            label: "暖色客厅",
          },
        },
      },
      memory: {
        revision: 2,
        fullText: "memory 2",
        entries: {
          "materials.primary": {
            stableKey: "materials.primary",
            family: "visual_system",
            summary: "浅木",
            body: "使用浅木",
          },
        },
      },
    });
    const prepared = await state.prepare(changed);

    expect(prepared.frameText).toContain('<desk revision="desk-2" state="delta"');
    expect(prepared.frameText).toContain('<added id="art-2"');
    expect(prepared.frameText).toContain('<removed id="art-1"');
    expect(prepared.frameText).toContain('<jobs revision="jobs-2" state="delta"');
    expect(prepared.frameText).toContain('<updated id="job-1"');
    expect(prepared.frameText).toContain('<memory revision="2" state="delta"');
    expect(prepared.frameText).toContain('<added key="materials.primary"');
    expect(prepared.frameText).toContain('<removed key="intent.mood"');
  });

  it("budgets a large full Desk frame and preserves the original as a readable resource", async () => {
    const root = await mkdtemp(join(tmpdir(), "qijian-context-frame-large-"));
    roots.push(root);
    const resourceStore = new ContextResourceStore(join(root, "resources"));
    const state = await CurrentContextFrameState.open({
      filePath: join(root, "context-ledger.json"),
      contextEpoch: "ctx-large",
      resourceStore,
    });
    const entries = Object.fromEntries(Array.from({ length: 140 }, (_, index) => {
      const id = `artifact-${String(index).padStart(4, "0")}-12345678-1234-1234-1234-123456789abc`;
      return [id, {
        id,
        alias: `A${String(index + 1).padStart(3, "0")}`,
        type: "effect_image",
        label: `方案 <${index}> & ${"暖木".repeat(20)}`,
        lifecycle: "ready",
        grid: `@(${index % 10},${Math.floor(index / 10)})`,
        x: (index % 10) * 400,
        y: Math.floor(index / 10) * 400,
        fileId: `file-${index}`,
        edgesIn: [],
        edgesOut: [],
      }];
    }));
    const priorityId = Object.keys(entries).at(-1)!;
    const fullText = [
      "[DESK_CONTEXT current=true revision=desk-large objects=140]",
      ...Object.values(entries).map((entry) => `${entry.alias} ${entry.id} ${entry.label}`),
    ].join("\n");
    const largeInput = input({
      desk: {
        revision: "desk-large",
        fullText,
        requestText: `[FOCUS]\n- core ${priorityId}`,
        manifest: entries,
        priorityArtifactIds: [priorityId],
      },
    });

    const first = await state.prepare(largeInput);
    expect(first.frameText).toContain("[DESK_FULL_TRUNCATED]");
    expect(first.frameText).toContain(priorityId);
    expect(first.contextBudget?.desk_full).toMatchObject({
      truncated: true,
      resource_status: "stored",
      priority_objects: 1,
    });
    const resourceRef = first.contextBudget?.desk_full.resource_ref;
    expect(resourceRef).toMatch(/^ctxres:sha256:[0-9a-f]{64}$/);
    const page = await resourceStore.readText(resourceRef!);
    expect(page).toMatchObject({ ok: true, toolName: "current_context_frame.desk" });
    if (page.ok) expect(page.text).toBe(fullText.slice(0, page.text.length));

    state.commit(first);
    const unchanged = await state.prepare(largeInput);
    expect(unchanged.frameText).toContain('<desk revision="desk-large" state="unchanged" />');
    expect(unchanged.contextBudget).toBeUndefined();

    state.forceResync();
    const resynced = await state.prepare(largeInput);
    expect(resynced.contextBudget?.desk_full.resource_ref).toBe(resourceRef);
    await state.flush();
  });

  it("keeps a large full Desk within budget when resource persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "qijian-context-frame-store-failure-"));
    roots.push(root);
    const state = await CurrentContextFrameState.open({
      filePath: join(root, "context-ledger.json"),
      contextEpoch: "ctx-store-failure",
      resourceStore: {
        async putText() {
          throw new Error("disk unavailable");
        },
      },
    });
    const largeInput = input({
      desk: {
        ...input().desk,
        revision: "desk-large",
        fullText: "<large & desk>".repeat(3_000),
      },
    });

    const prepared = await state.prepare(largeInput);
    expect(prepared.frameText).toContain("resource_status=unavailable");
    expect(prepared.contextBudget?.desk_full).toMatchObject({
      truncated: true,
      resource_status: "unavailable",
    });
    expect(prepared.contextBudget?.desk_full.emitted_frame_chars).toBeLessThanOrEqual(12_000);
  });

  it("persists only committed frames and resets cleanly for a new context epoch", async () => {
    const root = await mkdtemp(join(tmpdir(), "qijian-context-frame-"));
    roots.push(root);
    const filePath = join(root, "context-ledger.json");
    const resourceStore = new ContextResourceStore(join(root, "resources"));
    const state = await CurrentContextFrameState.open({ filePath, contextEpoch: "ctx-1", resourceStore });

    await state.prepare(input());
    expect(state.snapshot().nextFrameSeq).toBe(1);

    const committed = await state.prepare(input());
    state.commit(committed);
    await state.flush();

    const restored = await CurrentContextFrameState.open({ filePath, contextEpoch: "ctx-1", resourceStore });
    expect(restored.snapshot().nextFrameSeq).toBe(2);
    expect((await restored.prepare(input())).frameText).toContain('state="unchanged"');

    const changedEpoch = await CurrentContextFrameState.open({ filePath, contextEpoch: "ctx-2", resourceStore });
    expect(changedEpoch.snapshot().nextFrameSeq).toBe(1);
    expect((await changedEpoch.prepare(input())).frameText).toContain('state="full"');
  });

  it("forces a full resync after compaction without losing an in-flight sequence", async () => {
    const state = await frameState();
    const first = await state.prepare(input());
    state.commit(first);
    await state.flush();

    const inFlight = await state.prepare(input({ userRequest: "压缩中的请求" }));
    state.forceResync();
    state.commit(inFlight);
    await state.flush();

    expect(state.snapshot()).toMatchObject({
      nextFrameSeq: 3,
      trajectoryEpoch: 2,
    });
    const next = await state.prepare(input({ userRequest: "压缩后继续" }));
    expect(next.frameText).toContain('trajectory_epoch="2"');
    expect(next.frameText).toContain('<desk revision="desk-1" state="full">');
    expect(next.frameText).toContain('<jobs revision="jobs-1" state="full">');
    expect(next.frameText).toContain('<memory revision="1" state="full">');
  });

  it("uses full state for unavailable transitions so the model sees the degradation", async () => {
    const state = await frameState();
    const first = await state.prepare(input());
    state.commit(first);
    await state.flush();

    const unavailableInput = input({
      desk: {
        revision: "unknown",
        fullText: "[DESK_CONTEXT current=true revision=unknown]\n桌面状态暂不可用",
        requestText: "[选中]\n选中：无",
        manifest: {},
        priorityArtifactIds: [],
      },
      memory: {
        revision: "unavailable",
        fullText: "[PROJECT_MEMORY unavailable]",
        entries: {},
      },
    });
    const unavailable = await state.prepare(unavailableInput);

    expect(unavailable.frameText).toContain('<desk revision="unknown" state="full">');
    expect(unavailable.frameText).toContain("桌面状态暂不可用");
    expect(unavailable.frameText).toContain('<memory revision="unavailable" state="full">');
    expect(unavailable.frameText).toContain("[PROJECT_MEMORY unavailable]");
  });

  it("resyncs when the resumed Pi trajectory does not match the committed anchor", async () => {
    const state = await frameState();
    const first = await state.prepare(input());
    state.commit(first, "history-sha-1");
    await state.flush();

    expect(state.validateTrajectory("history-sha-1")).toBe(true);
    expect(state.validateTrajectory("different-history")).toBe(false);
    expect((await state.prepare(input())).frameText).toContain('<desk revision="desk-1" state="full">');
    await state.flush();
  });

  it("promotes an oversized desk delta to a budgeted full frame", async () => {
    const state = await frameState("ctx-delta-budget");
    const n = 80;
    const baseManifest = Object.fromEntries(Array.from({ length: n }, (_, index) => {
      const id = `art-${String(index).padStart(3, "0")}`;
      const label = `对象标签很长-${"设计".repeat(20)}-${index}`;
      return [id, {
        id,
        alias: `A${String(index + 1).padStart(2, "0")}`,
        type: "canvas_image",
        label,
        lifecycle: "ready",
        grid: `@(${index % 20},${Math.floor(index / 20)})`,
        x: index * 10,
        y: index * 5,
        fileId: `file-${index}`,
        edgesIn: [],
        edgesOut: [],
      }];
    }));
    const first = await state.prepare(input({
      desk: {
        revision: "desk-v1",
        fullText: `[DESK_CONTEXT current=true revision=desk-v1 objects=${n}]`,
        requestText: "[选中]\n选中：无",
        manifest: baseManifest,
        priorityArtifactIds: [],
      },
    }));
    state.commit(first);

    const nextManifest = Object.fromEntries(Object.entries(baseManifest).map(([id, entry]) => [id, {
      ...entry,
      label: `${entry.label}-改-${"x".repeat(40)}`,
      x: entry.x + 1,
      y: entry.y + 1,
    }]));
    const second = await state.prepare(input({
      desk: {
        revision: "desk-v2",
        fullText: `[DESK_CONTEXT current=true revision=desk-v2 objects=${n}]\n${"更新".repeat(4_000)}`,
        requestText: "[选中]\n选中：无",
        manifest: nextManifest,
        priorityArtifactIds: [],
      },
    }));

    expect(second.frameText).toContain('<desk revision="desk-v2" state="full">');
    expect(second.frameText).not.toContain('state="delta"');
    expect(second.contextBudget?.desk_full).toBeDefined();
    await state.flush();
  });

  it("rejects a second commit for the same prepared sequence", async () => {
    const state = await frameState("ctx-seq");
    const a = await state.prepare(input({ userRequest: "A" }));
    const b = await state.prepare(input({ userRequest: "B" }));
    expect(a.sequence).toBe(b.sequence);
    state.commit(a);
    expect(() => state.commit(b)).toThrow(/sequence conflict/i);
    await state.flush();
  });
});
