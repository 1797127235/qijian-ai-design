/**
 * 扫描内置 skill 根（本包目录）下各子目录的 SKILL.md frontmatter（L1 元数据）。
 * 忽略 allowed-tools / scripts；不执行任何脚本。
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { SKILL_ID_RE, skillsRoot } from "./paths.js";

export type SkillMeta = {
  id: string;
  name: string;
  /** 列表展示用：优先正文一级标题，否则 name */
  title: string;
  description: string;
  /** composer 列表副文案；缺省时从 description 截短 */
  summary: string;
  /** 完整 SKILL.md 内容哈希；同内容得到同 revision。 */
  revision: string;
  /** Skill 引用相对资源时使用的可信根目录。 */
  baseDir: string;
};

type SkillCatalogEntry = SkillMeta & {
  bodyPath: string;
  body: string;
};

type SkillCatalogSnapshot = {
  revision: string;
  entries: readonly SkillCatalogEntry[];
};

const snapshots = new Map<string, SkillCatalogSnapshot>();

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseFrontmatter(raw: string): {
  name?: string;
  description?: string;
  summary?: string;
  body: string;
} {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { body: raw };
  const yaml = m[1] ?? "";
  const body = m[2] ?? "";
  let name: string | undefined;
  let description: string | undefined;
  let summary: string | undefined;
  for (const line of yaml.split(/\r?\n/)) {
    const nm = line.match(/^name:\s*(.+)\s*$/);
    if (nm) name = stripQuotes(nm[1]!.trim());
    const dm = line.match(/^description:\s*(.+)\s*$/);
    if (dm) description = stripQuotes(dm[1]!.trim());
    const sm = line.match(/^summary:\s*(.+)\s*$/);
    if (sm) summary = stripQuotes(sm[1]!.trim());
  }
  return { name, description, summary, body };
}

function shortSummary(summary: string | undefined, description: string): string {
  if (summary?.trim()) return summary.trim();
  const one = description.split(/[。.!！？\n]/)[0]?.trim() ?? description;
  return one.length > 48 ? `${one.slice(0, 48)}…` : one;
}

function titleFromBody(body: string, fallback: string): string {
  const m = body.match(/^#\s+(.+)$/m);
  const t = m?.[1]?.trim();
  return t || fallback;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function contentRevision(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function catalogSnapshot(env: NodeJS.ProcessEnv = process.env): SkillCatalogSnapshot {
  const root = skillsRoot(env);
  const cached = snapshots.get(root);
  if (cached) return cached;
  if (!existsSync(root)) return { revision: contentRevision("[]"), entries: [] };

  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((id) => SKILL_ID_RE.test(id))
      .sort();
  } catch {
    return { revision: contentRevision("[]"), entries: [] };
  }

  const entries: SkillCatalogEntry[] = [];
  for (const id of dirs) {
    const bodyPath = join(root, id, "SKILL.md");
    if (!existsSync(bodyPath)) continue;
    let raw: string;
    try {
      raw = readFileSync(bodyPath, "utf8");
    } catch {
      continue;
    }
    const { name, description, summary, body } = parseFrontmatter(raw);
    if (!name || !description || name !== id || description.length > 1024) continue;
    entries.push({
      id,
      name,
      title: titleFromBody(body, name),
      description,
      summary: shortSummary(summary, description),
      revision: contentRevision(raw),
      baseDir: dirname(bodyPath),
      bodyPath,
      body,
    });
  }
  const snapshot = {
    revision: contentRevision(JSON.stringify(entries.map(({ id, revision }) => ({ id, revision })))),
    entries: Object.freeze(entries),
  };
  snapshots.set(root, snapshot);
  return snapshot;
}

export function listSkillMeta(env: NodeJS.ProcessEnv = process.env): SkillMeta[] {
  return catalogSnapshot(env).entries.map(({ body: _body, bodyPath: _bodyPath, ...meta }) => meta);
}

export function skillCatalogRevision(env: NodeJS.ProcessEnv = process.env): string {
  return catalogSnapshot(env).revision;
}

export function searchSkillMeta(query: string, env: NodeJS.ProcessEnv = process.env): SkillMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return listSkillMeta(env);
  const tokens = q.split(/[\s,，、;；]+/).map((t) => t.trim()).filter(Boolean);
  const all = listSkillMeta(env);
  const scored: Array<{ meta: SkillMeta; score: number }> = [];
  for (const meta of all) {
    const blob = `${meta.id} ${meta.name} ${meta.description}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (meta.id === t || meta.name === t) score += 10;
      else if (blob.includes(t)) score += 3;
    }
    if (score > 0) scored.push({ meta, score });
  }
  scored.sort((a, b) => b.score - a.score || a.meta.id.localeCompare(b.meta.id));
  return scored.map((s) => s.meta);
}

export function loadSkillBody(
  skillId: string,
  maxChars: number,
  env: NodeJS.ProcessEnv = process.env,
): {
  ok: true;
  id: string;
  name: string;
  description: string;
  revision: string;
  baseDir: string;
  body: string;
  truncated: boolean;
}
  | { ok: false; reason: string } {
  if (!SKILL_ID_RE.test(skillId)) return { ok: false, reason: "invalid_id" };
  const entry = catalogSnapshot(env).entries.find(({ id }) => id === skillId);
  if (!entry) return { ok: false, reason: "not_found" };
  const limit = Math.max(500, maxChars);
  const truncated = entry.body.length > limit;
  return {
    ok: true,
    id: skillId,
    name: entry.name,
    description: entry.description,
    revision: entry.revision,
    baseDir: entry.baseDir,
    body: truncated ? `${entry.body.slice(0, limit)}\n\n…(truncated)` : entry.body,
    truncated,
  };
}
