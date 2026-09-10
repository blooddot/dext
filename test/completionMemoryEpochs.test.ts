import { EventEmitter } from "node:events";
import type * as Fs from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CompletionMemoryEpochs } from "../src/core/completionMemory.js";
import { fingerprint } from "../src/core/completionContext.js";

// Keep real disk reads and writes, but suppress OS notifications so recovery
// from missing watcher events is deterministic on every platform.
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof Fs>(),
  watch: vi.fn(() => Object.assign(new EventEmitter(), { close: vi.fn() }))
}));

describe("completion memory epoch refresh", () => {
  it("observes another window's clears even when watcher notifications never arrive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dext-epoch-refresh-"));
    const first = new CompletionMemoryEpochs(directory);
    const second = new CompletionMemoryEpochs(directory);
    const changed = vi.fn();
    second.onChange(changed);
    try {
      await first.prepare("root");
      await second.prepare("root");
      expect(second.current("root")).toBe(first.current("root"));
      expect(second.current("root")).toBeDefined();
      for (let round = 0; round < 3; round++) {
        const before = second.current("root");
        const cleared = await first.clear("root");
        await second.prepare("root");
        expect(second.current("root")).toBe(cleared);
        expect(second.current("root")).not.toBe(before);
      }
      expect(changed).toHaveBeenCalledTimes(3);
      await second.prepare("root");
      expect(changed).toHaveBeenCalledTimes(3);
    } finally {
      first.dispose(); second.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["invalid", "x".repeat(129)])("invalidates corrupt cached epochs and recovers (%s)", async (content) => {
    const directory = await mkdtemp(join(tmpdir(), "dext-epoch-corrupt-"));
    const epochs = new CompletionMemoryEpochs(directory);
    const changed = vi.fn();
    epochs.onChange(changed);
    try {
      await epochs.prepare("root");
      expect(epochs.current("root")).toBeDefined();
      const path = join(directory, fingerprint("root") + ".epoch");
      await writeFile(path, content);
      await epochs.prepare("root");
      expect(epochs.current("root")).toBeUndefined();
      expect(changed).toHaveBeenCalledTimes(1);
      const restored = randomUUID();
      await writeFile(path, restored);
      await epochs.prepare("root");
      expect(epochs.current("root")).toBe(restored);
    } finally {
      epochs.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
