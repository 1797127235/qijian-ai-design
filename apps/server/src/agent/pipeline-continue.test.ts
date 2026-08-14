import { describe, expect, it } from "vitest";
import {
  formatPipelineContinuePrompt,
  jobWakeContinueExternalId,
  runOpenedDeskWork,
  shouldResumeAfterWake,
} from "./pipeline-continue.js";

describe("pipeline continue", () => {
  it("opens work only when a desk generate tool ran", () => {
    expect(runOpenedDeskWork(["look_at", "generate_from_desk"])).toBe(true);
    expect(runOpenedDeskWork(["text_to_image_on_desk"])).toBe(true);
    expect(runOpenedDeskWork(["replace_on_desk"])).toBe(true);
    expect(runOpenedDeskWork(["look_at", "load_skill"])).toBe(false);
    expect(runOpenedDeskWork([])).toBe(false);
  });

  it("resumes after wake only when work is open and not all failed", () => {
    expect(shouldResumeAfterWake(true, "status=succeeded\n")).toBe(true);
    expect(shouldResumeAfterWake(true, "outcome=partial")).toBe(true);
    expect(shouldResumeAfterWake(true, "outcome=all_failed")).toBe(false);
    expect(shouldResumeAfterWake(false, "status=succeeded\n")).toBe(false);
  });

  it("formats a hidden resume of the same request", () => {
    expect(jobWakeContinueExternalId("run-1")).toBe("job-wake-continue:run-1");
    const text = formatPipelineContinuePrompt();
    expect(text).toContain("[系统事件");
    expect(text).toContain("同一条用户请求");
  });
});
