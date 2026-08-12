import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, type Database } from "../db/client.js";
import { chatRuns } from "../db/schema.js";
import { DeskStateService } from "./desk-state-service.js";
import { ChatService } from "./chat-service.js";

const DATABASE_URL = process.env.QIJIAN_TEST_DATABASE_URL
  ?? "postgresql://qijian:qijian@localhost:5433/qijian";

let db: Database | undefined;
let pool: { end: () => Promise<void> } | undefined;
let available = false;
try {
  const created = createDatabase({ databaseUrl: DATABASE_URL });
  await created.db.select({ id: chatRuns.id }).from(chatRuns).limit(1);
  db = created.db;
  pool = created.pool;
  available = true;
} catch {
  console.warn("[integration] chat database unavailable — skipping");
}

afterAll(async () => pool?.end());
const itDb = (...args: Parameters<typeof it>) => (available ? it(...args) : it.skip(...args));

describe("ChatService stale run watchdog", () => {
  itDb("interrupts stale runs globally without waiting for chat history access", async () => {
    const desks = new DeskStateService(db!);
    const project = await desks.createProject("stale-run-watchdog");
    const chats = new ChatService(db!);
    try {
      const thread = await chats.createThread(project.id);
      const saved = await chats.appendPrompt(project.id, thread.id, "long running task");
      await db!.update(chatRuns)
        .set({ startedAt: new Date("2026-08-01T00:00:00.000Z") })
        .where(eq(chatRuns.id, saved.run!.id));

      const interrupted = await chats.interruptStaleRunsGlobal(
        10 * 60 * 1_000,
        new Date("2026-08-01T01:00:00.000Z"),
      );

      expect(interrupted).toBe(1);
      const [run] = await db!.select().from(chatRuns).where(eq(chatRuns.id, saved.run!.id));
      expect(run.status).toBe("interrupted");
      expect(run.finishedAt).not.toBeNull();
    } finally {
      await desks.deleteProject(project.id);
    }
  });
});
