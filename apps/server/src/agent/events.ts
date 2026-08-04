export type ServerEvent =
  | { type: "agent_event"; event: unknown }
  | { type: "approval_request"; projectId: string; approvalId: string; tool: string; params: unknown; description: string }
  | { type: "approval_resolved"; projectId: string; approvalId: string; approved: boolean }
  | { type: "object_changed"; projectId: string; artifactId?: string; undoable?: boolean }
  | { type: "error"; message: string };

export type EventSink = (event: ServerEvent) => void;
