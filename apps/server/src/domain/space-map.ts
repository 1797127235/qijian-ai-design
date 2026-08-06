/** 空间地图 payload 解析：统一 spaces / regions 与关键空间判定。 */

export interface ParsedSpace {
  id: string;
  key: boolean;
  raw: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function parseSpaces(payload: Record<string, unknown> | undefined | null): ParsedSpace[] {
  if (!payload) return [];
  const list = Array.isArray(payload.spaces)
    ? payload.spaces
    : Array.isArray(payload.regions) ? payload.regions : [];
  return list.flatMap((item) => {
    const raw = asRecord(item);
    if (!raw) return [];
    const id = raw.id ?? raw.space_id;
    if (typeof id !== "string" || !id) return [];
    return [{
      id,
      key: raw.key === true || raw.is_key_space === true,
      raw,
    }];
  });
}

export function findSpace(payload: Record<string, unknown> | undefined | null, spaceId: string): ParsedSpace | undefined {
  return parseSpaces(payload).find((space) => space.id === spaceId);
}

export function findKeySpace(payload: Record<string, unknown> | undefined | null, spaceId: string): ParsedSpace | undefined {
  const space = findSpace(payload, spaceId);
  return space?.key ? space : undefined;
}
