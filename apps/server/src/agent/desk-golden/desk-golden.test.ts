import { describe, expect, it } from "vitest";
import { assertGoldenExpect, loadGoldenTasks, runGoldenTask } from "./run.js";

const tasks = loadGoldenTasks();

describe("desk golden tasks (L-A fixtures)", () => {
  it("loads GT fixtures from disk", () => {
    expect(tasks.length).toBeGreaterThanOrEqual(10);
    expect(tasks.map((t) => t.id)).toContain("GT-01");
    expect(tasks.map((t) => t.id)).toContain("GT-17");
  });

  for (const task of tasks) {
    it(`${task.id} ${task.title}`, () => {
      const result = runGoldenTask(task);
      assertGoldenExpect(task, result);
    });
  }
});
