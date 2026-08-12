import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STATE_VERSION = 1 as const;

type PersistedSkillState = {
  version: typeof STATE_VERSION;
  catalogRevision: string;
  trajectoryEpoch: number;
  loadedRevisions: Record<string, string>;
  emittedRevisions: Record<string, string>;
};

export type SessionSkillStateSnapshot = Readonly<{
  version: typeof STATE_VERSION;
  catalogRevision: string;
  trajectoryEpoch: number;
  loadedRevisions: Readonly<Record<string, string>>;
  emittedRevisions: Readonly<Record<string, string>>;
}>;

export type SessionSkillStateOptions = {
  filePath: string;
  catalogRevision: string;
};

function sortedStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([left], [right]) => left.localeCompare(right)));
}

function positiveInteger(value: unknown): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : 1;
}

export class SessionSkillState {
  private state: PersistedSkillState;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    state: PersistedSkillState,
  ) {
    this.state = state;
  }

  static async open(options: SessionSkillStateOptions): Promise<SessionSkillState> {
    let stored: Partial<PersistedSkillState> | undefined;
    try {
      stored = JSON.parse(await readFile(options.filePath, "utf8")) as Partial<PersistedSkillState>;
    } catch {
      stored = undefined;
    }
    const validVersion = stored?.version === STATE_VERSION;
    const sameCatalog = validVersion && stored?.catalogRevision === options.catalogRevision;
    const previousEpoch = positiveInteger(stored?.trajectoryEpoch);
    const state: PersistedSkillState = {
      version: STATE_VERSION,
      catalogRevision: options.catalogRevision,
      trajectoryEpoch: sameCatalog ? previousEpoch : (validVersion ? previousEpoch + 1 : 1),
      loadedRevisions: sameCatalog ? sortedStringRecord(stored?.loadedRevisions) : {},
      emittedRevisions: sameCatalog ? sortedStringRecord(stored?.emittedRevisions) : {},
    };
    const instance = new SessionSkillState(options.filePath, state);
    if (validVersion && !sameCatalog) instance.schedulePersist();
    return instance;
  }

  snapshot(): SessionSkillStateSnapshot {
    return Object.freeze({
      ...this.state,
      loadedRevisions: Object.freeze({ ...this.state.loadedRevisions }),
      emittedRevisions: Object.freeze({ ...this.state.emittedRevisions }),
    });
  }

  recordLoad(skillId: string, revision: string): { emit: boolean } {
    const emit = this.state.emittedRevisions[skillId] !== revision;
    const loadedChanged = this.state.loadedRevisions[skillId] !== revision;
    if (!emit && !loadedChanged) return { emit: false };
    this.state.loadedRevisions = sortedStringRecord({
      ...this.state.loadedRevisions,
      [skillId]: revision,
    });
    if (emit) {
      this.state.emittedRevisions = sortedStringRecord({
        ...this.state.emittedRevisions,
        [skillId]: revision,
      });
    }
    this.schedulePersist();
    return { emit };
  }

  forceResync(): void {
    this.state = {
      ...this.state,
      trajectoryEpoch: this.state.trajectoryEpoch + 1,
      emittedRevisions: {},
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
