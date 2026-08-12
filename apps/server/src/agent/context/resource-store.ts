/**
 * 工具长结果的外挂仓库：超长文本不进入对话轨迹，落盘为内容寻址资源
 *（ctxres:sha256:<hash>），轨迹中只保留摘要与引用；模型需要细节时经
 * read_context_resource 按 cursor 分页读取（每页 MAX_CONTEXT_RESOURCE_PAGE_CHARS）。
 * 内容寻址即自校验：读回时重算 hash 比对，防串文件、防半截写入。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../cache-contract.js";

const RESOURCE_VERSION = 1 as const;
const RESOURCE_REF_RE = /^ctxres:sha256:([0-9a-f]{64})$/;
export const MAX_CONTEXT_RESOURCE_PAGE_CHARS = 6_000;

type StoredTextResource = {
  version: typeof RESOURCE_VERSION;
  toolName: string;
  text: string;
};

export type ContextResourcePage = {
  ok: true;
  toolName: string;
  text: string;
  cursor: string;
  nextCursor?: string;
  totalChars: number;
} | {
  ok: false;
  reason: "invalid_ref" | "not_found" | "invalid_resource" | "invalid_cursor";
};

function resourcePayload(toolName: string, text: string): StoredTextResource {
  return { version: RESOURCE_VERSION, toolName, text };
}

function resourceHash(resource: StoredTextResource): string {
  return sha256(resource);
}

export class ContextResourceStore {
  constructor(private readonly root: string) {}

  async putText(toolName: string, text: string): Promise<string> {
    const resource = resourcePayload(toolName, text);
    const hash = resourceHash(resource);
    const filePath = join(this.root, `${hash}.json`);
    await mkdir(this.root, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(resource), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
    return `ctxres:sha256:${hash}`;
  }

  async readText(
    resourceRef: string,
    options: { cursor?: string; maxChars?: number } = {},
  ): Promise<ContextResourcePage> {
    const match = resourceRef.match(RESOURCE_REF_RE);
    if (!match) return { ok: false, reason: "invalid_ref" };
    let resource: StoredTextResource;
    try {
      resource = JSON.parse(await readFile(join(this.root, `${match[1]}.json`), "utf8")) as StoredTextResource;
    } catch {
      return { ok: false, reason: "not_found" };
    }
    // 模型传来的 ref 是不可信输入：版本、结构与内容 hash 全部重验，失败即拒绝
    if (
      resource?.version !== RESOURCE_VERSION
      || typeof resource.toolName !== "string"
      || typeof resource.text !== "string"
      || resourceHash(resource) !== match[1]
    ) {
      return { ok: false, reason: "invalid_resource" };
    }
    const cursorText = options.cursor ?? "0";
    if (!/^\d+$/.test(cursorText)) return { ok: false, reason: "invalid_cursor" };
    const cursor = Number(cursorText);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > resource.text.length) {
      return { ok: false, reason: "invalid_cursor" };
    }
    const requested = Number.isFinite(options.maxChars) ? Math.floor(options.maxChars!) : MAX_CONTEXT_RESOURCE_PAGE_CHARS;
    const maxChars = Math.min(MAX_CONTEXT_RESOURCE_PAGE_CHARS, Math.max(1, requested));
    const end = Math.min(resource.text.length, cursor + maxChars);
    return {
      ok: true,
      toolName: resource.toolName,
      text: resource.text.slice(cursor, end),
      cursor: String(cursor),
      ...(end < resource.text.length ? { nextCursor: String(end) } : {}),
      totalChars: resource.text.length,
    };
  }
}
