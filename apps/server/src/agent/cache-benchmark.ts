export type CacheBenchmarkCohort = "cold" | "warmup" | "eligible" | "epoch_boundary" | "visual";

export type CacheBenchmarkTurnKind =
  | "thread_first"
  | "steady_user"
  | "tool_followup"
  | "wake"
  | "context_epoch_changed"
  | "tool_epoch_changed"
  | "compaction_first"
  | "visual_payload";

export type CacheBenchmarkUsage = Readonly<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}>;

export type CacheBenchmarkModelTurn = Readonly<{
  scenarioId: string;
  runIndex: number;
  modelTurnIndex: number;
  cohort: CacheBenchmarkCohort;
  turnKind: CacheBenchmarkTurnKind;
  usage: CacheBenchmarkUsage;
}>;

export type CacheBenchmarkThresholds = Readonly<{
  eligibleReadHitRate: number;
  eligibleTurnHitRate: number;
  eligibleTurnPassRate: number;
  allTrafficEffectiveReuseRate: number;
  minimumEligibleTurns: number;
}>;

export const DEFAULT_CACHE_BENCHMARK_THRESHOLDS: CacheBenchmarkThresholds = Object.freeze({
  eligibleReadHitRate: 0.92,
  eligibleTurnHitRate: 0.9,
  eligibleTurnPassRate: 0.9,
  allTrafficEffectiveReuseRate: 0.9,
  minimumEligibleTurns: 5,
});

export type CacheBenchmarkAggregate = Readonly<{
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  readHitRate: number | null;
  effectiveReuseRate: number | null;
  turnPassRate: number | null;
  severeMissRate: number | null;
}>;

export type CacheBenchmarkCheck = Readonly<{
  id: string;
  required: boolean;
  passed: boolean;
  actual: number | boolean | null;
  target: number | boolean;
}>;

export type CacheBenchmarkReport = Readonly<{
  schemaVersion: 1;
  verdict: "pass" | "fail";
  cacheSignal: boolean;
  thresholds: CacheBenchmarkThresholds;
  allTraffic: CacheBenchmarkAggregate;
  eligible: CacheBenchmarkAggregate;
  byScenario: Readonly<Record<string, Readonly<{
    allTraffic: CacheBenchmarkAggregate;
    eligible: CacheBenchmarkAggregate;
  }>>>;
  checks: readonly CacheBenchmarkCheck[];
}>;

function safeNumber(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function aggregate(
  turns: readonly CacheBenchmarkModelTurn[],
  turnHitThreshold: number,
): CacheBenchmarkAggregate {
  const totals = turns.reduce((sum, turn) => ({
    input: sum.input + safeNumber(turn.usage.input),
    output: sum.output + safeNumber(turn.usage.output),
    cacheRead: sum.cacheRead + safeNumber(turn.usage.cacheRead),
    cacheWrite: sum.cacheWrite + safeNumber(turn.usage.cacheWrite),
    totalTokens: sum.totalTokens + safeNumber(turn.usage.totalTokens),
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
  const passingTurns = turns.filter((turn) => {
    const input = safeNumber(turn.usage.input);
    const cacheRead = safeNumber(turn.usage.cacheRead);
    return (ratio(cacheRead, input + cacheRead) ?? 0) >= turnHitThreshold;
  }).length;
  const severeMisses = turns.filter((turn) => {
    const input = safeNumber(turn.usage.input);
    const cacheRead = safeNumber(turn.usage.cacheRead);
    return (ratio(cacheRead, input + cacheRead) ?? 0) < 0.1;
  }).length;
  return Object.freeze({
    turns: turns.length,
    ...totals,
    readHitRate: ratio(totals.cacheRead, totals.input + totals.cacheRead),
    effectiveReuseRate: ratio(
      totals.cacheRead,
      totals.input + totals.cacheRead + totals.cacheWrite,
    ),
    turnPassRate: turns.length > 0 ? passingTurns / turns.length : null,
    severeMissRate: turns.length > 0 ? severeMisses / turns.length : null,
  });
}

export function summarizeCacheBenchmark(
  turns: readonly CacheBenchmarkModelTurn[],
  thresholds: CacheBenchmarkThresholds = DEFAULT_CACHE_BENCHMARK_THRESHOLDS,
): CacheBenchmarkReport {
  const eligibleTurns = turns.filter((turn) => turn.cohort === "eligible");
  const allTraffic = aggregate(turns, thresholds.eligibleTurnHitRate);
  const eligible = aggregate(eligibleTurns, thresholds.eligibleTurnHitRate);
  const scenarioIds = [...new Set(turns.map((turn) => turn.scenarioId))].sort();
  const byScenario = Object.fromEntries(scenarioIds.map((scenarioId) => {
    const scenarioTurns = turns.filter((turn) => turn.scenarioId === scenarioId);
    return [scenarioId, Object.freeze({
      allTraffic: aggregate(scenarioTurns, thresholds.eligibleTurnHitRate),
      eligible: aggregate(
        scenarioTurns.filter((turn) => turn.cohort === "eligible"),
        thresholds.eligibleTurnHitRate,
      ),
    })];
  }));
  const cacheSignal = allTraffic.cacheRead > 0 || allTraffic.cacheWrite > 0;
  const checks: CacheBenchmarkCheck[] = [
    {
      id: "provider_cache_signal",
      required: true,
      passed: cacheSignal,
      actual: cacheSignal,
      target: true,
    },
    {
      id: "minimum_eligible_turns",
      required: true,
      passed: eligible.turns >= thresholds.minimumEligibleTurns,
      actual: eligible.turns,
      target: thresholds.minimumEligibleTurns,
    },
    {
      id: "eligible_read_hit_rate",
      required: true,
      passed: (eligible.readHitRate ?? 0) >= thresholds.eligibleReadHitRate,
      actual: eligible.readHitRate,
      target: thresholds.eligibleReadHitRate,
    },
    {
      id: "eligible_turn_pass_rate",
      required: true,
      passed: (eligible.turnPassRate ?? 0) >= thresholds.eligibleTurnPassRate,
      actual: eligible.turnPassRate,
      target: thresholds.eligibleTurnPassRate,
    },
    {
      id: "all_traffic_effective_reuse_rate",
      required: false,
      passed: (allTraffic.effectiveReuseRate ?? 0) >= thresholds.allTrafficEffectiveReuseRate,
      actual: allTraffic.effectiveReuseRate,
      target: thresholds.allTrafficEffectiveReuseRate,
    },
  ];

  return Object.freeze({
    schemaVersion: 1,
    verdict: checks.filter((check) => check.required).every((check) => check.passed) ? "pass" : "fail",
    cacheSignal,
    thresholds,
    allTraffic,
    eligible,
    byScenario: Object.freeze(byScenario),
    checks: Object.freeze(checks),
  });
}
