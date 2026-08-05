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

export class AppError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 413 | 422 | 500 | 503,
    public readonly code: AppErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class HttpError extends AppError {
  constructor(status: 400 | 404 | 409 | 413 | 422 | 500 | 503, message: string, code?: AppErrorCode) {
    super(status, code ?? (status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : status === 422 ? "VALIDATION_FAILED" : status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST"), message);
  }
}
