import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { connectionHighlight, ConnectionsLayer } from "./Connections";
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

  it("highlights incident edges when an object is selected", () => {
    const extra: DeskConnection[] = [
      { id: "c1", from: "a", to: "b" },
      { id: "c2", from: "b", to: "a" },
    ];
    const moreObjects: DeskObject[] = [
      ...objects,
      { id: "c", kind: "canvas_image", x: 600, y: 0, rot: 0, status: "confirmed", url: "/c.png" },
    ];
    const all: DeskConnection[] = [...extra, { id: "c3", from: "b", to: "c" }];
    const html = renderToStaticMarkup(
      createElement(ConnectionsLayer, {
        objects: moreObjects,
        connections: all,
        selectedObjectIds: ["a"],
      }),
    );
    expect(html).toContain("conn-line-output");
    expect(html).toContain("conn-line-source");
    expect(html).toContain("conn-line-dim");
    expect(html).not.toContain('class="conn-delete"');
  });

  it("does not show delete on related-only edges", () => {
    const html = renderToStaticMarkup(
      createElement(ConnectionsLayer, {
        objects,
        connections,
        selectedObjectIds: ["a"],
        onDelete: () => undefined,
      }),
    );
    expect(html).toContain("conn-line-output");
    expect(html).not.toContain('class="conn-delete"');
  });

  it("colors inbound sources and outbound outputs differently", () => {
    expect(connectionHighlight({ id: "c1", from: "a", to: "b" }, undefined, ["b"])).toBe("source");
    expect(connectionHighlight({ id: "c1", from: "a", to: "b" }, undefined, ["a"])).toBe("output");
    expect(connectionHighlight({ id: "c1", from: "a", to: "b" }, undefined, ["a", "b"])).toBe("both");
    expect(connectionHighlight({ id: "c1", from: "a", to: "b" }, "c1", [])).toBe("selected");
  });
});
