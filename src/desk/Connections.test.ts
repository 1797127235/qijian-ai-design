import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectionsLayer } from "./Connections";
import type { DeskConnection, DeskObject } from "./types";

const objects: DeskObject[] = [
  { id: "a", kind: "canvas_image", x: 0, y: 0, rot: 0, status: "confirmed", url: "/a.png" },
  { id: "b", kind: "effect_image", x: 300, y: 0, rot: 0, status: "draft" },
];

const connections: DeskConnection[] = [{ id: "c1", from: "a", to: "b" }];

describe("ConnectionsLayer", () => {
  it("renders hit path for each connection", () => {
    const html = renderToStaticMarkup(
      createElement(ConnectionsLayer, { objects, connections }),
    );
    expect(html).toContain('class="conn-hit"');
    expect(html).toContain("desk-connections");
  });

  it("shows delete control when connection is selected and onDelete provided", () => {
    const html = renderToStaticMarkup(
      createElement(ConnectionsLayer, {
        objects,
        connections,
        selectedId: "c1",
        onDelete: () => undefined,
      }),
    );
    expect(html).toContain('class="conn-delete"');
  });

  it("hides delete control when not selected", () => {
    const html = renderToStaticMarkup(
      createElement(ConnectionsLayer, {
        objects,
        connections,
        selectedId: undefined,
        onDelete: () => undefined,
      }),
    );
    expect(html).not.toContain('class="conn-delete"');
  });
});
