import { describe, expect, it } from "vitest";
import {
  formatJobEventBlock,
  formatJobWakeBatchPrompt,
  formatJobWakePrompt,
  jobWakeBatchExternalId,
  jobWakeExternalId,
  shouldWakeAgentForJob,
} from "./job-event.js";
import type { AgentJobDto } from "./types.js";

const base = (patch: Partial<AgentJobDto> = {}): AgentJobDto => ({
  id: "job-1",
  projectId: "p1",
  threadId: "t1",
  kind: "generate_from_desk",
  status: "succeeded",
  input: { prompt: "x", model: "gpt-image-2" },
  artifactId: "fx-1",
  createdAt: new Date().toISOString(),
  ...patch,
});

describe("job-event", () => {
  it("wakes only agent generate jobs on terminal status", () => {
    expect(shouldWakeAgentForJob(base())).toBe(true);
    expect(shouldWakeAgentForJob(base({ status: "failed" }))).toBe(true);
    expect(shouldWakeAgentForJob(base({ status: "running" }))).toBe(false);
    expect(shouldWakeAgentForJob(base({ threadId: undefined }))).toBe(false);
    expect(shouldWakeAgentForJob(base({ kind: "caption_file" }))).toBe(false);
  });

  it("formats JOB_EVENT with model and public error", () => {
    const block = formatJobEventBlock(base({
      status: "failed",
      error: "图像服务调用失败（HTTP 500）：do_request_failed",
    }));
    expect(block).toContain("[JOB_EVENT]");
    expect(block).toContain("model=gpt-image-2");
    expect(block).toContain("HTTP 500");
    expect(block).not.toContain("任务失败");
  });

  it("wake prompt marks system event and forbids silent regenerate", () => {
    const text = formatJobWakePrompt(base({ status: "failed", error: "boom" }));
    expect(text).toContain("系统事件");
    expect(text).toContain("禁止");
    expect(text).toContain("generate_from_desk");
    expect(text).toContain("replace_on_desk");
    expect(text).toContain("text_to_image_on_desk");
    expect(jobWakeExternalId("abc")).toBe("job-wake:abc");
  });

  it("batch wake summarizes multiple jobs", () => {
    const text = formatJobWakeBatchPrompt([
      base({ id: "j1", status: "succeeded", artifactId: "a1" }),
      base({ id: "j2", status: "cancelled", artifactId: "a2", error: "生成已取消或超时" }),
    ]);
    expect(text).toContain("[JOB_EVENT_BATCH]");
    expect(text).toContain("succeeded=1");
    expect(text).toContain("failed=1");
    expect(text).toContain("j1");
    expect(text).toContain("j2");
    expect(jobWakeBatchExternalId(["j2", "j1"])).toBe(jobWakeBatchExternalId(["j1", "j2"]));
  });
});

