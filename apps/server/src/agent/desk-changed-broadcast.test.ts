import { describe, expect, it } from "vitest";
import { createDeskContentChangedHandler } from "./desk-changed-broadcast.js";
import type { EventSink, ServerEvent } from "./events.js";

describe("createDeskContentChangedHandler", () => {
  it("schedules cover and publishes object_changed without artifactId", () => {
    const covers: string[] = [];
    const events: ServerEvent[] = [];
    const publish: EventSink = (event) => {
      events.push(event);
    };
    const handler = createDeskContentChangedHandler((id) => covers.push(id), publish);

    handler("proj-1");

    expect(covers).toEqual(["proj-1"]);
    expect(events).toEqual([{ type: "object_changed", projectId: "proj-1" }]);
  });

  it("uses live publish reference after reassignment", () => {
    const events: ServerEvent[] = [];
    let publish: EventSink = () => undefined;
    const handler = createDeskContentChangedHandler(
      () => undefined,
      (event) => publish(event),
    );

    handler("early");
    expect(events).toEqual([]);

    publish = (event) => {
      events.push(event);
    };
    handler("late");
    expect(events).toEqual([{ type: "object_changed", projectId: "late" }]);
  });
});
