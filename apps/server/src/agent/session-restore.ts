import { type ModelRuntime, type SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChatAttachmentDto, ChatMessageDto } from "../services/chat-service.js";
import type { AgentImageContent, FileStorage } from "../services/file-storage.js";

const MAX_RESTORED_AGENT_IMAGES = 12;
const MAX_RESTORED_AGENT_BASE64_CHARACTERS = 24 * 1024 * 1024;

export type RestoredVisuals = Map<string, { images: AgentImageContent[]; unavailable: string[] }>;
type RestoredModelIdentity = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export async function loadHistoricalVisuals(
  projectId: string,
  messages: ChatMessageDto[],
  files: Pick<FileStorage, "loadAgentImages">,
  limits = {
    maxImages: MAX_RESTORED_AGENT_IMAGES,
    maxBase64Characters: MAX_RESTORED_AGENT_BASE64_CHARACTERS,
  },
): Promise<RestoredVisuals> {
  const restored = new Map<string, { images: AgentImageContent[]; unavailable: string[] }>();
  let remainingImages = limits.maxImages;
  let remainingCharacters = limits.maxBase64Characters;

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message.role !== "user" || message.attachments.length === 0) continue;
    const images: AgentImageContent[] = [];
    const unavailable: string[] = [];
    for (const attachment of message.attachments) {
      if (remainingImages === 0 || remainingCharacters === 0) {
        unavailable.push(attachment.originalFilename);
        continue;
      }
      try {
        const loaded = await files.loadAgentImages(projectId, [attachment]);
        const characterCount = loaded.reduce((total, image) => total + image.data.length, 0);
        if (loaded.length > remainingImages || characterCount > remainingCharacters) {
          unavailable.push(attachment.originalFilename);
          continue;
        }
        images.push(...loaded);
        remainingImages -= loaded.length;
        remainingCharacters -= characterCount;
      } catch {
        unavailable.push(attachment.originalFilename);
      }
    }
    restored.set(message.id, { images, unavailable });
  }
  return restored;
}

export function agentPrompt(text: string, attachments: ChatAttachmentDto[]) {
  const base = text.trim() || "请分析这些附件，并根据当前项目上下文继续设计。";
  if (attachments.length === 0) return base;
  const list = attachments.map((attachment) => {
    const pageNote = attachment.mediaType === "application/pdf"
      ? `，PDF ${attachment.pageCount ?? "未知"} 页${(attachment.pageCount ?? 0) > 8 ? "，本次提供前 8 页视觉内容" : ""}`
      : "";
    return `- ${attachment.originalFilename}${pageNote} [source_file_id: ${attachment.id}]`;
  }).join("\n");
  return `${base}\n\n本条消息附件：\n${list}`;
}

export function restoreChatMessages(
  sessionManager: SessionManager,
  messages: Array<Pick<ChatMessageDto, "role" | "text" | "createdAt"> & { id?: string; attachments?: ChatAttachmentDto[] }>,
  model: RestoredModelIdentity,
  restoredVisuals = new Map<string, { images: AgentImageContent[]; unavailable: string[] }>(),
) {
  for (const message of messages) {
    const timestamp = Date.parse(message.createdAt) || Date.now();
    if (message.role === "user") {
      const attachments = message.attachments ?? [];
      const restored = message.id ? restoredVisuals.get(message.id) : undefined;
      const text = restored?.unavailable.length
        ? `${agentPrompt(message.text, attachments)}\n\n[以下历史附件当前不可用：${restored.unavailable.join("、")}]`
        : agentPrompt(message.text, attachments);
      const content = restored?.images.length
        ? [{ type: "text" as const, text }, ...restored.images]
        : text;
      sessionManager.appendMessage({ role: "user", content, timestamp });
      continue;
    }
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: message.text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp,
    });
  }
}
