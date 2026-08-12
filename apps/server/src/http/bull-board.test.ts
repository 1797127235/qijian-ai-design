import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createHttpApp } from "./app.js";

function appFor(env: Record<string, string> = {}) {
  const config = loadConfig(env);
  const board = new Hono();
  board.get("/", (c) => c.text("board"));
  board.get("/api/queues", (c) => c.json({ ok: true }));
  return createHttpApp({
    config,
    artifacts: {} as never,
    desks: {} as never,
    files: {} as never,
    chats: {} as never,
    sessions: {} as never,
    bullBoard: board,
  });
}

describe("Bull Board HTTP integration", () => {
  it("serves the board and redirects a trailing slash", async () => {
    const app = appFor();
    expect((await app.request("/admin/queues")).status).toBe(200);
    expect((await app.request("/admin/queues/")).status).toBe(308);
    expect((await app.request("/admin/queues/")).headers.get("location")).toBe("/admin/queues");
    expect((await app.request("/admin/queues/api/queues")).status).toBe(200);
  });

  it("protects the board and its API with Basic Auth when configured", async () => {
    const app = appFor({ BULL_BOARD_USERNAME: "operator", BULL_BOARD_PASSWORD: "secret" });
    const unauthorized = await app.request("/admin/queues");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Basic");

    const credentials = Buffer.from("operator:secret").toString("base64");
    const authorized = await app.request("/admin/queues/api/queues", {
      headers: { Authorization: `Basic ${credentials}` },
    });
    expect(authorized.status).toBe(200);
  });
});
