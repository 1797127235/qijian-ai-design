/**
 * Drizzle + node-postgres 连接工厂。
 *  - 一个进程共用一个 Pool（pg 默认 max=10），业务层不要再 new Pool
 *  - schema 注入让 `db.query.users.findMany()` 风格的查询可用
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { ServerConfig } from "../config.js";
import * as schema from "./schema.js";

/**
 * 创建数据库句柄。
 * 返回 db（drizzle 包装）与 pool（便于关闭），关闭时由入口的 shutdown 调 pool.end()
 */
export function createDatabase(config: Pick<ServerConfig, "databaseUrl">) {
  const pool = new Pool({ connectionString: config.databaseUrl });
  return { db: drizzle(pool, { schema }), pool };
}

/** 业务层强类型 db handle，方便 service 构造函数复用 */
export type Database = ReturnType<typeof createDatabase>["db"];
