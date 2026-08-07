import type { ArtifactType } from "./types.js";

/** 领域层校验失败抛出此异常；HTTP 层捕获后映射为 422。 */
export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainValidationError";
  }
}

const nonEmpty = (value: unknown) => typeof value === "string" && value.trim().length > 0;

/**
 * 按 artifact 类型校验 payload 的最低完整性。
 * 只做「必须有 / 必须为字符串」之类的最低校验，不做流程关卡（确认/采用属于产品功能，TODO）。
 *
 * effect_image 有三个合法态：
 *  - 完成：payload.file_id 存在
 *  - 生成中：payload.pending = true（先占位 artifact，异步完成后写版本）
 *  - 失败：payload.error 非空（保留占位记录，让前端能显示错误）
 */
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
