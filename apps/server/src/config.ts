import { resolve } from "node:path";

/**
 * 服务端配置：从环境变量读取，所有可选字段都给出本地默认值，
 * 让开发者 `npm run dev:server` 即可跑起来。
 */
export interface ServerConfig {
  port: number;
  databaseUrl: string;
  /** CORS 白名单来源，逗号分隔；前端 dev server 默认 5173 */
  corsOrigins: string[];
  /** 上传文件落盘的绝对路径，相对路径会基于 cwd 解析 */
  uploadDir: string;
  /** 对外暴露的文件 URL 基址（影响 stored_files.object_key 拼出的可访问 URL） */
  publicBaseUrl: string;
  /** pi-coding-agent 的 provider 名（~/.pi/agent/models.json 里的 key） */
  agentProvider: string;
  agentModel: string;
  /** 图像生成端点；为空时所有生图调用直接 503（不算 bug，是「未配置」语义） */
  imageEndpoint?: string;
  imageApiKey?: string;
  /** 文本 LLM（项目自动起名）：OpenAI 兼容 chat/completions 端点；未配置则自动起名静默关闭 */
  textEndpoint?: string;
  textApiKey?: string;
  textModel?: string;
  /** 文生图 model；codex2api 实测 grok-imagine-image-quality */
  imageModel?: string;
  /** 有参考图时的 model；edits 路径用（grok-imagine-edit 上游 404，改用 quality） */
  imageEditModel?: string;
  /** 图像服务/结果 CDN 的 HTTP 代理；x.ai 图床被墙时必须，如 http://127.0.0.1:7897 */
  imageFetchProxy?: string;
  /** H7 LangSmith 观测 */
  langsmithTracing: boolean;
  langsmithApiKey?: string;
  langsmithProject?: string;
  langsmithEndpoint?: string;
  langsmithDebugSync: boolean;
}

/** 从 images API URL 推导同网关的 chat/completions（取 origin + /v1/chat/completions；失败返回 undefined）。 */
function deriveChatCompletionsUrl(imageApiUrl?: string): string | undefined {
  if (!imageApiUrl) return undefined;
  try {
    const url = new URL(imageApiUrl);
    const base = url.pathname.match(/^(\/v\d+)\//)?.[1] ?? "/v1";
    return `${url.origin}${base}/chat/completions`;
  } catch {
    return undefined;
  }
}

/**
 * 读取 env 并组装 ServerConfig。
 * 注入 env 形参便于测试；生产环境直接用 process.env。
 */
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
    // 文本 LLM：显式 TEXT_API_* 优先；否则从 IMAGE_API_URL 推导同网关的 chat/completions（codex2api 同源）
    textEndpoint: env.TEXT_API_URL ?? deriveChatCompletionsUrl(env.IMAGE_API_URL),
    textApiKey: env.TEXT_API_KEY ?? env.IMAGE_API_KEY,
    textModel: env.TEXT_MODEL ?? env.AGENT_MODEL ?? "grok-4.5-latest",
    imageModel: env.IMAGE_MODEL ?? "grok-imagine-image-quality",
    // imageEditModel 缺省回退到 imageModel（保持单一 provider 时的简洁）
    imageEditModel: env.IMAGE_EDIT_MODEL ?? env.IMAGE_MODEL ?? "grok-imagine-image-quality",
    // 代理：IMAGE_FETCH_PROXY 显式 > 标准 HTTPS_PROXY 约定
    imageFetchProxy: env.IMAGE_FETCH_PROXY ?? env.HTTPS_PROXY ?? env.https_proxy,
    langsmithTracing: (env.LANGSMITH_TRACING ?? "").toLowerCase() === "true",
    langsmithApiKey: env.LANGSMITH_API_KEY,
    langsmithProject: env.LANGSMITH_PROJECT ?? "pi",
    langsmithEndpoint: env.LANGSMITH_ENDPOINT,
    langsmithDebugSync: (env.LANGSMITH_DEBUG_SYNC ?? "").toLowerCase() === "true",
  };
}
