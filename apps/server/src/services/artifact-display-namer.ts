/**
 * 展示名 LLM 适配器（无状态、无队列）。
 * 实际入队/重试/写库在 `tasks/artifact-name-task.ts` + ArtifactService。
 */
import type { ServerConfig } from "../config.js";

/** grok 等推理模型常 8～20s 才吐短名；12s 会整批 abort（见 agent_jobs 37s 三次失败）。 */
const NAMING_TIMEOUT_MS = 30_000;
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
    if (!response.ok) {
      console.warn(`[artifact-display-namer] http ${response.status} model=${config.textModel}`);
      return undefined;
    }
    const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    return typeof content === "string" ? sanitizeDisplayName(content) : undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.name : "error";
    console.warn(`[artifact-display-namer] ${reason} model=${config.textModel}`);
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

/** 从 naming_input 去掉「参考话题/意图」包装，只留意图正文。 */
function intentBody(namingInput: string): string {
  const text = namingInput.trim();
  const intent = text.match(/(?:^|\n)意图：([\s\S]+)$/);
  if (intent?.[1]?.trim()) return intent[1].trim();
  return text;
}

const ROOM_LABELS = [
  "主卧", "次卧", "客卧", "儿童房", "书房", "客厅", "餐厅", "厨房", "卫生间",
  "浴室", "阳台", "玄关", "门厅", "储藏室", "储藏间", "衣帽间", "工作间",
] as const;

const STYLE_LABELS = [
  "粗野触感", "极简", "工业风", "原木", "暖木", "侘寂", "法式", "中古", "现代",
] as const;

/**
 * LLM 不可用时的确定性短名：从生图意图里抽空间/图种/风格。
 * 输出再走 sanitize；失败返回 undefined（仍可回落 UI「效果图-N」）。
 */
export function heuristicDisplayNameFromPrompt(namingInput: string): string | undefined {
  const body = intentBody(namingInput);
  if (!body) return undefined;

  const room = ROOM_LABELS.find((label) => body.includes(label));
  const style = STYLE_LABELS.find((label) => body.includes(label));

  let kind: string | undefined;
  // 目标图种：转彩平优先于「源是线稿」；显式否定彩平才走线稿
  const wantsColorPlan = /彩平|彩色平面/.test(body) && !/非彩平|不是彩平|勿彩平/.test(body);
  if (wantsColorPlan) kind = "彩平";
  else if (/线稿|户型|平面图|floor\s*plan/i.test(body)) kind = "线稿户型";
  else if (/效果图|透视/.test(body)) kind = "效果图";

  // 户型整体（三室一厅等）优先于单房间标签
  const plan = body.match(/([一二三四五六七八九十\d]+室[一二三四五六七八九十\d]*厅)/)?.[1];

  let candidate: string | undefined;
  if (plan && kind) candidate = `${plan}${kind}`;
  else if (plan) candidate = plan;
  else if (room && style) candidate = `${room} · ${style}`;
  else if (room && kind === "效果图") candidate = `${room}效果图`;
  else if (room) candidate = room;
  else if (kind && style) candidate = `${kind} · ${style}`;
  else if (kind) candidate = kind;
  else if (style) candidate = style;

  if (candidate) return sanitizeDisplayName(candidate);

  // 最后：截取首句里偏中文的短片段（至少含中文，避免英文碎词）
  const first = body.split(/[。！？\n；;]/)[0]?.trim() ?? "";
  const compact = first
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/["'「」《》*_`#]/g, "")
    .replace(/^(根据|将这张|用|请|帮我|生成|绘制|重新绘制)+/u, "")
    .trim();
  if (!/[\u4e00-\u9fff]/.test(compact)) return undefined;
  if (compact.length >= 2 && compact.length <= 24) return sanitizeDisplayName(compact);
  if (compact.length > 24) return sanitizeDisplayName(compact.slice(0, NAME_MAX_CHARS));
  return undefined;
}
