import { describe, expect, it } from "vitest";
import {
  acceptedDetails,
  acceptedToolText,
  formatJobsStatusBlock,
  publicJobErrorForAgent,
} from "./protocol.js";
import type { AgentJobDto } from "./types.js";

const baseJob = (patch: Partial<AgentJobDto> = {}): AgentJobDto => ({
  id: "job-1",
  projectId: "p1",
  threadId: "t1",
  kind: "generate_from_desk",
  status: "running",
  input: { prompt: "改成日式暖色木质客厅" },
  createdAt: new Date().toISOString(),
  ...patch,
});

describe("async job protocol", () => {
  it("builds accepted details", () => {
    const details = acceptedDetails(baseJob({ status: "accepted", artifactId: "fx-1" }));
    expect(details).toMatchObject({
      ok: true,
      async: true,
      status: "accepted",
      task_id: "job-1",
      artifact_id: "fx-1",
    });
    expect(acceptedToolText(details)).toContain("task_id=job-1");
    expect(acceptedToolText(details)).toContain("不要声称已生成成功");
    expect(acceptedToolText(details)).toContain("JOB_EVENT");
    expect(acceptedToolText(details)).toContain("不要循环 get_task");
  });

  it("formats status block for desk prompt", () => {
    const block = formatJobsStatusBlock([
      baseJob({ status: "running", artifactId: "fx-1" }),
      baseJob({
        id: "job-2",
        status: "failed",
        error: "图像服务调用失败（HTTP 500）：upstream error: do request failed",
        artifactId: "fx-2",
      }),
    ]);
    expect(block).toContain("[后台任务]");
    expect(block).toContain("running");
    expect(block).toContain("failed");
    expect(block).toContain("日式暖色");
    expect(block).toContain("HTTP 500");
    expect(block).not.toContain("error=任务失败");
  });

  it("returns empty string when no jobs", () => {
    expect(formatJobsStatusBlock([])).toBe("");
  });

  it("publicJobErrorForAgent keeps actionable detail", () => {
    expect(publicJobErrorForAgent("图像服务调用失败（HTTP 500）：do_request_failed")).toContain("HTTP 500");
    expect(publicJobErrorForAgent("未知生图 model：nope")).toContain("未知生图 model");
    expect(publicJobErrorForAgent(undefined)).toBeUndefined();
  });
});
