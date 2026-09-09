import { afterEach, describe, expect, it, vi } from "vitest";
import { agentTimeout } from "../src/core/agentTimeout.js";

afterEach(() => { vi.useRealTimers(); });

describe("agent timeout policy", () => {
  it("pauses idle detection for concurrent tools and restarts after the last result", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeout = agentTimeout(controller, 0, 1000);
    timeout.toolStarted("a");
    timeout.toolStarted("a");
    timeout.toolStarted("b");
    vi.advanceTimersByTime(5000);
    timeout.activity();
    timeout.toolFinished("a");
    timeout.toolFinished("a");
    timeout.toolStarted("a"); // A duplicate snapshot cannot reopen a completed call.
    vi.advanceTimersByTime(5000);
    expect(controller.signal.aborted).toBe(false);
    timeout.toolFinished("b");
    vi.advanceTimersByTime(999);
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(controller.signal.aborted).toBe(true);
  });

  it("keeps the total limit and manual stop effective during silent tools", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeout = agentTimeout(controller, 2000, 1000);
    timeout.toolStarted("command");
    vi.advanceTimersByTime(2000);
    expect(controller.signal.reason).toMatchObject({ message: expect.stringContaining("total time limit") });
    const manual = new AbortController();
    agentTimeout(manual, 0, 1000).toolStarted("command");
    manual.abort(new Error("Stopped"));
    expect(manual.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows an active turn to outlast the idle limit, then aborts on silence", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeout = agentTimeout(controller, 0, 1000);
    for (let index = 0; index < 10; index++) {
      vi.advanceTimersByTime(750);
      timeout.activity();
      expect(controller.signal.aborted).toBe(false);
    }
    vi.advanceTimersByTime(999);
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(controller.signal.reason).toMatchObject({ message: expect.stringContaining("without process activity") });
    expect(vi.getTimerCount()).toBe(0);
    timeout.activity();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces an explicit total limit despite continuing output", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeout = agentTimeout(controller, 2000, 1000);
    for (let index = 0; index < 3; index++) {
      vi.advanceTimersByTime(600);
      timeout.activity();
    }
    vi.advanceTimersByTime(200);
    expect(controller.signal.reason).toMatchObject({ message: expect.stringContaining("total time limit") });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets zero disable both automatic limits without disabling manual cancellation", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    agentTimeout(controller, 0, 0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(24 * 3600_000);
    expect(controller.signal.aborted).toBe(false);
    controller.abort(new Error("Stopped by user"));
    expect(controller.signal.reason).toMatchObject({ message: "Stopped by user" });
  });

  it("releases timers on completion and ignores late output", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeout = agentTimeout(controller, 2000, 1000);
    timeout.dispose();
    timeout.activity();
    vi.advanceTimersByTime(3000);
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let another concurrent turn's output postpone a silent turn", () => {
    vi.useFakeTimers();
    const active = new AbortController(), silent = new AbortController();
    const timeout = agentTimeout(active, 0, 1000);
    agentTimeout(silent, 0, 1000);
    vi.advanceTimersByTime(750);
    timeout.activity();
    vi.advanceTimersByTime(250);
    expect(silent.signal.aborted).toBe(true);
    expect(active.signal.aborted).toBe(false);
    timeout.dispose();
  });
});
