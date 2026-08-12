/**
 * 内置 skill 根：本模块目录（apps/server/src/agent/skills）。
 * 仅 allowlist 根下，realpath 防穿越。可用 SKILLS_DIR 覆盖。
 */
import { realpathSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 与 paths.ts 同级：内置 skill 包（各子目录/SKILL.md） */
const BUILTIN_SKILLS_ROOT = dirname(fileURLToPath(import.meta.url));

export function skillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SKILLS_DIR?.trim()) return resolve(env.SKILLS_DIR.trim());
  return BUILTIN_SKILLS_ROOT;
}

/** 解析 root 下相对路径；失败返回 null（不存在或越界）。 */
export function resolveUnderRoot(root: string, relativePath: string): string | null {
  if (!relativePath || relativePath.includes("\0")) return null;
  if (relativePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relativePath)) return null;
  const segments = relativePath.split(/[/\\]+/).filter(Boolean);
  if (segments.some((s) => s === ".." || s === ".")) return null;
  const candidate = resolve(join(root, ...segments));
  let rootReal: string;
  try {
    rootReal = existsSync(root) ? realpathSync(root) : root;
  } catch {
    return null;
  }
  let candidateReal: string;
  try {
    if (!existsSync(candidate)) return null;
    candidateReal = realpathSync(candidate);
  } catch {
    return null;
  }
  const prefix = rootReal.endsWith("/") ? rootReal : `${rootReal}/`;
  if (candidateReal !== rootReal && !candidateReal.startsWith(prefix)) return null;
  return candidateReal;
}

export function skillMdPath(skillId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!SKILL_ID_RE.test(skillId)) return null;
  return resolveUnderRoot(skillsRoot(env), `${skillId}/SKILL.md`);
}
