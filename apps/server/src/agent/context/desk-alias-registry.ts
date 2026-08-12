/**
 * 项目级稳定别名（A01、A02…）：artifact 首次进入项目时分配，之后跨线程、
 * 跨 session、桌面重排均不变号。desk delta 与历史轨迹引用同一别名，
 * 避免重编号污染缓存前缀；「A03」同时是人对模型可读的空间指代。
 * 按项目持久化（desk-aliases.json），临时文件 + rename 原子写。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const ALIAS_STATE_VERSION = 1 as const;

type PersistedAliasState = {
  version: typeof ALIAS_STATE_VERSION;
  nextSequence: number;
  aliases: Record<string, string>;
};

function aliasNumber(alias: string): number | undefined {
  const match = /^A(\d{2,})$/.exec(alias);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 读盘清洗：非法格式或撞名的别名直接丢弃——宁可重新分配，也不带冲突状态运行 */
function sanitizeAliases(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  const used = new Set<string>();
  for (const id of Object.keys(value as Record<string, unknown>).sort()) {
    const alias = (value as Record<string, unknown>)[id];
    if (typeof alias !== "string" || aliasNumber(alias) === undefined || used.has(alias)) continue;
    result[id] = alias;
    used.add(alias);
  }
  return result;
}

export class DeskAliasRegistry {
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private state: PersistedAliasState,
  ) {}

  static async open(filePath: string): Promise<DeskAliasRegistry> {
    let stored: Partial<PersistedAliasState> | undefined;
    try {
      stored = JSON.parse(await readFile(filePath, "utf8")) as Partial<PersistedAliasState>;
    } catch {
      stored = undefined;
    }
    const aliases = stored?.version === ALIAS_STATE_VERSION
      ? sanitizeAliases(stored.aliases)
      : {};
    const highest = Math.max(0, ...Object.values(aliases).map((alias) => aliasNumber(alias) ?? 0));
    const storedNext = Number.isSafeInteger(stored?.nextSequence) && Number(stored?.nextSequence) > highest
      ? Number(stored?.nextSequence)
      : highest + 1;
    return new DeskAliasRegistry(filePath, {
      version: ALIAS_STATE_VERSION,
      nextSequence: storedNext,
      aliases,
    });
  }

  assign(artifactIds: readonly string[]): Record<string, string> {
    let changed = false;
    const result: Record<string, string> = {};
    for (const id of [...new Set(artifactIds.filter(Boolean))]) {
      let alias = this.state.aliases[id];
      if (!alias) {
        alias = `A${String(this.state.nextSequence).padStart(2, "0")}`;
        this.state.aliases[id] = alias;
        this.state.nextSequence += 1;
        changed = true;
      }
      result[id] = alias;
    }
    if (changed) this.schedulePersist();
    return result;
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
