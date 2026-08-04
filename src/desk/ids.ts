let sequence = 0;

export function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(sequence++).toString(36)}`;
}
