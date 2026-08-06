export type {
  ArtifactSnapshot,
  ChatAttachment,
  ChatConnectionStatus,
  ChatThread,
  DeskLayoutObject,
  DeskSnapshot,
  ProjectSummary,
  ServerEvent,
  StoredChatMessage,
  StoredFile,
  StoredToolCall,
} from "./api/types";
export { ApiError } from "./api/types";
export { api } from "./api/http";
export { connectChat } from "./api/chat-socket";
