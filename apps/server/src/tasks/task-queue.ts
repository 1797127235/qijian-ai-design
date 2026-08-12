import type { TaskStatus } from "./types.js";

export type TerminalTaskStatus = Extract<
  TaskStatus,
  "succeeded" | "failed" | "cancelled" | "cancelled_with_side_effect" | "needs_review"
>;
