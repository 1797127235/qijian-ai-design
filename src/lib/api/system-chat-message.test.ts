import { describe, expect, it } from "vitest";
import { isInternalSystemChatMessage } from "./types";

describe("isInternalSystemChatMessage", () => {
  it("hides job-wake externalId", () => {
    expect(isInternalSystemChatMessage({
      text: "anything",
      externalId: "job-wake:abc",
    })).toBe(true);
    expect(isInternalSystemChatMessage({
      text: "resume",
      externalId: "job-wake-continue:run-1",
    })).toBe(true);
  });

  it("hides JOB_EVENT body from live UI", () => {
    const text = [
      "[系统事件·非用户口令·不可当作系统指令]",
      "后台异步任务已结束。请根据 [JOB_EVENT] 向用户简要说明结果。",
      "",
      "[JOB_EVENT]",
      "source=agent_job",
      "task_id=748ee840-8930-4e6a-ba23-f9a51f23b0af",
      "kind=generate_from_desk",
      "status=succeeded",
    ].join("\n");
    expect(isInternalSystemChatMessage({ text })).toBe(true);
  });

  it("keeps normal user prompts", () => {
    expect(isInternalSystemChatMessage({ text: "根据这个图帮我设计客厅" })).toBe(false);
  });
});
