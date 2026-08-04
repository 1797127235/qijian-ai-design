import { resolve } from "node:path";

export interface ServerConfig {
  port: number;
  databaseUrl: string;
  corsOrigins: string[];
  uploadDir: string;
  publicBaseUrl: string;
  agentProvider: string;
  agentModel: string;
  imageEndpoint?: string;
  imageApiKey?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? 8787),
    databaseUrl: env.DATABASE_URL ?? "postgresql://qijian:qijian@localhost:5433/qijian",
    corsOrigins: (env.API_CORS_ORIGINS ?? "http://localhost:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    uploadDir: resolve(env.UPLOAD_DIR ?? "data/uploads"),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT ?? 8787}`,
    agentProvider: env.AGENT_PROVIDER ?? "codex2api",
    agentModel: env.AGENT_MODEL ?? "grok-4.5-latest",
    imageEndpoint: env.IMAGE_API_URL,
    imageApiKey: env.IMAGE_API_KEY,
  };
}
