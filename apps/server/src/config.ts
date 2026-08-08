import { resolve } from "node:path";
import {
  listModelChoices,
  loadImageProviders,
  parseModelList,
  type ImageModelChoice,
  type ImageProviderConfig,
} from "./services/image-providers.js";

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
  /**
   * 兼容旧字段：主站 generations URL / key（= imageProviders[0]）。
   * 新逻辑请用 imageProviders + resolveImageRoute。
   */
  imageEndpoint?: string;
  imageApiKey?: string;
  /** 文本 LLM（项目自动起名）：OpenAI 兼容 chat/completions 端点；未配置则自动起名静默关闭 */
  textEndpoint?: string;
  textApiKey?: string;
  textModel?: string;
  /** 主站默认文生图 model */
  imageModel?: string;
  /** 主站 edits 默认 model */
  imageEditModel?: string;
  /** 面板可选 model id 列表（跨 provider 去重） */
  imageModelOptions: string[];
  /** 面板展示：model + 所属 provider */
  imageModelChoices: ImageModelChoice[];
  /** 已配置的生图网关（可多个） */
  imageProviders: ImageProviderConfig[];
  /** 图像服务/结果 CDN 的 HTTP 代理；x.ai 图床被墙时必须，如 http://127.0.0.1:7897 */
  imageFetchProxy?: string;
  /** 默认出图尺寸偏好："1:1" / "16:9" / "1024x1024" / 空=不传 size */
  imageSize?: string;
  /** H7 LangSmith 观测 */
  langsmithTracing: boolean;
  langsmithApiKey?: string;
  langsmithProject?: string;
  langsmithEndpoint?: string;
  langsmithDebugSync: boolean;
}

/** 未配网关时的模型列表占位；与 loadImageProviders 主站 builtins 一致。 */
export function parseImageModelOptions(raw: string | undefined, defaultModel: string): string[] {
  return parseModelList(raw, defaultModel, [
    "grok-imagine-image",
    "grok-imagine-image-pro",
    "grok-imagine-image-quality",
  ]);
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
  const imageProviders = loadImageProviders(env);
  const primary = imageProviders[0];
  const choices = listModelChoices(imageProviders);
  // 未配网关时仍暴露 env 模型列表（便于单测 / 前端占位）；有网关时以 choices 为准
  const fallbackModels = parseImageModelOptions(
    env.IMAGE_MODEL_OPTIONS,
    env.IMAGE_MODEL ?? "grok-imagine-image-quality",
  );
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
    imageEndpoint: primary?.endpoint ?? env.IMAGE_API_URL,
    imageApiKey: primary?.apiKey ?? env.IMAGE_API_KEY,
    // 文本 LLM：显式 TEXT_API_* 优先；否则从 IMAGE_API_URL 推导同网关的 chat/completions（codex2api 同源）
    textEndpoint: env.TEXT_API_URL ?? deriveChatCompletionsUrl(env.IMAGE_API_URL),
    textApiKey: env.TEXT_API_KEY ?? env.IMAGE_API_KEY,
    textModel: env.TEXT_MODEL ?? env.AGENT_MODEL ?? "grok-4.5-latest",
    imageModel: primary?.models[0] ?? env.IMAGE_MODEL ?? "grok-imagine-image-quality",
    imageEditModel: primary?.editModel ?? env.IMAGE_EDIT_MODEL ?? env.IMAGE_MODEL ?? "grok-imagine-image-quality",
    imageModelOptions: choices.length > 0 ? choices.map((c) => c.id) : fallbackModels,
    imageModelChoices: choices.length > 0
      ? choices
      : fallbackModels.map((id) => ({ id, providerId: "primary", providerLabel: "Primary" })),
    imageProviders,
    // 代理：IMAGE_FETCH_PROXY 显式 > 标准 HTTPS_PROXY 约定
    imageFetchProxy: env.IMAGE_FETCH_PROXY ?? env.HTTPS_PROXY ?? env.https_proxy,
    // 空 = 不传 size（与历史行为一致）；面板 per-request 可覆盖
    imageSize: env.IMAGE_SIZE?.trim() || undefined,
    langsmithTracing: (env.LANGSMITH_TRACING ?? "").toLowerCase() === "true",
    langsmithApiKey: env.LANGSMITH_API_KEY,
    langsmithProject: env.LANGSMITH_PROJECT ?? "pi",
    langsmithEndpoint: env.LANGSMITH_ENDPOINT,
    langsmithDebugSync: (env.LANGSMITH_DEBUG_SYNC ?? "").toLowerCase() === "true",
  };
}
