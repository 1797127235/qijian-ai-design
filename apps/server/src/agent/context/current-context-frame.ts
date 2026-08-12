/**
 * Current Context Frame：每轮发给模型的「当前状态」唯一编译出口。
 *
 * 缓存策略：provider 前缀（system / tools / 历史轨迹）保持稳定，动态局面全部
 * 收敛进本模块渲染的 <system_context_frame>，置于当轮 user 消息头部、用户原文之前。
 * Desk / Jobs / Memory 对照 Ledger 记录的上次注入基线三态输出：
 * full（首轮 / resync）→ unchanged（revision 不变，一行带过）→ delta（只发增删改）。
 *
 * 两阶段提交：prepare() 只渲染不改状态；session.prompt 成功后 commit() 才推进
 * seq 与基线——prompt 失败时 Ledger 不前进，下一轮自动重发同一状态。
 * compaction 或轨迹锚点对不上时 forceResync() 开启新 trajectory_epoch，下轮回到 full。
 * Ledger 按会话持久化，临时文件 + rename 原子落盘。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson, sha256 } from "../cache-contract.js";
import type { DeskManifestEntry } from "../desk-context.js";
import type { InjectedSkill } from "../skills/resolver.js";
import type { ContextResourceStore } from "./resource-store.js";
import {
  MAX_DESK_FULL_CONTEXT_CHARS,
  budgetDeskFullContext,
  type DeskFullContextBudgetMetrics,
} from "./suffix-budgeter.js";

const LEDGER_VERSION = 1 as const;

export type MemoryFrameEntry = Readonly<{
  stableKey: string;
  family: string;
  summary: string;
  body: string;
}>;

export type JobFrameEntry = Readonly<{
  id: string;
  kind: string;
  status: string;
  artifactId?: string;
  error?: string;
  label?: string;
}>;

export type CurrentContextFrameInput = Readonly<{
  source: "interactive" | "job_event";
  mode: "designer" | "wake";
  authority: "user_explicit" | "user_implicit" | "system_event";
  policyRevision: string;
  desk: Readonly<{
    revision: string;
    fullText: string;
    requestText: string;
    manifest: Readonly<Record<string, DeskManifestEntry>>;
    priorityArtifactIds: readonly string[];
  }>;
  jobs: Readonly<{
    revision: string;
    fullText: string;
    entries: Readonly<Record<string, JobFrameEntry>>;
  }>;
  memory: Readonly<{
    revision: number | string;
    fullText: string;
    entries: Readonly<Record<string, MemoryFrameEntry>>;
  }>;
  inspectText: string;
  toolEpoch: number;
  activeTools: readonly string[];
  loadedSkillRevisions: Readonly<Record<string, string>>;
  emittedSkillRevisions: Readonly<Record<string, string>>;
  injectedSkills: readonly InjectedSkill[];
  userRequest: string;
}>;

type PersistedContextLedger = {
  version: typeof LEDGER_VERSION;
  contextEpoch: string;
  trajectoryEpoch: number;
  nextFrameSeq: number;
  lastTrajectoryAnchor?: string;
  lastDeskRevision?: string;
  lastDeskManifest: Record<string, DeskManifestEntry>;
  lastJobsRevision?: string;
  lastJobsEntries: Record<string, JobFrameEntry>;
  lastMemoryRevision?: string;
  lastMemoryEntries: Record<string, MemoryFrameEntry>;
};

export type ContextLedgerSnapshot = Readonly<{
  version: typeof LEDGER_VERSION;
  contextEpoch: string;
  trajectoryEpoch: number;
  nextFrameSeq: number;
  lastTrajectoryAnchor?: string;
  lastDeskRevision?: string;
  lastJobsRevision?: string;
  lastMemoryRevision?: string;
}>;

/** prepare 的下一个 Ledger 快照搭 Symbol 便车传给 commit；不进 JSON，避免被序列化或误当普通字段 */
const PREPARED_LEDGER = Symbol("prepared-context-ledger");

export type PreparedCurrentContextFrame = Readonly<{
  sequence: number;
  trajectoryEpoch: number;
  frameText: string;
  frameSha256: string;
  promptText: string;
  contextBudget?: Readonly<{
    desk_full: DeskFullContextBudgetMetrics;
  }>;
  [PREPARED_LEDGER]: PersistedContextLedger;
}>;

export type CurrentContextFrameStateOptions = {
  filePath: string;
  contextEpoch: string;
  resourceStore: Pick<ContextResourceStore, "putText">;
};

function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function xmlAttribute(value: string): string {
  return xmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function normalizedText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function sortedRecord<T>(value: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validPositiveInteger(value: unknown): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : 1;
}

function isMemoryRevision(value: string): boolean {
  return /^\d+$/.test(value);
}

function renderTextElement(name: string, attributes: string, body: string): string {
  const text = normalizedText(body);
  if (!text) return `<${name} ${attributes} />`;
  return `<${name} ${attributes}>\n${xmlText(text)}\n</${name}>`;
}

function renderStructuredElement(name: string, attributes: string, body: string): string {
  const text = normalizedText(body);
  if (!text) return `<${name} ${attributes} />`;
  return `<${name} ${attributes}>\n${text}\n</${name}>`;
}

function renderDeskEntry(kind: "added" | "updated", entry: DeskManifestEntry): string {
  return `  <${kind} id="${xmlAttribute(entry.id)}" value="${xmlAttribute(canonicalJson(entry))}" />`;
}

function renderDeskDelta(
  previous: Readonly<Record<string, DeskManifestEntry>>,
  current: Readonly<Record<string, DeskManifestEntry>>,
): string {
  const lines: string[] = [];
  for (const id of Object.keys(current).sort()) {
    const before = previous[id];
    if (!before) lines.push(renderDeskEntry("added", current[id]));
    else if (!sameValue(before, current[id])) lines.push(renderDeskEntry("updated", current[id]));
  }
  for (const id of Object.keys(previous).sort()) {
    if (!current[id]) lines.push(`  <removed id="${xmlAttribute(id)}" />`);
  }
  return lines.join("\n");
}

function deskDeltaExceedsBudget(
  previous: Readonly<Record<string, DeskManifestEntry>>,
  current: Readonly<Record<string, DeskManifestEntry>>,
  revision: string,
  fromRevision: string,
): boolean {
  const delta = renderDeskDelta(previous, current);
  const section = renderStructuredElement(
    "desk",
    `revision="${xmlAttribute(revision)}" state="delta" from_revision="${xmlAttribute(fromRevision)}"`,
    delta,
  );
  return section.length > MAX_DESK_FULL_CONTEXT_CHARS;
}

/** full：首帧/unknown/超预算 delta；unchanged：revision+manifest 未变；delta：可预算的增量 */
function deskSectionMode(
  input: CurrentContextFrameInput,
  ledger: PersistedContextLedger,
  deskManifest: Readonly<Record<string, DeskManifestEntry>>,
): "full" | "unchanged" | "delta" {
  if (!ledger.lastDeskRevision) return "full";
  if (
    ledger.lastDeskRevision === input.desk.revision
    && sameValue(ledger.lastDeskManifest, deskManifest)
  ) {
    return "unchanged";
  }
  if (
    input.desk.revision === "unknown"
    || ledger.lastDeskRevision === "unknown"
    || deskDeltaExceedsBudget(
      ledger.lastDeskManifest,
      deskManifest,
      input.desk.revision,
      ledger.lastDeskRevision,
    )
  ) {
    return "full";
  }
  return "delta";
}

function renderMemoryEntry(kind: "added" | "updated", entry: MemoryFrameEntry): string {
  const attributes = [
    `key="${xmlAttribute(entry.stableKey)}"`,
    `family="${xmlAttribute(entry.family)}"`,
    `summary="${xmlAttribute(entry.summary)}"`,
  ].join(" ");
  const body = normalizedText(entry.body);
  return body
    ? `  <${kind} ${attributes}>${xmlText(body)}</${kind}>`
    : `  <${kind} ${attributes} />`;
}

function renderJobDelta(
  previous: Readonly<Record<string, JobFrameEntry>>,
  current: Readonly<Record<string, JobFrameEntry>>,
): string {
  const lines: string[] = [];
  for (const id of Object.keys(current).sort()) {
    const before = previous[id];
    if (!before) {
      lines.push(`  <added id="${xmlAttribute(id)}" value="${xmlAttribute(canonicalJson(current[id]))}" />`);
    } else if (!sameValue(before, current[id])) {
      lines.push(`  <updated id="${xmlAttribute(id)}" value="${xmlAttribute(canonicalJson(current[id]))}" />`);
    }
  }
  for (const id of Object.keys(previous).sort()) {
    if (!current[id]) lines.push(`  <removed id="${xmlAttribute(id)}" />`);
  }
  return lines.join("\n");
}

function renderMemoryDelta(
  previous: Readonly<Record<string, MemoryFrameEntry>>,
  current: Readonly<Record<string, MemoryFrameEntry>>,
): string {
  const lines: string[] = [];
  for (const key of Object.keys(current).sort()) {
    const before = previous[key];
    if (!before) lines.push(renderMemoryEntry("added", current[key]));
    else if (!sameValue(before, current[key])) lines.push(renderMemoryEntry("updated", current[key]));
  }
  for (const key of Object.keys(previous).sort()) {
    if (!current[key]) lines.push(`  <removed key="${xmlAttribute(key)}" />`);
  }
  return lines.join("\n");
}

function renderFrame(
  input: CurrentContextFrameInput,
  ledger: PersistedContextLedger,
): string {
  const sequence = ledger.nextFrameSeq;
  const deskManifest = sortedRecord(input.desk.manifest);
  const jobEntries = sortedRecord(input.jobs.entries);
  const memoryEntries = sortedRecord(input.memory.entries);
  const memoryRevision = String(input.memory.revision);
  const loadedSkills = Object.entries(input.loadedSkillRevisions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, revision]) => `${id}@${revision}`)
    .join(",");
  const reloadRequired = Object.entries(input.loadedSkillRevisions)
    .filter(([id, revision]) => input.emittedSkillRevisions[id] !== revision)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, revision]) => `${id}@${revision}`)
    .join(",");
  const memoryUnchanged = ledger.lastMemoryRevision === memoryRevision
    && sameValue(ledger.lastMemoryEntries, memoryEntries);
  const jobsUnchanged = ledger.lastJobsRevision === input.jobs.revision
    && sameValue(ledger.lastJobsEntries, jobEntries);
  const deskMode = deskSectionMode(input, ledger, deskManifest);

  const lines = [
    `<system_context_frame version="1" current="true" seq="${sequence}" context_epoch="${xmlAttribute(ledger.contextEpoch)}" trajectory_epoch="${ledger.trajectoryEpoch}">`,
    `  <turn source="${input.source}" mode="${input.mode}" authority="${input.authority}" />`,
  ];

  if (deskMode === "full") {
    lines.push(renderTextElement(
      "desk",
      `revision="${xmlAttribute(input.desk.revision)}" state="full"`,
      input.desk.fullText,
    ));
  } else if (deskMode === "unchanged") {
    lines.push(`  <desk revision="${xmlAttribute(input.desk.revision)}" state="unchanged" />`);
  } else {
    lines.push(renderStructuredElement(
      "desk",
      `revision="${xmlAttribute(input.desk.revision)}" state="delta" from_revision="${xmlAttribute(ledger.lastDeskRevision!)}"`,
      renderDeskDelta(ledger.lastDeskManifest, deskManifest),
    ));
  }

  const requestContext = [input.desk.requestText, input.inspectText]
    .map(normalizedText)
    .filter(Boolean)
    .join("\n\n");
  if (requestContext) {
    lines.push(renderTextElement("request_context", 'source="system_assembled"', requestContext));
  }

  if (!ledger.lastJobsRevision) {
    lines.push(renderTextElement(
      "jobs",
      `revision="${xmlAttribute(input.jobs.revision)}" state="full"`,
      input.jobs.fullText,
    ));
  } else if (jobsUnchanged) {
    lines.push(`  <jobs revision="${xmlAttribute(input.jobs.revision)}" state="unchanged" />`);
  } else {
    lines.push(renderStructuredElement(
      "jobs",
      `revision="${xmlAttribute(input.jobs.revision)}" state="delta" from_revision="${xmlAttribute(ledger.lastJobsRevision)}"`,
      renderJobDelta(ledger.lastJobsEntries, jobEntries),
    ));
  }

  if (!ledger.lastMemoryRevision) {
    lines.push(renderTextElement(
      "memory",
      `revision="${xmlAttribute(memoryRevision)}" state="full"`,
      input.memory.fullText,
    ));
  } else if (memoryUnchanged) {
    lines.push(`  <memory revision="${xmlAttribute(memoryRevision)}" state="unchanged" />`);
  } else if (!isMemoryRevision(memoryRevision) || !isMemoryRevision(ledger.lastMemoryRevision)) {
    lines.push(renderTextElement(
      "memory",
      `revision="${xmlAttribute(memoryRevision)}" state="full"`,
      input.memory.fullText,
    ));
  } else {
    const delta = renderMemoryDelta(ledger.lastMemoryEntries, memoryEntries);
    lines.push(renderStructuredElement(
      "memory",
      `revision="${xmlAttribute(memoryRevision)}" state="delta" from_revision="${xmlAttribute(ledger.lastMemoryRevision)}"`,
      delta,
    ));
  }

  const skillAttributes = `loaded="${xmlAttribute(loadedSkills)}" reload_required="${xmlAttribute(reloadRequired)}"`;
  if (input.injectedSkills.length === 0) {
    lines.push(`  <skills ${skillAttributes} />`);
  } else {
    lines.push(`  <skills ${skillAttributes}>`);
    for (const skill of [...input.injectedSkills].sort((left, right) => left.id.localeCompare(right.id))) {
      lines.push(renderTextElement(
        "skill",
        [
          `id="${xmlAttribute(skill.id)}"`,
          `revision="${xmlAttribute(skill.revision)}"`,
          `base_dir="${xmlAttribute(skill.baseDir)}"`,
          'trust="untrusted_domain_recipe"',
        ].join(" "),
        skill.body,
      ));
    }
    lines.push("  </skills>");
  }

  lines.push(
    `  <tools epoch="${input.toolEpoch}" active="${xmlAttribute(input.activeTools.join(","))}" />`,
    `  <execution policy_revision="${xmlAttribute(input.policyRevision)}" />`,
    "</system_context_frame>",
  );
  return lines.join("\n");
}

function willRenderFullDesk(
  input: CurrentContextFrameInput,
  ledger: PersistedContextLedger,
): boolean {
  return deskSectionMode(input, ledger, sortedRecord(input.desk.manifest)) === "full";
}

function nextLedger(
  input: CurrentContextFrameInput,
  ledger: PersistedContextLedger,
): PersistedContextLedger {
  return {
    ...ledger,
    nextFrameSeq: ledger.nextFrameSeq + 1,
    lastDeskRevision: input.desk.revision,
    lastDeskManifest: sortedRecord(input.desk.manifest),
    lastJobsRevision: input.jobs.revision,
    lastJobsEntries: sortedRecord(input.jobs.entries),
    lastMemoryRevision: String(input.memory.revision),
    lastMemoryEntries: sortedRecord(input.memory.entries),
  };
}

export class CurrentContextFrameState {
  private state: PersistedContextLedger;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private readonly resourceStore: Pick<ContextResourceStore, "putText">,
    state: PersistedContextLedger,
  ) {
    this.state = state;
  }

  static async open(options: CurrentContextFrameStateOptions): Promise<CurrentContextFrameState> {
    let stored: Partial<PersistedContextLedger> | undefined;
    try {
      stored = JSON.parse(await readFile(options.filePath, "utf8")) as Partial<PersistedContextLedger>;
    } catch {
      stored = undefined;
    }
    const reusable = stored?.version === LEDGER_VERSION
      && stored.contextEpoch === options.contextEpoch;
    let state: PersistedContextLedger;
    if (reusable && stored) {
      state = {
        version: LEDGER_VERSION,
        contextEpoch: options.contextEpoch,
        trajectoryEpoch: validPositiveInteger(stored.trajectoryEpoch),
        nextFrameSeq: validPositiveInteger(stored.nextFrameSeq),
        lastTrajectoryAnchor: typeof stored.lastTrajectoryAnchor === "string"
          ? stored.lastTrajectoryAnchor
          : undefined,
        lastDeskRevision: typeof stored.lastDeskRevision === "string" ? stored.lastDeskRevision : undefined,
        lastDeskManifest: sortedRecord(stored.lastDeskManifest ?? {}),
        lastJobsRevision: typeof stored.lastJobsRevision === "string" ? stored.lastJobsRevision : undefined,
        lastJobsEntries: sortedRecord(stored.lastJobsEntries ?? {}),
        lastMemoryRevision: typeof stored.lastMemoryRevision === "string" ? stored.lastMemoryRevision : undefined,
        lastMemoryEntries: sortedRecord(stored.lastMemoryEntries ?? {}),
      };
    } else {
      state = {
        version: LEDGER_VERSION,
        contextEpoch: options.contextEpoch,
        trajectoryEpoch: 1,
        nextFrameSeq: 1,
        lastDeskManifest: {},
        lastJobsEntries: {},
        lastMemoryEntries: {},
      };
    }
    return new CurrentContextFrameState(options.filePath, options.resourceStore, state);
  }

  snapshot(): ContextLedgerSnapshot {
    return Object.freeze({
      version: this.state.version,
      contextEpoch: this.state.contextEpoch,
      trajectoryEpoch: this.state.trajectoryEpoch,
      nextFrameSeq: this.state.nextFrameSeq,
      lastTrajectoryAnchor: this.state.lastTrajectoryAnchor,
      lastDeskRevision: this.state.lastDeskRevision,
      lastJobsRevision: this.state.lastJobsRevision,
      lastMemoryRevision: this.state.lastMemoryRevision,
    });
  }

  async prepare(input: CurrentContextFrameInput): Promise<PreparedCurrentContextFrame> {
    let renderInput = input;
    let deskFullBudget: DeskFullContextBudgetMetrics | undefined;
    if (willRenderFullDesk(input, this.state)) {
      const initial = budgetDeskFullContext({
        revision: input.desk.revision,
        fullText: input.desk.fullText,
        manifest: input.desk.manifest,
        priorityArtifactIds: input.desk.priorityArtifactIds,
      });
      let budgeted = initial;
      if (initial.metrics.truncated) {
        let resourceRef: string | undefined;
        try {
          resourceRef = await this.resourceStore.putText("current_context_frame.desk", input.desk.fullText);
        } catch {
          resourceRef = undefined;
        }
        budgeted = budgetDeskFullContext({
          revision: input.desk.revision,
          fullText: input.desk.fullText,
          manifest: input.desk.manifest,
          priorityArtifactIds: input.desk.priorityArtifactIds,
          resourceRef,
        });
      }
      deskFullBudget = budgeted.metrics;
      renderInput = {
        ...input,
        desk: { ...input.desk, fullText: budgeted.text },
      };
    }

    const frameText = renderFrame(renderInput, this.state);
    const source = input.source === "job_event" ? "event" : "interactive";
    const promptText = [
      frameText,
      `<user_request source="${source}">`,
      xmlText(normalizedText(input.userRequest)),
      "</user_request>",
    ].join("\n\n");
    return Object.freeze({
      sequence: this.state.nextFrameSeq,
      trajectoryEpoch: this.state.trajectoryEpoch,
      frameText,
      frameSha256: sha256(frameText),
      promptText,
      ...(deskFullBudget ? { contextBudget: { desk_full: deskFullBudget } } : {}),
      [PREPARED_LEDGER]: nextLedger(input, this.state),
    });
  }

  commit(prepared: PreparedCurrentContextFrame, trajectoryAnchor?: string): void {
    if (prepared.sequence !== this.state.nextFrameSeq) {
      throw new Error(
        `context frame sequence conflict: expected ${this.state.nextFrameSeq}, received ${prepared.sequence}`,
      );
    }
    const next = prepared[PREPARED_LEDGER];
    // prepared 基于旧 epoch 渲染（prepare 后、commit 前发生了 forceResync/compaction）：
    // 只接受 seq 推进，清空全部基线，下一轮必然 full resync，避免旧基线污染新 epoch
    this.state = next.trajectoryEpoch < this.state.trajectoryEpoch
      ? {
          ...next,
          trajectoryEpoch: this.state.trajectoryEpoch,
          lastDeskRevision: undefined,
          lastDeskManifest: {},
          lastJobsRevision: undefined,
          lastJobsEntries: {},
          lastMemoryRevision: undefined,
          lastMemoryEntries: {},
          lastTrajectoryAnchor: trajectoryAnchor,
        }
      : { ...next, lastTrajectoryAnchor: trajectoryAnchor };
    this.schedulePersist();
  }

  /** 无任何基线（全新/刚 resync）直接放行；锚点不一致说明轨迹被压缩或重建过，强制下轮 full */
  validateTrajectory(trajectoryAnchor: string): boolean {
    const hasBaseline = Boolean(
      this.state.lastDeskRevision
      || this.state.lastJobsRevision
      || this.state.lastMemoryRevision,
    );
    if (!hasBaseline) return true;
    if (this.state.lastTrajectoryAnchor === trajectoryAnchor) return true;
    this.forceResync();
    return false;
  }

  forceResync(): void {
    this.state = {
      ...this.state,
      trajectoryEpoch: this.state.trajectoryEpoch + 1,
      lastDeskRevision: undefined,
      lastDeskManifest: {},
      lastJobsRevision: undefined,
      lastJobsEntries: {},
      lastMemoryRevision: undefined,
      lastMemoryEntries: {},
      lastTrajectoryAnchor: undefined,
    };
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private schedulePersist(): void {
    const snapshot = JSON.stringify(this.state, null, 2) + "\n";
    this.writeChain = this.writeChain.then(
      () => this.writeSnapshot(snapshot),
      () => this.writeSnapshot(snapshot),
    );
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
