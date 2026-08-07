export type AgentJobStatus =
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

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
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface AcceptedJobDetails {
  ok: true;
  async: true;
  status: "accepted";
  task_id: string;
  kind: string;
  artifact_id?: string;
}
