/** agent_jobs.status 枚举。与 schema 的 $type 对齐。 */
export type AgentJobStatus =
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

/** AgentJob DTO（Date → ISO string）。 */
export interface AgentJobDto {
  id: string;
  projectId: string;
  threadId: string;
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
