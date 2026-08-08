import type { EventSink } from "../agent/events.js";
import type { ServerConfig } from "../config.js";
import { DEFAULT_PROJECT_NAME } from "../domain/types.js";
import type { DeskStateService } from "./desk-state-service.js";

/** 起名请求的超时兜底；自动起名是后台增强，不能拖住任何东西。 */
const NAMING_TIMEOUT_MS = 15_000;
/** 喂给模型的描述上限；首条消息可能很长，截断足够总结。 */
const PROMPT_TEXT_CAP = 500;
/** 名称入库上限（路由层同样限制 200，这里收得更紧）。 */
const NAME_MAX_CHARS = 30;

const SYSTEM_PROMPT = "你是命名助手。根据用户的室内设计项目描述，生成一个简短的中文项目名称（不超过16个字）。只输出名称本身：不要解释、不要引号、不要书名号、不要标点结尾。";

/**
 * 项目自动起名：首条用户消息后，若项目名仍是默认名，后台调文本 LLM 总结一个名字。
 *
 * 设计约束：
 *  - 完全异步、失败静默：起名是增强不是主链路，任何异常都不影响对话/创建
 *  - 双重检查（调用前 + 落库前）：用户手动改过名就不覆盖
 *  - per project inflight 去重：首条消息连发也只起一次
 */
export class ProjectAutoNamer {
  private readonly inflight = new Set<string>();

  constructor(
    private readonly desks: DeskStateService,
    private readonly config: ServerConfig,
    private readonly emit: EventSink,
  ) {}

  /** 首条用户消息落库后调用；text 为空或未配置文本 LLM 时直接跳过。 */
  kick(projectId: string, text: string) {
    if (!text.trim()) return;
    if (!this.config.textEndpoint || !this.config.textApiKey) return;
    if (this.inflight.has(projectId)) return;
    this.inflight.add(projectId);
    void this.run(projectId, text)
      .catch(() => undefined)
      .finally(() => this.inflight.delete(projectId));
  }

  private async run(projectId: string, text: string) {
    const project = await this.desks.getProject(projectId);
    if (!project || project.name !== DEFAULT_PROJECT_NAME) return;
    const name = await this.suggestName(text);
    if (!name) return;
    // 落库前复查：等待 LLM 期间用户可能已手动改名
    const latest = await this.desks.getProject(projectId);
    if (!latest || latest.name !== DEFAULT_PROJECT_NAME) return;
    await this.desks.renameProject(projectId, name);
    this.emit({ type: "project_renamed", projectId, name });
  }

  /** 调 OpenAI 兼容 chat/completions；解析失败/超时/非 200 一律返回 undefined（静默）。 */
  private async suggestName(text: string): Promise<string | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NAMING_TIMEOUT_MS);
    try {
      const response = await fetch(this.config.textEndpoint!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.textApiKey}`,
        },
        body: JSON.stringify({
          model: this.config.textModel,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: text.slice(0, PROMPT_TEXT_CAP) },
          ],
          temperature: 0.3,
          max_tokens: 40,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") return undefined;
      const cleaned = content
        .replace(/["'「」《》*_`#。.，,；;：:！!？?\s]+/g, " ")
        .trim()
        .slice(0, NAME_MAX_CHARS);
      return cleaned || undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
