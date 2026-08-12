import { redactTracePayload } from "../agent/tracing/redact.js";

export type LogFields = Readonly<Record<string, unknown>>;
export type LogLevel = "debug" | "info" | "warn" | "error";

export class StructuredLogger {
  private readonly sink: (line: string) => void;

  constructor(
    private readonly service: string,
    options: { sink?: (line: string) => void } = {},
  ) {
    this.sink = options.sink ?? ((line) => console.log(line));
  }

  debug(event: string, fields: LogFields = {}) { this.write("debug", event, fields); }
  info(event: string, fields: LogFields = {}) { this.write("info", event, fields); }
  warn(event: string, fields: LogFields = {}) { this.write("warn", event, fields); }
  error(event: string, fields: LogFields = {}) { this.write("error", event, fields); }

  private write(level: LogLevel, event: string, fields: LogFields): void {
    const safe = redactTracePayload(fields);
    this.sink(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      event,
      ...(safe && typeof safe === "object" && !Array.isArray(safe) ? safe : {}),
    }));
  }
}
