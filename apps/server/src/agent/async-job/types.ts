/** agent_jobs.status 枚举。与 schema 的 $type 对齐。 */
export type AgentJobStatus =
  | "enqueue_pending"
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "cancelled_with_side_effect"
  | "needs_review"
  | "interrupted";

/** AgentJob DTO（Date → ISO string）。 */
export interface AgentJobDto {
  id: string;
  projectId: string;
  /** 面板生图为 undefined；Agent 路径有值 */
  threadId?: string;
  runId?: string;
  kind: string;
  status: AgentJobStatus;
  input: unknown;
  result?: unknown;
  artifactId?: string;
  error?: string;
  traceRootId?: string;
  traceParentId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** accepted 工具结果 details 的契约：LLM 与前端按此结构取 task_id。 */
export interface AcceptedJobDetails {
  ok: true;
  async: true;
  status: "accepted";
  task_id: string;
  kind: string;
  artifact_id?: string;
}
