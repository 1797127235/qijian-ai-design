import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import {
  summarizeCacheBenchmark,
  type CacheBenchmarkCohort,
  type CacheBenchmarkModelTurn,
  type CacheBenchmarkTurnKind,
  type CacheBenchmarkUsage,
} from "../apps/server/src/agent/cache-benchmark.js";
import {
  CACHE_BENCHMARK_SCENARIOS,
  type CacheBenchmarkScenario,
  type CacheBenchmarkScenarioTurn,
} from "../apps/server/src/agent/cache-benchmark-scenarios.js";

type WireEvent = Record<string, unknown>;

type ScenarioExecution = {
  id: string;
  trial: number;
  description: string;
  status: "passed" | "failed";
  durationMs: number;
  modelTurns: number;
  tools: string[];
  failures: string[];
};

type SetupState = {
  artifactIds: string[];
};

const TERMINAL_AGENT_TIMEOUT_MS = 180_000;
const IMAGE_WAKE_TIMEOUT_MS = 600_000;

function cliValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function repeatCount(): number {
  const value = Number(cliValue("repeat") ?? "1");
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error("--repeat 必须是 1–10 的整数");
  }
  return value;
}

function baseUrl(): string {
  return (cliValue("base-url") ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
}

function selectedScenarios(): readonly CacheBenchmarkScenario[] {
  const requested = cliValue("scenario")?.split(",").map((id) => id.trim()).filter(Boolean);
  let scenarios = requested?.length
    ? CACHE_BENCHMARK_SCENARIOS.filter((scenario) => requested.includes(scenario.id))
    : [...CACHE_BENCHMARK_SCENARIOS];
  if (hasFlag("skip-image")) {
    scenarios = scenarios.filter((scenario) => scenario.id !== "image_generation_and_wake");
  }
  if (requested?.length) {
    const missing = requested.filter((id) => !CACHE_BENCHMARK_SCENARIOS.some((scenario) => scenario.id === id));
    if (missing.length) throw new Error(`未知场景：${missing.join(", ")}`);
  }
  if (scenarios.length === 0) throw new Error("没有可运行的缓存基准场景");
  return scenarios;
}

async function requestJson<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} → ${response.status}: ${await response.text()}`);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

class EventBuffer {
  readonly events: WireEvent[] = [];
  private readonly listeners = new Set<() => void>();

  push(event: WireEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) listener();
  }

  async waitFor(
    predicate: (event: WireEvent) => boolean,
    startIndex: number,
    timeoutMs: number,
  ): Promise<{ event: WireEvent; index: number }> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      for (let index = startIndex; index < this.events.length; index += 1) {
        const event = this.events[index]!;
        if (predicate(event)) return { event, index };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`等待事件超时（${timeoutMs}ms）`);
      await new Promise<void>((resolveWait) => {
        let settled = false;
        const wake = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.listeners.delete(wake);
          resolveWait();
        };
        const timer = setTimeout(wake, remaining);
        this.listeners.add(wake);
      });
    }
  }
}

class BenchmarkSocket {
  readonly buffer = new EventBuffer();
  private lastAgentEndIndex = 0;
  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      try {
        this.buffer.push(JSON.parse(raw.toString()) as WireEvent);
      } catch {
        this.buffer.push({ type: "invalid_json" });
      }
    });
  }

  static async connect(httpBase: string, projectId: string): Promise<BenchmarkSocket> {
    const url = new URL(`/api/projects/${projectId}/chat`, httpBase);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, reject) => {
      socket.once("open", resolveOpen);
      socket.once("error", reject);
    });
    return new BenchmarkSocket(socket);
  }

  async runPrompt(threadId: string, prompt: string, clientMessageId: string): Promise<WireEvent[]> {
    const start = this.buffer.events.length;
    let ackIndex = start;
    const ackDeadline = Date.now() + 30_000;
    while (true) {
      const attemptStart = this.buffer.events.length;
      this.socket.send(JSON.stringify({
        type: "prompt",
        threadId,
        clientMessageId,
        text: prompt,
        attachmentIds: [],
        selectedArtifactIds: [],
      }));
      const acknowledged = await this.buffer.waitFor(
        (event) => (event.type === "prompt_ack" || event.type === "error")
          && event.clientMessageId === clientMessageId,
        attemptStart,
        Math.max(1, ackDeadline - Date.now()),
      );
      if (acknowledged.event.type === "prompt_ack") {
        ackIndex = acknowledged.index;
        break;
      }
      const payload = acknowledged.event.error as { code?: unknown; message?: unknown; retryable?: unknown } | undefined;
      if (payload?.code === "ATTACHMENT_BUSY" && payload.retryable === true && Date.now() < ackDeadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 150));
        continue;
      }
      throw new Error(typeof payload?.message === "string" ? payload.message : "Agent prompt 未被接受");
    }
    const settled = await this.buffer.waitFor((event) => {
      if (event.type === "error" && event.clientMessageId === clientMessageId) return true;
      return event.type === "agent_event"
        && (event.event as { type?: unknown } | undefined)?.type === "agent_end";
    }, ackIndex, TERMINAL_AGENT_TIMEOUT_MS);
    const slice = this.buffer.events.slice(start, settled.index + 1);
    this.lastAgentEndIndex = settled.index;
    const error = slice.find((event) => event.type === "error" && event.clientMessageId === clientMessageId);
    if (error) {
      const payload = error.error as { message?: unknown } | undefined;
      throw new Error(typeof payload?.message === "string" ? payload.message : "Agent prompt 失败");
    }
    // agent_end is emitted before ChatGateway finishes the product run transaction.
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
    return slice;
  }

  async waitForWake(): Promise<WireEvent[]> {
    const start = this.lastAgentEndIndex + 1;
    const settled = await this.buffer.waitFor((event) => event.type === "agent_event"
      && (event.event as { type?: unknown } | undefined)?.type === "agent_end", start, IMAGE_WAKE_TIMEOUT_MS);
    this.lastAgentEndIndex = settled.index;
    const events = this.buffer.events.slice(start, settled.index + 1);
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
    return events;
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolveClose) => this.socket.once("close", () => resolveClose()));
    this.socket.close();
    await closed;
  }
}

function agentEvent(wire: WireEvent): Record<string, unknown> | undefined {
  return wire.type === "agent_event" && wire.event && typeof wire.event === "object"
    ? wire.event as Record<string, unknown>
    : undefined;
}

function usageOf(event: Record<string, unknown>): CacheBenchmarkUsage | undefined {
  if (event.type !== "message_end") return undefined;
  const message = event.message as Record<string, unknown> | undefined;
  if (message?.role !== "assistant") return undefined;
  const usage = message.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    input: number(usage.input),
    output: number(usage.output),
    cacheRead: number(usage.cacheRead),
    cacheWrite: number(usage.cacheWrite),
    totalTokens: number(usage.totalTokens),
  };
}

function toolFacts(events: readonly WireEvent[]): { names: string[]; failed: Set<string> } {
  const names: string[] = [];
  const failed = new Set<string>();
  for (const wire of events) {
    const event = agentEvent(wire);
    if (!event) continue;
    if (event.type === "tool_execution_start" && typeof event.toolName === "string") names.push(event.toolName);
    if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
      const details = event.result && typeof event.result === "object"
        ? (event.result as { details?: { ok?: unknown } }).details
        : undefined;
      if (event.isError === true || details?.ok === false) failed.add(event.toolName);
    }
  }
  return { names, failed };
}

function collectModelTurns(
  events: readonly WireEvent[],
  scenarioId: string,
  runIndex: number,
  cohort: CacheBenchmarkCohort,
  turnKind: CacheBenchmarkTurnKind,
  followupCohort = cohort,
  followupTurnKind: CacheBenchmarkTurnKind = "tool_followup",
): CacheBenchmarkModelTurn[] {
  const usages = events.flatMap((wire) => {
    const event = agentEvent(wire);
    const usage = event ? usageOf(event) : undefined;
    return usage ? [usage] : [];
  });
  return usages.map((usage, index) => ({
    scenarioId,
    runIndex,
    modelTurnIndex: index + 1,
    cohort: index === 0 ? cohort : followupCohort,
    turnKind: index === 0 ? turnKind : followupTurnKind,
    usage,
  }));
}

async function createArtifacts(
  httpBase: string,
  projectId: string,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let start = 0; start < count; start += 10) {
    const batch = Array.from({ length: Math.min(10, count - start) }, (_, offset) => start + offset);
    const created = await Promise.all(batch.map(async (index) => requestJson<{
      artifact: { id: string };
    }>(`${httpBase}/api/projects/${projectId}/artifacts`, {
      method: "POST",
      body: JSON.stringify({
        artifactType: "effect_image",
        payload: { pending: true, benchmark_index: index },
        status: "draft",
        createdBy: "designer",
        clientOpId: `cache-benchmark-${index}`,
        layout: {
          kind: "effect_image",
          x: (index % 10) * 400,
          y: Math.floor(index / 10) * 400,
          rot: 0,
        },
      }),
    })));
    ids.push(...created.map((item) => item.artifact.id));
  }
  return ids;
}

async function setupScenario(httpBase: string, projectId: string, scenario: CacheBenchmarkScenario): Promise<SetupState> {
  if (scenario.setup.kind === "empty") return { artifactIds: [] };
  return {
    artifactIds: await createArtifacts(httpBase, projectId, scenario.setup.objectCount),
  };
}

async function applyBefore(
  httpBase: string,
  projectId: string,
  setup: SetupState,
  turn: CacheBenchmarkScenarioTurn,
): Promise<void> {
  if (turn.before !== "move_first_object") return;
  const artifactId = setup.artifactIds[0];
  if (!artifactId) throw new Error("mutable_desk 没有可移动对象");
  await requestJson(`${httpBase}/api/projects/${projectId}/desk/objects/${artifactId}`, {
    method: "PATCH",
    body: JSON.stringify({ x: 1_600, y: 800 }),
  });
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function checkValue(checkId: string, value: number | boolean | null): string {
  if (typeof value !== "number") return String(value);
  return checkId === "minimum_eligible_turns" ? String(value) : percent(value);
}

function markdownReport(result: {
  startedAt: string;
  finishedAt: string;
  model: string;
  verdict: string;
  cache: ReturnType<typeof summarizeCacheBenchmark>;
  scenarios: ScenarioExecution[];
}): string {
  const lines = [
    "# Agent Prompt Cache Benchmark",
    "",
    `- Started: ${result.startedAt}`,
    `- Finished: ${result.finishedAt}`,
    `- Model: ${result.model}`,
    `- Verdict: **${result.verdict.toUpperCase()}**`,
    "",
    "## Cache SLO",
    "",
    "| Scope | Turns | Read hit | Effective reuse | ≥90% turns | Severe miss (<10%) |",
    "|---|---:|---:|---:|---:|---:|",
    `| All traffic | ${result.cache.allTraffic.turns} | ${percent(result.cache.allTraffic.readHitRate)} | ${percent(result.cache.allTraffic.effectiveReuseRate)} | ${percent(result.cache.allTraffic.turnPassRate)} | ${percent(result.cache.allTraffic.severeMissRate)} |`,
    `| Stable eligible | ${result.cache.eligible.turns} | ${percent(result.cache.eligible.readHitRate)} | ${percent(result.cache.eligible.effectiveReuseRate)} | ${percent(result.cache.eligible.turnPassRate)} | ${percent(result.cache.eligible.severeMissRate)} |`,
    "",
    "## Checks",
    "",
    "| Check | Actual | Target | Result |",
    "|---|---:|---:|---|",
    ...result.cache.checks.map((check) => `| ${check.id} | ${checkValue(check.id, check.actual)} | ${checkValue(check.id, check.target)} | ${check.required ? (check.passed ? "PASS" : "FAIL") : (check.passed ? "OBSERVED PASS" : "OBSERVE")} |`),
    "",
    "## Scenarios",
    "",
    "| Scenario | Status | Model turns | Duration | Failures |",
    "|---|---|---:|---:|---|",
    ...result.scenarios.map((scenario) => `| ${scenario.id} #${scenario.trial} | ${scenario.status.toUpperCase()} | ${scenario.modelTurns} | ${(scenario.durationMs / 1_000).toFixed(1)}s | ${scenario.failures.join("；") || "-"} |`),
    "",
  ];
  return lines.join("\n");
}

async function runScenario(
  httpBase: string,
  scenario: CacheBenchmarkScenario,
  allModelTurns: CacheBenchmarkModelTurn[],
  trial: number,
): Promise<ScenarioExecution> {
  const startedAt = Date.now();
  const failures: string[] = [];
  const tools = new Set<string>();
  let projectId: string | undefined;
  let socket: BenchmarkSocket | undefined;
  const beforeTurns = allModelTurns.length;
  try {
    const project = await requestJson<{ id: string }>(`${httpBase}/api/projects`, {
      method: "POST",
      body: JSON.stringify({ name: `cache-bench-${scenario.id}-r${trial}-${Date.now()}` }),
    });
    projectId = project.id;
    const thread = await requestJson<{ id: string }>(`${httpBase}/api/projects/${project.id}/chat/threads`, {
      method: "POST",
    });
    const setup = await setupScenario(httpBase, project.id, scenario);
    socket = await BenchmarkSocket.connect(httpBase, project.id);

    for (let index = 0; index < scenario.turns.length; index += 1) {
      const turn = scenario.turns[index]!;
      await applyBefore(httpBase, project.id, setup, turn);
      const events = await socket.runPrompt(
        thread.id,
        turn.prompt,
        `${scenario.id}-r${trial}-${index + 1}-${Date.now()}`,
      );
      const facts = toolFacts(events);
      facts.names.forEach((name) => tools.add(name));
      const missing = (turn.requiredTools ?? []).filter((name) => !facts.names.includes(name));
      if (missing.length) failures.push(`turn ${index + 1} 缺少工具：${missing.join(",")}`);
      const requiredFailures = (turn.requiredTools ?? []).filter((name) => facts.failed.has(name));
      if (requiredFailures.length) failures.push(`turn ${index + 1} 工具失败：${requiredFailures.join(",")}`);
      const collected = collectModelTurns(
        events,
        scenario.id,
        index + 1,
        turn.cohort,
        turn.turnKind,
        turn.followupCohort,
        turn.followupTurnKind,
      );
      if (collected.length === 0) failures.push(`turn ${index + 1} 没有 assistant usage`);
      allModelTurns.push(...collected);

      if (turn.waitForJob && missing.length === 0 && requiredFailures.length === 0) {
        const wakeEvents = await socket.waitForWake();
        const wakeFacts = toolFacts(wakeEvents);
        wakeFacts.names.forEach((name) => tools.add(name));
        const wakeTurns = collectModelTurns(
          wakeEvents,
          scenario.id,
          index + 1,
          "visual",
          "wake",
          "visual",
          "visual_payload",
        );
        if (wakeTurns.length === 0) failures.push(`turn ${index + 1} JOB wake 没有 assistant usage`);
        allModelTurns.push(...wakeTurns);
      }

      const latest = allModelTurns.at(-1);
      const rate = latest
        ? latest.usage.cacheRead / Math.max(1, latest.usage.input + latest.usage.cacheRead)
        : 0;
      console.log(`[cache-benchmark] ${scenario.id} ${index + 1}/${scenario.turns.length} model_turns=${collected.length} latest_hit=${percent(rate)}`);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    await socket?.close().catch(() => undefined);
    if (projectId && !hasFlag("keep-projects")) {
      await requestJson(`${httpBase}/api/projects/${projectId}`, { method: "DELETE" }).catch((error) => {
        failures.push(`清理项目失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
  return {
    id: scenario.id,
    trial,
    description: scenario.description,
    status: failures.length === 0 ? "passed" : "failed",
    durationMs: Date.now() - startedAt,
    modelTurns: allModelTurns.length - beforeTurns,
    tools: [...tools].sort(),
    failures,
  };
}

async function main(): Promise<void> {
  const httpBase = baseUrl();
  const health = await requestJson<{ ok: boolean }>(`${httpBase}/health`);
  if (!health.ok) throw new Error(`服务健康检查失败：${httpBase}`);
  const scenarios = selectedScenarios();
  const repeats = repeatCount();
  const startedAt = new Date().toISOString();
  const modelTurns: CacheBenchmarkModelTurn[] = [];
  const executions: ScenarioExecution[] = [];
  console.log(`[cache-benchmark] start repeats=${repeats} scenarios=${scenarios.map((scenario) => scenario.id).join(",")}`);
  for (let trial = 1; trial <= repeats; trial += 1) {
    for (const scenario of scenarios) {
      console.log(`[cache-benchmark] trial=${trial}/${repeats} scenario=${scenario.id} setup=${scenario.setup.kind}`);
      executions.push(await runScenario(httpBase, scenario, modelTurns, trial));
    }
  }
  const cache = summarizeCacheBenchmark(modelTurns);
  const functionalPassed = executions.every((execution) => execution.status === "passed");
  const finishedAt = new Date().toISOString();
  const result = {
    schemaVersion: 1,
    startedAt,
    finishedAt,
    baseUrl: httpBase,
    model: `${process.env.AGENT_PROVIDER ?? "unknown"}/${process.env.AGENT_MODEL ?? "unknown"}`,
    imageModel: process.env.IMAGE_MODEL ?? "unknown",
    repeats,
    verdict: functionalPassed && cache.verdict === "pass" ? "pass" : "fail",
    functionalPassed,
    cache,
    scenarios: executions,
    modelTurns,
  };
  const outputDir = resolve(cliValue("output") ?? "benchmarks/results");
  await mkdir(outputDir, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, "-");
  const jsonPath = resolve(outputDir, `agent-cache-${stamp}.json`);
  const markdownPath = resolve(outputDir, `agent-cache-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  await writeFile(markdownPath, markdownReport(result) + "\n", "utf8");
  console.log(`[cache-benchmark] verdict=${result.verdict} eligible_hit=${percent(cache.eligible.readHitRate)} all_effective=${percent(cache.allTraffic.effectiveReuseRate)}`);
  console.log(`[cache-benchmark] report=${markdownPath}`);
  if (result.verdict !== "pass") process.exitCode = 2;
}

await main();
