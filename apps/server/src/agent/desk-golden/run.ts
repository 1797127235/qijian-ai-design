/**
 * 黄金任务 runner：读 fixtures → assembleDeskContext → 断言 expect。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { DeskSnapshot } from "../../domain/types.js";
import {
  assembleDeskContext,
  formatInspectBlock,
  type AssembledDeskContext,
} from "../desk-context.js";
import type { GoldenExpect, GoldenTask } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as T;
}

function reviveDesk(raw: Record<string, unknown>): DeskSnapshot {
  const deskState = raw.deskState as DeskSnapshot["deskState"];
  const artifacts = (raw.artifacts as DeskSnapshot["artifacts"]).map((a) => ({
    ...a,
    createdAt: new Date(a.createdAt as unknown as string),
  }));
  return {
    project: raw.project as DeskSnapshot["project"],
    artifacts,
    deskState: {
      ...deskState,
      updatedAt: new Date(deskState.updatedAt as unknown as string),
    },
  };
}

const s1Desk = reviveDesk(readJson("s1.desk.json"));
const s1Files = readJson<Record<string, string>>("s1.files.json");

const emptyDesk: DeskSnapshot = {
  project: { id: "p1", name: "空项目" },
  artifacts: [],
  deskState: {
    objects: [],
    connections: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: new Date("2026-08-06T12:00:00.000Z"),
  },
};

export function loadGoldenTasks(): GoldenTask[] {
  return readdirSync(fixturesDir)
    .filter((f) => /^GT-\d+\.json$/.test(f))
    .sort()
    .map((f) => readJson<GoldenTask>(f));
}

function resolveDesk(task: GoldenTask): DeskSnapshot | null {
  if (task.desk === null) return null;
  if (task.desk === "s1") return s1Desk;
  if (task.desk === "empty") return emptyDesk;
  return reviveDesk(task.desk as Record<string, unknown>);
}

function resolveFileNames(task: GoldenTask): Record<string, string> {
  if (!task.fileNames) return {};
  if (task.fileNames === "s1") return s1Files;
  return task.fileNames;
}

export function runGoldenTask(task: GoldenTask): AssembledDeskContext & { inspectText: string } {
  const snapshot = resolveDesk(task);
  // C1：只把本轮 snapshot 交给装配；historyDeskMentions 故意不传入
  const assembled = assembleDeskContext(snapshot, task.selection ?? [], {
    fileNames: resolveFileNames(task),
    userText: task.userText,
    captions: task.captions,
  });
  // Inspect 文本在 session 层拼；夹具层用 plan + format 复现
  const inspectText = formatInspectBlock(assembled.inspectPlan, 1);
  return { ...assembled, inspectText };
}

function objectLines(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("- A") && l.includes("「"));
}

function labelsFromSurvey(text: string): string[] {
  return objectLines(text).map((l) => {
    const m = l.match(/「([^」]+)」/);
    return m?.[1] ?? l;
  });
}

export function assertGoldenExpect(
  task: GoldenTask,
  result: AssembledDeskContext & { inspectText: string },
) {
  const exp = task.expect;
  const fullText = [result.text, result.inspectText].filter(Boolean).join("\n\n");

  if (exp.textIncludes) {
    for (const s of exp.textIncludes) {
      expect(fullText, `${task.id} missing: ${s}`).toContain(s);
    }
  }
  if (exp.textExcludes) {
    for (const s of exp.textExcludes) {
      expect(fullText, `${task.id} should not contain: ${s}`).not.toContain(s);
    }
  }

  const blockPresent = (name: string) =>
    fullText.includes(`[${name}]`) || (name === "DESK_CONTEXT" && fullText.includes("[DESK_CONTEXT"));

  if (exp.hasBlocks) {
    for (const b of exp.hasBlocks) {
      expect(blockPresent(b), `${task.id} missing block ${b}`).toBe(true);
    }
  }
  if (exp.noBlocks) {
    for (const b of exp.noBlocks) {
      if (b === "DESK_CONTEXT") continue; // 几乎总有
      expect(blockPresent(b), `${task.id} unexpected block ${b}`).toBe(false);
    }
  }

  // H1：每条 L-A 装配结果必须带 current=true（桌面合同，非 || true 旁路）
  expect(fullText).toContain("current=true");
  if (exp.codes?.includes("H2")) {
    expect(fullText).toMatch(/revision=\S+/);
    expect(fullText).not.toContain("revision=unknown");
  }

  if (exp.labelsUnique || exp.codes?.includes("S3")) {
    const labels = labelsFromSurvey(result.text);
    expect(new Set(labels).size, `${task.id} labels not unique: ${labels.join(",")}`).toBe(labels.length);
  }

  if (exp.inspectIncluded) {
    const ids = result.inspectPlan.included.map((i) => i.artifactId);
    for (const id of exp.inspectIncluded) {
      expect(ids, `${task.id} inspect missing ${id}`).toContain(id);
    }
  }
  if (exp.inspectExcluded) {
    const ids = result.inspectPlan.included.map((i) => i.artifactId);
    for (const id of exp.inspectExcluded) {
      expect(ids, `${task.id} inspect should exclude ${id}`).not.toContain(id);
    }
  }
  if (exp.inspectSkipped) {
    for (const sk of exp.inspectSkipped) {
      expect(
        result.inspectPlan.skipped.some((s) => s.artifactId === sk.artifactId && s.reason === sk.reason),
        `${task.id} skip ${sk.artifactId}/${sk.reason}`,
      ).toBe(true);
    }
  }

  if (exp.reportDroppedIncludes) {
    for (const d of exp.reportDroppedIncludes) {
      expect(
        result.report.dropped,
        `${task.id} report.dropped missing ${d}: ${result.report.dropped.join(",")}`,
      ).toContain(d);
    }
  }
  if (exp.reportModesIncludes) {
    for (const m of exp.reportModesIncludes) {
      expect(result.report.modes, `${task.id} report.modes missing ${m}`).toContain(m);
    }
  }

  if (exp.resolution) {
    expect(result.resolution, `${task.id} expected resolution`).toBeTruthy();
    if (exp.resolution.unique !== undefined) {
      expect(result.resolution!.unique).toBe(exp.resolution.unique);
    }
    if (exp.resolution.resolvedIds) {
      expect(result.resolution!.resolvedIds.sort()).toEqual([...exp.resolution.resolvedIds].sort());
    }
    if (exp.resolution.candidateIds) {
      const cids = result.resolution!.candidates.map((c) => c.id).sort();
      for (const id of exp.resolution.candidateIds) {
        expect(cids).toContain(id);
      }
    }
  }

  if (exp.focusMentions) {
    expect(result.text).toContain("[FOCUS]");
    for (const id of exp.focusMentions) {
      expect(result.text).toContain(id);
    }
  }

  // C1：历史提及 id 不得出现在本轮 Survey 物件目录 / 编号表
  if (exp.codes?.includes("C1") || (task.historyDeskMentions?.length ?? 0) > 0) {
    const ghosts = task.historyDeskMentions ?? [];
    const surveyOnly = result.text.split("\n\n")[0] ?? result.text;
    for (const id of ghosts) {
      expect(surveyOnly, `${task.id} C1: survey must not contain historical id ${id}`).not.toContain(id);
      expect(
        result.objects.some((o) => o.id === id),
        `${task.id} C1: objects must not include historical id ${id}`,
      ).toBe(false);
    }
    expect(fullText).toContain("current=true");
  }
}

export type { GoldenExpect, GoldenTask };
