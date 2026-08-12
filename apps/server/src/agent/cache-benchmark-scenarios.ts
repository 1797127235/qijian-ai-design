import type {
  CacheBenchmarkCohort,
  CacheBenchmarkTurnKind,
} from "./cache-benchmark.js";

export type CacheBenchmarkSetup =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "large_desk"; objectCount: number }>
  | Readonly<{ kind: "mutable_desk"; objectCount: number }>;

export type CacheBenchmarkScenarioTurn = Readonly<{
  prompt: string;
  cohort: CacheBenchmarkCohort;
  turnKind: CacheBenchmarkTurnKind;
  followupCohort?: CacheBenchmarkCohort;
  followupTurnKind?: CacheBenchmarkTurnKind;
  requiredTools?: readonly string[];
  waitForJob?: boolean;
  before?: "move_first_object";
}>;

export type CacheBenchmarkScenario = Readonly<{
  id: string;
  description: string;
  setup: CacheBenchmarkSetup;
  turns: readonly CacheBenchmarkScenarioTurn[];
}>;

function conciseSteadyTurns(
  subject: string,
  count = 13,
  warmupCount = 4,
): CacheBenchmarkScenarioTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    prompt: `继续讨论${subject}。请只用一句中文回复“第 ${index + 2} 轮已收到”。`,
    cohort: index < warmupCount ? "warmup" as const : "eligible" as const,
    turnKind: "steady_user" as const,
  }));
}

export const CACHE_BENCHMARK_SCENARIOS: readonly CacheBenchmarkScenario[] = Object.freeze([
  {
    id: "steady_dialogue",
    description: "空桌连续纯文本对话，验证 system/tools/history 稳定前缀。",
    setup: { kind: "empty" },
    turns: [
      {
        prompt: "今天先讨论空间氛围。请只回复“第 1 轮已收到”。",
        cohort: "cold",
        turnKind: "thread_first",
      },
      ...conciseSteadyTurns("空间氛围"),
    ],
  },
  {
    id: "skill_emit_once",
    description: "显式 Skill 首次注入后继续对话，验证正文 emit-once 与后续前缀复用。",
    setup: { kind: "empty" },
    turns: [
      {
        prompt: "请使用 $design-language，只用一句话给出暖木客厅的视觉语言原则。",
        cohort: "cold",
        turnKind: "thread_first",
      },
      ...conciseSteadyTurns("暖木视觉语言"),
    ],
  },
  {
    id: "memory_tool_chain",
    description: "真实 memory 工具链（固定全量工具集下直接调用），验证工具跟进后的前缀复用。",
    setup: { kind: "empty" },
    turns: [
      {
        prompt: "这是记忆工具链测试。请调用 record_project_memory 写入 stable_key=benchmark.cache、family=project_procedure、summary=缓存基准测试中。完成后只用一句话确认。",
        cohort: "cold",
        turnKind: "thread_first",
        requiredTools: ["record_project_memory"],
      },
      {
        prompt: "必须调用 inspect_project_memory 核对刚才的 benchmark.cache，然后只用一句话回答。",
        cohort: "warmup",
        turnKind: "steady_user",
        requiredTools: ["inspect_project_memory"],
      },
      ...conciseSteadyTurns("项目约定", 12, 3),
    ],
  },
  {
    id: "large_desk_resync",
    description: "140 个对象触发 Desk full 硬预算，随后验证 unchanged 稳定态缓存。",
    setup: { kind: "large_desk", objectCount: 140 },
    turns: [
      {
        prompt: "请用一句话概括：当前桌面包含很多设计方向。",
        cohort: "cold",
        turnKind: "thread_first",
      },
      ...conciseSteadyTurns("桌面方向"),
    ],
  },
  {
    id: "desk_delta",
    description: "桌面稳定后移动一个对象，验证小 delta 不破坏历史前缀。",
    setup: { kind: "mutable_desk", objectCount: 20 },
    turns: [
      {
        prompt: "先保留当前布局，请只回复“第 1 轮已收到”。",
        cohort: "cold",
        turnKind: "thread_first",
      },
      {
        prompt: "继续保留当前布局，请只回复“第 2 轮已收到”。",
        cohort: "warmup",
        turnKind: "steady_user",
      },
      {
        prompt: "我注意到布局有轻微调整，请只回复“第 3 轮已收到”。",
        cohort: "warmup",
        turnKind: "steady_user",
        before: "move_first_object",
      },
      ...conciseSteadyTurns("布局变化", 11, 2),
    ],
  },
  {
    id: "image_generation_and_wake",
    description: "真实文生图、工具跟进和异步 JOB wake，再验证后续稳定轮。",
    setup: { kind: "empty" },
    turns: [
      {
        prompt: "这是生图链路缓存测试。请调用 text_to_image_on_desk 生成一张现代暖木客厅，下午自然光，画面干净。任务受理后只说明已开始，等待系统事件。",
        cohort: "cold",
        turnKind: "thread_first",
        followupCohort: "visual",
        followupTurnKind: "visual_payload",
        requiredTools: ["text_to_image_on_desk"],
        waitForJob: true,
      },
      ...conciseSteadyTurns("生成后的空间方向"),
    ],
  },
]);
