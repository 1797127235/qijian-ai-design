import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STATE_VERSION = 1 as const;
export const DEFAULT_TOOL_WORKING_SET_CAPACITY = 5;

type PersistedToolState = {
  version: typeof STATE_VERSION;
  registryRevision: string;
  toolEpoch: number;
  workingSet: string[];
  lastActiveTools: string[];
};

export type SessionToolStateSnapshot = Readonly<{
  version: typeof STATE_VERSION;
  registryRevision: string;
  toolEpoch: number;
  workingSet: readonly string[];
  lastActiveTools: readonly string[];
}>;

export type SessionToolStateOptions = {
  filePath: string;
  registryNames: string[];
  registryRevision: string;
  kernelNames: string[];
  capacity?: number;
};

function uniqueKnown(names: unknown, known: Set<string>): string[] {
  if (!Array.isArray(names)) return [];
  const result: string[] = [];
  for (const value of names) {
    if (typeof value !== "string" || !known.has(value) || result.includes(value)) continue;
    result.push(value);
  }
  return result;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export function orderAdditiveTools(
  current: readonly string[],
  additions: readonly string[],
  registryNames: readonly string[],
): string[] {
  const result = [...new Set(current)];
  const requested = new Set(additions);
  for (const name of registryNames) {
    if (requested.has(name) && !result.includes(name)) result.push(name);
  }
  return result;
}

export class SessionToolState {
  private readonly filePath: string;
  private readonly registryNames: string[];
  private readonly registrySet: Set<string>;
  private readonly kernelNames: string[];
  private readonly kernelSet: Set<string>;
  private readonly capacity: number;
  private state: PersistedToolState;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(options: SessionToolStateOptions, state: PersistedToolState) {
    this.filePath = options.filePath;
    this.registryNames = [...options.registryNames];
    this.registrySet = new Set(options.registryNames);
    this.kernelNames = [...options.kernelNames];
    this.kernelSet = new Set(options.kernelNames);
    this.capacity = options.capacity ?? DEFAULT_TOOL_WORKING_SET_CAPACITY;
    this.state = state;
  }

  static async open(options: SessionToolStateOptions): Promise<SessionToolState> {
    const registrySet = new Set(options.registryNames);
    const kernelSet = new Set(options.kernelNames);
    const capacity = options.capacity ?? DEFAULT_TOOL_WORKING_SET_CAPACITY;
    let stored: Partial<PersistedToolState> | undefined;
    try {
      stored = JSON.parse(await readFile(options.filePath, "utf8")) as Partial<PersistedToolState>;
    } catch {
      stored = undefined;
    }

    const validVersion = stored?.version === STATE_VERSION;
    const storedEpoch = Number.isInteger(stored?.toolEpoch) && Number(stored?.toolEpoch) > 0
      ? Number(stored?.toolEpoch)
      : 1;
    const sameRegistry = validVersion && stored?.registryRevision === options.registryRevision;
    const workingSet = sameRegistry
      ? uniqueKnown(stored?.workingSet, registrySet)
        .filter((name) => !kernelSet.has(name))
        .slice(-capacity)
      : [];
    const lastActiveTools = sameRegistry
      ? uniqueKnown(stored?.lastActiveTools, registrySet)
      : [];
    const state: PersistedToolState = {
      version: STATE_VERSION,
      registryRevision: options.registryRevision,
      toolEpoch: sameRegistry ? storedEpoch : (validVersion ? storedEpoch + 1 : 1),
      workingSet,
      lastActiveTools,
    };
    const instance = new SessionToolState(options, state);
    if (!sameRegistry && validVersion) instance.schedulePersist();
    return instance;
  }

  snapshot(): SessionToolStateSnapshot {
    return Object.freeze({
      ...this.state,
      workingSet: Object.freeze([...this.state.workingSet]),
      lastActiveTools: Object.freeze([...this.state.lastActiveTools]),
    });
  }

  desiredActiveTools(): string[] {
    const working = new Set(this.state.workingSet);
    return [
      ...this.kernelNames,
      ...this.registryNames.filter((name) => working.has(name) && !this.kernelSet.has(name)),
    ];
  }

  orderAdditions(current: readonly string[], additions: readonly string[]): string[] {
    return orderAdditiveTools(current, additions, this.registryNames);
  }

  needsBoundary(currentActive: readonly string[]): boolean {
    return !sameNames(currentActive, this.desiredActiveTools());
  }

  recordUse(toolName: string): void {
    this.touchWorkingSet([toolName]);
  }

  recordDiscovery(toolNames: readonly string[]): void {
    const discovered = new Set(toolNames);
    this.touchWorkingSet(this.registryNames.filter((name) => discovered.has(name)));
  }

  recordActiveSet(activeNames: readonly string[]): void {
    const next = uniqueKnown(activeNames, this.registrySet);
    if (sameNames(next, this.state.lastActiveTools)) return;
    this.state.lastActiveTools = next;
    this.schedulePersist();
  }

  recordBoundary(previousActive: readonly string[], nextActive: readonly string[]): void {
    const next = uniqueKnown(nextActive, this.registrySet);
    if (previousActive.length > 0 && !sameNames(previousActive, next)) {
      this.state.toolEpoch += 1;
    }
    this.state.lastActiveTools = next;
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

  private touchWorkingSet(toolNames: readonly string[]): void {
    let next = this.state.workingSet;
    let changed = false;
    for (const toolName of toolNames) {
      if (!this.registrySet.has(toolName) || this.kernelSet.has(toolName)) continue;
      next = next.filter((name) => name !== toolName);
      next.push(toolName);
      changed = true;
    }
    if (!changed) return;
    this.state.workingSet = next.slice(-this.capacity);
    this.schedulePersist();
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
