import { describe, expect, it } from "vitest";
import {
  HISTORY_CAP,
  canRedo,
  canUndo,
  emptyStacks,
  pushOp,
  takeRedo,
  takeUndo,
  type DeskHistoryEntry,
  type DeskHistoryOp,
} from "./useDeskHistory";

const entry = (id: string): DeskHistoryEntry => ({
  artifactId: id,
  artifactType: "sticky_note",
  payload: { text: `note-${id}` },
  layout: { kind: "sticky_note", x: 1, y: 2, rot: 0 },
});

const place = (id: string): DeskHistoryOp => ({ type: "place", entry: entry(id) });

describe("desk history stacks", () => {
  it("starts empty with both flags false", () => {
    const stacks = emptyStacks();
    expect(canUndo(stacks)).toBe(false);
    expect(canRedo(stacks)).toBe(false);
  });

  it("push enables undo and clears the redo branch", () => {
    let stacks = emptyStacks();
    stacks = pushOp(stacks, place("a"));
    const undone = takeUndo(stacks);
    expect(undone.op?.type).toBe("place");
    stacks = pushOp(undone.stacks, place("b"));
    expect(canUndo(stacks)).toBe(true);
    expect(canRedo(stacks)).toBe(false);
    expect(stacks.past).toHaveLength(1);
  });

  it("undo moves the op to the future stack; redo moves it back", () => {
    let stacks = pushOp(emptyStacks(), place("a"));
    const undone = takeUndo(stacks);
    expect(undone.op).toEqual(place("a"));
    expect(canUndo(undone.stacks)).toBe(false);
    expect(canRedo(undone.stacks)).toBe(true);
    const redone = takeRedo(undone.stacks);
    expect(redone.op).toEqual(place("a"));
    expect(canUndo(redone.stacks)).toBe(true);
    expect(canRedo(redone.stacks)).toBe(false);
  });

  it("caps the past stack at HISTORY_CAP and drops the oldest", () => {
    let stacks = emptyStacks();
    for (let i = 0; i < HISTORY_CAP + 10; i += 1) stacks = pushOp(stacks, place(`op-${i}`));
    expect(stacks.past).toHaveLength(HISTORY_CAP);
    expect((stacks.past[0] as { entry: DeskHistoryEntry }).entry.artifactId).toBe("op-10");
  });

  it("undo on empty stacks is a no-op", () => {
    const stacks = emptyStacks();
    const taken = takeUndo(stacks);
    expect(taken.op).toBeUndefined();
    expect(taken.stacks).toBe(stacks);
  });

  it("redo on empty future is a no-op", () => {
    const stacks = pushOp(emptyStacks(), place("a"));
    const taken = takeRedo(stacks);
    expect(taken.op).toBeUndefined();
    expect(taken.stacks).toBe(stacks);
  });

  it("keeps full restore data for remove ops (same-id rebuild contract)", () => {
    const remove: DeskHistoryOp = {
      type: "remove",
      entry: {
        artifactId: "dead-beef",
        artifactType: "canvas_image",
        payload: { file_id: "file-1" },
        inputRefs: [{ file_id: "file-1" }],
        layout: { kind: "canvas_image", x: 5, y: 6, rot: 0, w: 240 },
      },
    };
    const stacks = pushOp(emptyStacks(), remove);
    const taken = takeUndo(stacks);
    expect(taken.op).toEqual(remove);
  });

  it("fill_version keeps from/to payload for same-card undo", () => {
    const fill: DeskHistoryOp = {
      type: "fill_version",
      artifactId: "img-1",
      from: { payload: {} },
      to: { payload: { file_id: "f1" }, inputRefs: [{ file_id: "f1" }] },
    };
    const stacks = pushOp(emptyStacks(), fill);
    const taken = takeUndo(stacks);
    expect(taken.op).toEqual(fill);
    expect(canRedo(taken.stacks)).toBe(true);
  });
});
