import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./apps/server/src/db/schema.ts",
  out: "./apps/server/drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgresql://qijian:qijian@localhost:5433/qijian" },
});
