/**
 * 展示名 LLM 适配器（无状态、无队列）。
 * 实际入队/重试/写库在 `tasks/artifact-name-task.ts` + ArtifactService。
 */
import type { ServerConfig } from "../config.js";

const NAMING_TIMEOUT_MS = 12_000;
/** 喂给模型的意图正文上限，避免超长 prompt 费 token / 超时。 */
const PROMPT_TEXT_CAP = 400;
/** 入库前再截断的展示名长度（中文约 4～12 字产品目标）。 */
const NAME_MAX_CHARS = 16;

const SYSTEM_PROMPT =
  "你是室内设计桌面卡片的命名助手。根据用户的生成意图，起一个简短中文展示名（4～12字）。"
  + "偏好「空间」或「空间 · 区分点」（如：储藏室、客厅 · 暖木、厨房）。"
  + "只输出名称本身：不要解释、不要引号、不要书名号、不要标点结尾、不要 A01/UUID、不要「从…生成」。";

/**
 * 单次非流式 chat/completions 请求。
 * @returns 校验通过的短名；未配置 API / 网络失败 / 脏输出均为 undefined（由上层重试或 soft-fail）。
 */
export async function suggestArtifactDisplayName(
  config: Pick<ServerConfig, "textEndpoint" | "textApiKey" | "textModel">,
  text: string,
  parentDisplayName?: string,
): Promise<string | undefined> {
  if (!config.textEndpoint || !config.textApiKey) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAMING_TIMEOUT_MS);
  try {
    const userContent = parentDisplayName
      ? `参考话题（勿照抄「从…生成」）：${parentDisplayName}\n\n意图：${text.slice(0, PROMPT_TEXT_CAP)}`
      : text.slice(0, PROMPT_TEXT_CAP);
    const response = await fetch(config.textEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.textApiKey}`,
      },
      body: JSON.stringify({
        model: config.textModel,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.3,
        max_tokens: 40,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    return typeof content === "string" ? sanitizeDisplayName(content) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拒绝机器编号、UUID、血缘串、整段 prompt 回声等脏输出。
 * 通过校验的字符串再截到 NAME_MAX_CHARS。
 */
export function sanitizeDisplayName(raw: string): string | undefined {
  let text = raw.trim().split("\n")[0]?.trim() ?? "";
  text = text
    .replace(/^["'「」《》*_`#]+|["'「」《》*_`#]+$/g, "")
    .replace(/[。.，,；;：:！!？?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  if (/^A\d{2,}$/i.test(text)) return undefined;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text)) return undefined;
  if (/从.+生成/.test(text)) return undefined;
  if (text.length > 80) return undefined;
  return text.slice(0, NAME_MAX_CHARS) || undefined;
}
