export class HttpError extends Error {
  constructor(public readonly status: 400 | 404 | 409 | 422 | 500 | 503, message: string) {
    super(message);
  }
}
