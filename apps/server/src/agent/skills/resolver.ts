import { loadSkillBody } from "./catalog.js";
import type { SessionSkillState } from "./session-skill-state.js";

const EXPLICIT_SKILL_RE = /\$([a-z0-9]+(?:-[a-z0-9]+)*)/g;
const MAX_SKILL_BODY_CHARS = 6_000;

export type InjectedSkill = Readonly<{
  id: string;
  revision: string;
  baseDir: string;
  body: string;
}>;

export type ExplicitSkillResolution = Readonly<{
  requestedIds: readonly string[];
  missingIds: readonly string[];
  injected: readonly InjectedSkill[];
}>;

export function resolveExplicitSkills(
  userText: string,
  state: SessionSkillState,
): ExplicitSkillResolution {
  const requestedIds = [...new Set(
    [...userText.matchAll(EXPLICIT_SKILL_RE)].map((match) => match[1]!),
  )];
  const missingIds: string[] = [];
  const injected: InjectedSkill[] = [];
  for (const skillId of requestedIds) {
    const loaded = loadSkillBody(skillId, MAX_SKILL_BODY_CHARS);
    if (!loaded.ok) {
      missingIds.push(skillId);
      continue;
    }
    if (!state.recordLoad(loaded.id, loaded.revision).emit) continue;
    injected.push(Object.freeze({
      id: loaded.id,
      revision: loaded.revision,
      baseDir: loaded.baseDir,
      body: loaded.body,
    }));
  }
  return Object.freeze({
    requestedIds: Object.freeze(requestedIds),
    missingIds: Object.freeze(missingIds),
    injected: Object.freeze(injected),
  });
}
