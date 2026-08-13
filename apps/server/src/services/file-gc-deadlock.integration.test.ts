/**
 * 复现 2026-08-13：11 路 gcUnattached 打满小连接池，写路径借不到连接。
 * 对照 FileGcScheduler：同一项目只进一轮，探活/建项目仍通。
 */
import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { storedFiles } from "../db/schema.js";
import { DeskStateService } from "./desk-state-service.js";
import { FileGcScheduler } from "./file-gc-scheduler.js";
import { FileStorage } from "./file-storage.js";

const DATABASE_URL = process.env.QIJIAN_TEST_DATABASE_URL ?? "postgresql://qijian:qijian@localhost:5433/qijian";
const POOL_MAX = 3;
const CARD_COUNT = 11;
const HOLD_MS = 1_500;
const PROBE_MS = 400;

const pool = new Pool({ connectionString: DATABASE_URL, max: POOL_MAX });
const db = drizzle(pool, { schema });
let available = false;
try {
  await db.select({ id: storedFiles.id }).from(storedFiles).limit(1);
  available = true;
} catch {
  console.warn("[integration] postgres unavailable at", DATABASE_URL, "— skipping deadlock repro");
}

const desks = new DeskStateService(db);
const itDb = (...args: Parameters<typeof it>) => (available ? it(...args) : it.skip(...args));

afterAll(async () => {
  await pool.end();
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeStorage(holdInTx: boolean) {
  const storage = new FileStorage(db, {
    uploadDir: "/tmp/qijian-gc-deadlock",
    publicBaseUrl: "http://localhost",
  } as never);
  storage.setReferenceCheckers([
    {
      transactional: holdInTx ? true : false,
      referencesFile: async () => {
        await sleep(HOLD_MS);
        return false;
      },
    },
  ]);
  return storage;
}

async function seedOldFiles(projectId: string, count: number) {
  const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (let i = 0; i < count; i += 1) {
    await db.insert(storedFiles).values({
      projectId,
      originalFilename: `orphan-${i}.png`,
      mediaType: "image/png",
      sizeBytes: 10,
      contentHash: `hash-${projectId}-${i}`,
      objectKey: `${projectId}/orphan-${i}.png`,
      createdAt,
    });
  }
}

async function probeCreate(name: string) {
  return Promise.race([
    desks.createProject(name).then((project) => ({ ok: true as const, project })),
    sleep(PROBE_MS).then(() => ({ ok: false as const, project: undefined })),
  ]);
}

describe("file GC pool exhaustion (2026-08-13 repro)", () => {
  itDb("old path: 11 parallel gcUnattached on a 3-conn pool starves createProject", async () => {
    const project = await desks.createProject("repro-old-fanout");
    const storage = makeStorage(true);
    try {
      await seedOldFiles(project.id, 1);
      const sweeps = Array.from({ length: CARD_COUNT }, () =>
        storage.gcUnattached({ projectId: project.id, minAgeMs: 60 * 60 * 1000 }),
      );
      await sleep(120);
      const probe = await probeCreate("repro-old-probe");
      expect(probe.ok).toBe(false);
      await Promise.all(sweeps);
      if (probe.ok && probe.project) await desks.deleteProject(probe.project.id);
    } finally {
      await desks.deleteProject(project.id);
    }
  });

  itDb("new path: 11 delete-triggered schedules leave createProject responsive", async () => {
    const project = await desks.createProject("repro-new-schedule");
    const storage = makeStorage(false);
    const started: number[] = [];
    const scheduler = new FileGcScheduler({
      debounceMs: 40,
      gc: async (projectId) => {
        started.push(Date.now());
        return storage.gcUnattached({ projectId, minAgeMs: 60 * 60 * 1000 });
      },
    });
    try {
      await seedOldFiles(project.id, CARD_COUNT);
      for (let i = 0; i < CARD_COUNT; i += 1) scheduler.schedule(project.id);
      const probe = await probeCreate("repro-new-probe");
      expect(probe.ok).toBe(true);
      expect(started).toHaveLength(0);
      if (probe.ok && probe.project) await desks.deleteProject(probe.project.id);
      await sleep(80);
      expect(started).toHaveLength(1);
    } finally {
      scheduler.cancel(project.id);
      await desks.deleteProject(project.id);
    }
  });
});
