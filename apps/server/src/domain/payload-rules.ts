import type { ArtifactType } from "./types.js";
import { parseSpaces } from "./space-map.js";

export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainValidationError";
  }
}

const nonEmpty = (value: unknown) => typeof value === "string" && value.trim().length > 0;

/** 确认 Artifact 前的领域规则；与持久化无关。 */
export function assertConfirmable(artifactType: ArtifactType, payload: Record<string, unknown>) {
  if (artifactType === "space_map") {
    if (parseSpaces(payload).length === 0) {
      throw new DomainValidationError("确认 space_map 前必须标注空间区域");
    }
  }
  if (artifactType === "understanding_note" && !nonEmpty(payload.text)) {
    throw new DomainValidationError("理解便签内容不能为空");
  }
  if (artifactType === "design_directions") {
    const directions = Array.isArray(payload.directions) ? payload.directions : [];
    const selected = payload.selected_direction_id;
    const selectedExists = directions.some((direction) => {
      const row = direction && typeof direction === "object" ? direction as Record<string, unknown> : undefined;
      return row?.id === selected;
    });
    if (directions.length !== 3 || !selectedExists) {
      throw new DomainValidationError("确认 design_directions 前必须从三个方向中选择一个");
    }
  }
  if (artifactType === "effect_image" && !nonEmpty(payload.url)) {
    throw new DomainValidationError("effect_image 必须包含图片 URL");
  }
  if (artifactType === "proposal_package" && !payload.pdf_file && !payload.pdf_path) {
    throw new DomainValidationError("proposal_package 必须包含 PDF 文件引用");
  }
}
