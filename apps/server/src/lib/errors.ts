/**
 * 应用层错误模型。
 * AppError 携带 HTTP 状态、机器可读 code、可选 details；HttpError 是路由层便捷封装。
 * 状态码 + code 的组合让前端能用 code 编程（而不是 parse message）。
 */

/** 错误码枚举：前端按 code 分支，message 仅供日志/展示。 */
export type AppErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_FAILED"
  | "UPLOAD_TOO_LARGE"
  | "UNSUPPORTED_FILE_TYPE"
  | "INVALID_FILE_CONTENT"
  | "ATTACHMENT_NOT_FOUND"
  | "ATTACHMENT_BUSY"
  | "INTERNAL_ERROR";

/** 基础错误：所有业务异常都应继承自此。 */
export class AppError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 413 | 422 | 500 | 503,
    public readonly code: AppErrorCode,
    message: string,
    /** true 时前端可重试（如 503 / 限流）；false 时不应重试。 */
    public readonly retryable = false,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** 路由层便捷封装：传 status 自动推导 code。 */
export class HttpError extends AppError {
  constructor(status: 400 | 404 | 409 | 413 | 422 | 500 | 503, message: string, code?: AppErrorCode) {
    super(
      status,
      code ?? (
        status === 404 ? "NOT_FOUND"
        : status === 409 ? "CONFLICT"
        : status === 422 ? "VALIDATION_FAILED"
        : status >= 500 ? "INTERNAL_ERROR"
        : "BAD_REQUEST"
      ),
      message,
    );
  }
}
