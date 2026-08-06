import type { ArtifactType } from "./types.js";

export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainValidationError";
  }
}

const nonEmpty = (value: unknown) => typeof value === "string" && value.trim().length > 0;

/** 最低内容校验，无流程关卡。 */
export function assertPayload(artifactType: ArtifactType, payload: Record<string, unknown>) {
  if (artifactType === "understanding_note" && !nonEmpty(payload.text)) {
    throw new DomainValidationError("理解便签内容不能为空");
  }
  if (artifactType === "design_directions") {
    const directions = Array.isArray(payload.directions) ? payload.directions : [];
    if (directions.length === 0) {
      throw new DomainValidationError("design_directions 至少包含一个方向");
    }
  }
  if (artifactType === "effect_image" && !nonEmpty(payload.url)) {
    throw new DomainValidationError("effect_image 必须包含图片 URL");
  }
  if (artifactType === "sticky_note" && payload.text !== undefined && typeof payload.text !== "string") {
    throw new DomainValidationError("便签内容必须是文本");
  }
  if (artifactType === "canvas_image" && !nonEmpty(payload.file_id)) {
    throw new DomainValidationError("canvas_image 必须包含 file_id");
  }
}
