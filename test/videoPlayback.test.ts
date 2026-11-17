import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DextStorage } from "../src/platform/vscode/dextStorage.js";

/** One fake FFmpeg: the call's arguments in, whatever this test wants out. */
const spawned = vi.hoisted(() => ({
  calls: [] as string[][],
  fail: undefined as NodeJS.ErrnoException | undefined,
  code: 0,
  stderr: ""
}));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => {
    spawned.calls.push([command, ...args]);
    const listeners = new Map<string, ((...values: unknown[]) => void)[]>();
    let onStderr: ((chunk: Buffer) => void) | undefined;
    const child = {
      stderr: { on: (_event: string, listener: (chunk: Buffer) => void) => { onStderr = listener; } },
      once: (event: string, listener: (...values: unknown[]) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      emit: (event: string, ...values: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) listener(...values);
      }
    };
    void (async () => {
      // FFmpeg fails asynchronously; the caller's listeners are attached first.
      await Promise.resolve();
      if (spawned.stderr) onStderr?.(Buffer.from(spawned.stderr));
      if (spawned.fail) { child.emit("error", spawned.fail); return; }
      if (spawned.code === 0) {
        const { writeFile: write } = await import("node:fs/promises");
        await write(args.at(-1) ?? "", "converted");
      }
      child.emit("close", spawned.code);
    })();
    return child;
  }
}));

vi.mock("vscode", () => ({
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: join(base.fsPath, ...parts) }) }
}));

import { cachedVideo, playableVideo, videoCache } from "../src/features/conversations/host/videoPlayback.js";

describe("a video the editor cannot decode", () => {
  let root: string;
  let storage: DextStorage;
  const source = (): { fsPath: string } => ({ fsPath: join(root, "in.mp4") });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dext-video-"));
    storage = { globalStorageUri: { fsPath: root } } as unknown as DextStorage;
    await writeFile(source().fsPath, "hevc bytes");
    spawned.calls.length = 0;
    spawned.fail = undefined;
    spawned.code = 0;
    spawned.stderr = "";
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("converts once to H.264 and plays the copy from then on", async () => {
    const copy = await playableVideo(storage, source() as never);
    expect(copy.fsPath.startsWith(videoCache(storage).fsPath)).toBe(true);
    expect(await readFile(copy.fsPath, "utf8")).toBe("converted");
    // Same file, same copy: watching a video again does not convert it again.
    expect((await playableVideo(storage, source() as never)).fsPath).toBe(copy.fsPath);
    expect(spawned.calls).toHaveLength(1);
    const args = spawned.calls[0] ?? [];
    expect(args[0]).toBe("ffmpeg");
    expect(args).toContain("libx264");
    expect(args[args.indexOf("-i") + 1]).toBe(source().fsPath);
  });

  it("tells the reader how to install FFmpeg when it is not there", async () => {
    spawned.fail = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    await expect(playableVideo(storage, source() as never)).rejects.toThrow(/winget install Gyan\.FFmpeg/);
  });

  it("keeps nothing from a conversion that failed", async () => {
    spawned.code = 1;
    spawned.stderr = "Invalid data found when processing input\n";
    await expect(playableVideo(storage, source() as never)).rejects.toThrow(/Invalid data found/);
    // A half-written copy would be played as if it were the whole video.
    expect(await readdir(videoCache(storage).fsPath)).toEqual([]);
  });

  it("drops the oldest copies instead of growing forever", async () => {
    const cache = videoCache(storage).fsPath;
    await mkdir(cache, { recursive: true });
    const day = 24 * 60 * 60 * 1000;
    for (const [index, name] of ["a.mp4", "b.mp4", "c.mp4", "d.mp4"].entries()) {
      await writeFile(join(cache, name), "old");
      const at = new Date(Date.now() - (10 - index) * day);
      await utimes(join(cache, name), at, at);
    }
    await playableVideo(storage, source() as never);
    const left = (await readdir(cache)).sort();
    expect(left).toHaveLength(3);
    expect(left).not.toContain("a.mp4");
    expect(left).toContain("d.mp4");
  });

  it("offers a caller that cannot convert only a copy that already exists", async () => {
    // An agent asking for stills must not silently start an encode.
    expect(await cachedVideo(storage, source() as never)).toBeUndefined();
    const copy = await playableVideo(storage, source() as never);
    expect((await cachedVideo(storage, source() as never))?.fsPath).toBe(copy.fsPath);
    expect(spawned.calls).toHaveLength(1);
  });
});
