import { describe, expect, it } from "vitest";
import {
  isToolBusinessFailure,
  processTitle,
  toolLabel,
  toolLine,
  toolStepLabel,
} from "./process-summary";

describe("process-summary", () => {
  it("titles like ChatGPT: 思考了 Ns", () => {
    const base = { startedAt: Date.now() - 31_000, steps: [] as [] };
    expect(processTitle({
      ...base,
      status: "done",
      steps: [{ id: "1", kind: "thinking", text: "hello" }],
      endedAt: Date.now(),
    })).toMatch(/^思考了 \d+s$/);
    expect(processTitle({
      status: "running",
      startedAt: Date.now() - 5000,
      steps: [{ id: "1", kind: "tool", name: "generate_from_desk", status: "running" }],
    })).toBe("桌面生图中");
    // 工具已失败但整轮未结束：仍是处理中，不是「思考了」
    expect(processTitle({
      status: "running",
      startedAt: Date.now() - 17_000,
      steps: [
        { id: "1", kind: "thinking", text: "english monologue" },
        { id: "2", kind: "tool", name: "generate_from_desk", status: "failed", label: "400" },
      ],
    })).toMatch(/^处理中 · \d+s$/);
    // startedAt 非法时不应 NaN
    expect(processTitle({
      status: "done",
      startedAt: Number.NaN,
      steps: [{ id: "1", kind: "thinking", text: "x" }],
    })).toBe("思考了 1s");
  });

  it("tool lines are short Chinese", () => {
    expect(toolLine({ id: "1", kind: "tool", name: "generate_from_desk", status: "succeeded" })).toBe("已调用桌面生图");
    expect(toolLine({ id: "1", kind: "tool", name: "generate_from_desk", status: "failed", label: "图服务错误" }))
      .toBe("桌面生图失败：图服务错误");
    expect(toolLabel("generate_from_desk")).toBe("桌面生图");
    expect(toolLabel("look_at")).toBe("细看物件");
    expect(toolLabel("look_at_desk")).toBe("桌面总览");
    expect(toolLabel("load_skill")).toBe("加载技能");
  });

  it("detects business failure without isError", () => {
    expect(isToolBusinessFailure({
      content: [{ type: "text", text: "生成失败：图服务返回错误" }],
      details: { ok: false, status: "failed", error: "图服务返回错误" },
    }, false)).toBe(true);
  });

  it("trusts explicit ok over failure keywords in prose", () => {
    expect(isToolBusinessFailure({
      content: [{ type: "text", text: "不要把失败案例当成既定事实；无法确认时直接说明。" }],
      details: { ok: true, skill_id: "desk-loop" },
    }, false)).toBe(false);
  });

  it("treats policy denials as delivered results, not failures", () => {
    expect(isToolBusinessFailure({
      content: [{ type: "text", text: "当前轮次用于读取并汇报后台任务结果；新的用户操作请求会开启可执行轮次。" }],
      details: { ok: false, error_code: "POLICY_DENIED", code: "WAKE_READ_ONLY" },
    }, false)).toBe(false);
  });

  it("labels steps from prompt or error only", () => {
    expect(toolStepLabel({ prompt: "生成完整俯视图" }, undefined, false)).toBe("生成完整俯视图");
    expect(toolStepLabel(undefined, {
      details: { error: "未找到该 Artifact" },
      content: [{ type: "text", text: "生成失败：未找到该 Artifact" }],
    }, true)).toBe("未找到该 Artifact");
  });
});
