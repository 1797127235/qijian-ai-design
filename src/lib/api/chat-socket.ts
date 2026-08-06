import type { ChatConnectionStatus, ServerEvent } from "./types";

export function connectChat(
  projectId: string,
  onEvent: (event: ServerEvent) => void,
  onStatus?: (status: ChatConnectionStatus) => void,
) {
  const url = new URL(`/api/projects/${projectId}/chat`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let reconnectAttempt = 0;
  let closed = false;
  let status: ChatConnectionStatus = "connecting";
  const queue: string[] = [];

  const updateStatus = (next: ChatConnectionStatus) => {
    if (status === next) return;
    status = next;
    onStatus?.(next);
  };

  const connect = () => {
    if (closed) return;
    updateStatus(reconnectAttempt === 0 ? "connecting" : "reconnecting");
    const nextSocket = new WebSocket(url);
    socket = nextSocket;
    nextSocket.onopen = () => {
      reconnectAttempt = 0;
      updateStatus("connected");
      for (const message of queue.splice(0)) nextSocket.send(message);
    };
    nextSocket.onmessage = (raw) => {
      try {
        onEvent(JSON.parse(raw.data as string) as ServerEvent);
      } catch {
        onEvent({ type: "error", error: { code: "INVALID_SERVER_EVENT", message: "收到无法解析的助手消息", retryable: true } });
      }
    };
    nextSocket.onerror = () => {
      // close 事件负责统一进入重连流程，避免重复提示。
    };
    nextSocket.onclose = () => {
      if (socket === nextSocket) socket = undefined;
      if (closed) {
        updateStatus("disconnected");
        return;
      }
      reconnectAttempt += 1;
      updateStatus("reconnecting");
      const delay = Math.min(500 * 2 ** (reconnectAttempt - 1), 5_000);
      reconnectTimer = window.setTimeout(connect, delay);
    };
  };

  const send = (message: object) => {
    const serialized = JSON.stringify(message);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(serialized);
      return true;
    }
    if (queue.length >= 20) {
      onEvent({ type: "error", error: { code: "SEND_QUEUE_FULL", message: "待发送消息过多，请等待连接恢复", retryable: true } });
      return false;
    }
    queue.push(serialized);
    return true;
  };

  onStatus?.(status);
  connect();

  return {
    // selectedArtifactIds：发送瞬间的画布选中，空数组时省略字段以保持旧客户端兼容
    prompt: (
      text: string,
      threadId: string,
      clientMessageId?: string,
      attachmentIds: string[] = [],
      selectedArtifactIds: string[] = [],
    ) => send({
      type: "prompt",
      text,
      threadId,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(selectedArtifactIds.length > 0 ? { selectedArtifactIds } : {}),
    }),
    stop: (threadId: string) => send({ type: "stop", threadId }),
    close: () => {
      closed = true;
      window.clearTimeout(reconnectTimer);
      queue.length = 0;
      socket?.close();
      socket = undefined;
      updateStatus("disconnected");
    },
    ready: () => socket?.readyState === WebSocket.OPEN,
    status: () => status,
  };
}
