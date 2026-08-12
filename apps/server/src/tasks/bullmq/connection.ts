import type { ConnectionOptions } from "bullmq";

export type BullMqConnectionRole = "producer" | "worker";

export function createBullMqConnectionOptions(
  redisUrl: string,
  role: BullMqConnectionRole = "producer",
): ConnectionOptions {
  const url = redisUrl.trim();
  if (!url) throw new Error("Redis URL is required");
  return {
    url,
    enableReadyCheck: true,
    maxRetriesPerRequest: role === "worker" ? null : 1,
  };
}
