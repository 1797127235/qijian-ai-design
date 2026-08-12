import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { projectMemories, projects } from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";
import type { GenerationMemorySnapshot } from "../../tasks/types.js";
import {
  emptyMemory,
  isMemoryFamily,
  removeEntry,
  searchEntries,
  upsertEntry,
  type MemoryEntry,
  type MemoryState,
  type MemoryWriteInput,
} from "./domain.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

function emptyContext(revision: number): string {
  return `[PROJECT_MEMORY revision=${revision}]\n（空）`;
}

function mapRow(projectId: string, row: {
  revision: number;
  entries: unknown;
  compiledContext: string;
} | undefined): MemoryState {
  if (!row) return emptyMemory(projectId);
  const raw = (row.entries ?? {}) as Record<string, unknown>;
  const entries: Record<string, MemoryEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    if (!isMemoryFamily(item.family)) continue;
    const summary = String(item.summary ?? "").trim();
    if (!summary) continue;
    entries[key] = {
      stableKey: String(item.stableKey ?? key),
      family: item.family,
      summary,
      body: String(item.body ?? summary),
      updatedAt: String(item.updatedAt ?? ""),
    };
  }
  return {
    projectId,
    revision: row.revision,
    entries,
    compiledContext: row.compiledContext || "",
  };
}

export class ProjectMemoryService {
  constructor(private readonly db: Database) {}

  async get(projectId: string): Promise<MemoryState> {
    const [row] = await this.db.select().from(projectMemories).where(eq(projectMemories.projectId, projectId));
    return mapRow(projectId, row);
  }

  async write(projectId: string, input: MemoryWriteInput): Promise<MemoryState> {
    return this.db.transaction(async (tx) => {
      const current = await this.loadLocked(tx, projectId);
      const next = upsertEntry(current, input, new Date());
      if (next.revision === current.revision) return next;
      await this.persist(tx, projectId, next);
      return next;
    });
  }

  async forget(projectId: string, stableKey: string): Promise<{ state: MemoryState; forgotten: boolean }> {
    return this.db.transaction(async (tx) => {
      const current = await this.loadLocked(tx, projectId);
      const next = removeEntry(current, stableKey);
      if (next.revision === current.revision) return { state: next, forgotten: false };
      await this.persist(tx, projectId, next);
      return { state: next, forgotten: true };
    });
  }

  async search(projectId: string, query: string, limit = 10): Promise<MemoryEntry[]> {
    return searchEntries(await this.get(projectId), query, limit);
  }

  async forPrompt(projectId: string): Promise<{ revision: number; compiledContext: string }> {
    const state = await this.get(projectId);
    return {
      revision: state.revision,
      compiledContext: state.compiledContext || emptyContext(state.revision),
    };
  }

  async freezeForGeneration(projectId: string): Promise<GenerationMemorySnapshot> {
    const state = await this.get(projectId);
    return {
      checkpoint_revision: state.revision,
      stable_keys: Object.keys(state.entries).sort(),
      compiled_design_context: state.compiledContext || emptyContext(state.revision),
    };
  }

  private async loadLocked(tx: Tx, projectId: string): Promise<MemoryState> {
    const [project] = await tx.select({ id: projects.id }).from(projects)
      .where(eq(projects.id, projectId)).for("update");
    if (!project) throw new HttpError(404, "项目不存在");
    const [row] = await tx.select().from(projectMemories).where(eq(projectMemories.projectId, projectId));
    return mapRow(projectId, row);
  }

  private async persist(tx: Tx, projectId: string, next: MemoryState): Promise<void> {
    await tx.insert(projectMemories).values({
      projectId,
      revision: next.revision,
      entries: next.entries,
      compiledContext: next.compiledContext,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: projectMemories.projectId,
      set: {
        revision: next.revision,
        entries: next.entries,
        compiledContext: next.compiledContext,
        updatedAt: new Date(),
      },
    });
  }
}
