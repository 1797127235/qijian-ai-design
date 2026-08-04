import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { ServerConfig } from "../config.js";
import * as schema from "./schema.js";

export function createDatabase(config: Pick<ServerConfig, "databaseUrl">) {
  const pool = new Pool({ connectionString: config.databaseUrl });
  return { db: drizzle(pool, { schema }), pool };
}

export type Database = ReturnType<typeof createDatabase>["db"];
