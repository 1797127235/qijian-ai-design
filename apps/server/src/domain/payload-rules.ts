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
  if (artifactType === "sticky_note" && payload.text !== undefined && typeof payload.text !== "string") {
    throw new DomainValidationError("便签内容必须是文本");
  }
  if (artifactType === "canvas_image" && !nonEmpty(payload.file_id)) {
    throw new DomainValidationError("canvas_image 必须包含 file_id");
  }
  if (artifactType === "effect_image") {
    const pending = payload.pending === true;
    const hasError = typeof payload.error === "string" && payload.error.length > 0;
    if (!pending && !hasError && !nonEmpty(payload.file_id)) {
      throw new DomainValidationError("effect_image 完成态必须包含 file_id");
    }
  }
}
