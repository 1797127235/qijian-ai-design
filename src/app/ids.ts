let seq = 0;
export const nextId = () => `m-${Date.now().toString(36)}-${(seq++).toString(36)}`;
