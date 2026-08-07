/**
 * 桌面状态栏：把 DeskSnapshot 压成当轮 prompt 的一段文本。
 *  - 只进当轮模型输入，不写 chat_messages（KV cache 友好）
 *  - 大桌面截断 MAX_DESK_STATUS_OBJECTS 件
 *  - 短标签：便签取前 14 字 / 效果图取 prompt 前 14 字 / 画布图固定文案
 */
import type { ArtifactSnapshot, DeskSnapshot } from "../domain/types.js";

/** 大桌面截断：状态栏只列前 30 件，超出标「…共 N 件」。 */
export const MAX_DESK_STATUS_OBJECTS = 30;

/** 状态栏/chip 用的短标签，不塞 payload 全文或 base64。 */
function shortLabel(artifact: ArtifactSnapshot): string {
  const payload = artifact.payload;
  if (artifact.artifactType === "sticky_note" && typeof payload.text === "string") {
    const text = payload.text.trim().replace(/\s+/g, " ");
    if (!text) return "空便签";
    return text.length > 14 ? `${text.slice(0, 14)}…` : text;
  }
  if (artifact.artifactType === "effect_image") {
    if (payload.pending === true) return "生成中";
    if (typeof payload.error === "string" && payload.error) return "生成失败";
    if (typeof payload.prompt === "string" && payload.prompt.trim()) {
      const prompt = payload.prompt.trim().replace(/\s+/g, " ");
      return prompt.length > 14 ? `${prompt.slice(0, 14)}…` : prompt;
    }
    return "效果图";
  }
  return "画布图";
}

function formatObjectLine(artifact: ArtifactSnapshot): string {
  return `- ${artifact.artifactType} ${artifact.id}：${shortLabel(artifact)}`;
}

/**
 * 构造 `[桌面状态]` 块：项目名 + 当前选中 + 桌上物件列表。
 *  - selectedArtifactIds 列出全部（框选多选）
 *  - 脏/已删 id 标为无效（让 Agent 知道这个 id 不可用）
 *  - 只列 desk_state.objects 里出现的 artifact，未放置的隐藏（避免噪声）
 */
export function buildDeskStatusBlock(
  snapshot: DeskSnapshot | null | undefined,
  selectedArtifactIds: string[] = [],
): string {
  if (!snapshot) {
    return "[桌面状态]\n桌面状态暂不可用";
  }

  const byId = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
  // 只列已摆在桌上的物件，不列仅有 artifact 未 place 的行
  const onDesk = snapshot.deskState.objects
    .map((object) => byId.get(object.artifact_id))
    .filter((artifact): artifact is ArtifactSnapshot => Boolean(artifact));

  const selectedLines: string[] = [];
  if (selectedArtifactIds.length === 0) {
    selectedLines.push("选中：无");
  } else {
    selectedLines.push(`选中（${selectedArtifactIds.length}）：`);
    for (const selectedId of selectedArtifactIds) {
      const selected = byId.get(selectedId);
      const placed = snapshot.deskState.objects.some((object) => object.artifact_id === selectedId);
      if (!selected || !placed) {
        selectedLines.push(`- 无效（${selectedId}）`);
      } else {
        selectedLines.push(`- ${selected.artifactType} ${selected.id}「${shortLabel(selected)}」`);
      }
    }
  }

  const listed = onDesk.slice(0, MAX_DESK_STATUS_OBJECTS);
  const objectLines = listed.length === 0
    ? ["（空桌）"]
    : listed.map(formatObjectLine);
  if (onDesk.length > MAX_DESK_STATUS_OBJECTS) {
    objectLines.push(`…共 ${onDesk.length} 件`);
  }

  return [
    "[桌面状态]",
    `项目：${snapshot.project.name}`,
    ...selectedLines,
    "桌上物件：",
    ...objectLines,
  ].join("\n");
}

/**
 * 解析选中物件的 file_id，供 loadAgentImages 做多模态。
 * 跳过：不在桌、便签（无图）、pending 效果图、无 file_id 的物件。
 * 返回去重后的 file_id 列表，喂给 Agent 视觉输入。
 */
export function selectedVisualFileIds(
  snapshot: DeskSnapshot | null | undefined,
  selectedArtifactIds: string[],
): string[] {
  if (!snapshot || selectedArtifactIds.length === 0) return [];
  const byId = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
  const onDesk = new Set(snapshot.deskState.objects.map((object) => object.artifact_id));
  const fileIds: string[] = [];
  for (const id of selectedArtifactIds) {
    if (!onDesk.has(id)) continue;
    const artifact = byId.get(id);
    if (!artifact) continue;
    if (artifact.artifactType !== "canvas_image" && artifact.artifactType !== "effect_image") continue;
    if (artifact.payload.pending === true) continue;
    const fileId = artifact.payload.file_id;
    if (typeof fileId === "string" && fileId.trim()) fileIds.push(fileId);
  }
  return [...new Set(fileIds)];
}
