import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectChat, type ChatConnectionStatus } from "./api";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string | URL) {
    FakeWebSocket.instances.push(this);
  }

  send(message: string) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(message);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  serverClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

describe("connectChat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", {
      location: { href: "http://localhost:5173/" },
      setTimeout: (handler: () => void, delay: number) => setTimeout(handler, delay),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("queues messages until the connection opens", () => {
    const statuses: ChatConnectionStatus[] = [];
    const chat = connectChat("project-1", vi.fn(), (status) => statuses.push(status));
    expect(chat.prompt("整理项目理解", "thread-1")).toBe(true);

    const socket = FakeWebSocket.instances[0];
    expect(socket.sent).toEqual([]);
    socket.open();

    expect(socket.sent).toEqual([JSON.stringify({ type: "prompt", text: "整理项目理解", threadId: "thread-1" })]);
    expect(statuses).toEqual(["connecting", "connected"]);
    chat.close();
  });

  it("sends a stable client message id for server-side deduplication", () => {
    const chat = connectChat("project-1", vi.fn());
    const socket = FakeWebSocket.instances[0];
    socket.open();

    expect(chat.prompt("继续完善", "thread-1", "client-message-1")).toBe(true);
    expect(socket.sent).toEqual([JSON.stringify({
      type: "prompt",
      text: "继续完善",
      threadId: "thread-1",
      clientMessageId: "client-message-1",
    })]);
    chat.close();
  });

  it("sends a stop command for the active thread", () => {
    const chat = connectChat("project-1", vi.fn());
    const socket = FakeWebSocket.instances[0];
    socket.open();

    expect(chat.stop("thread-1")).toBe(true);
    expect(socket.sent).toEqual([JSON.stringify({ type: "stop", threadId: "thread-1" })]);
    chat.close();
  });

  it("reconnects with backoff after an unexpected close", () => {
    const statuses: ChatConnectionStatus[] = [];
    const chat = connectChat("project-1", vi.fn(), (status) => statuses.push(status));
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].serverClose();

    expect(statuses.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].open();
    expect(statuses.at(-1)).toBe("connected");
    chat.close();
  });

  it("does not reconnect after an intentional close", () => {
    const chat = connectChat("project-1", vi.fn());
    FakeWebSocket.instances[0].open();
    chat.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
