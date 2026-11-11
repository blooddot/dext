import { beforeEach, describe, expect, it, vi } from "vitest";
import { DextStorage, referencedAttachmentNames } from "../src/platform/vscode/dextStorage.js";

const storageState = vi.hoisted(() => ({ attachments: new Map<string, number>(), deleted: [] as string[] }));

vi.mock("vscode", () => ({
  FileType: { File: 1, Directory: 2 },
  FileSystemError: class extends Error { code = ""; },
  Uri: {
    parse: (value: string) => ({ scheme: value.split(":")[0] }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => {
      const fsPath = [base.fsPath, ...parts].join("/");
      return { fsPath, path: fsPath, toString: () => `file://${fsPath}` };
    }
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    fs: {
      readDirectory: async () => [...storageState.attachments.keys()].map((fsPath) => [fsPath.split("/").at(-1), 1]),
      stat: async (uri: { fsPath: string }) => ({ type: 1, mtime: storageState.attachments.get(uri.fsPath) ?? 0, ctime: 0, size: 0 }),
      delete: async (uri: { fsPath: string }) => {
        storageState.attachments.delete(uri.fsPath);
        storageState.deleted.push(uri.fsPath);
      }
    }
  }
}));

const storage = new DextStorage({ fsPath: "/store" } as never);

beforeEach(() => {
  storageState.attachments.clear();
  storageState.deleted.length = 0;
});
const transcript = `conversation-${"a".repeat(24)}.md`;

describe("Dext storage attachments", () => {
  it("hands an agent the path of a History transcript saved as an attachment", () => {
    expect(storage.attachmentPrompt(`Explain @.dext-global/attachments/${transcript}`))
      .toContain(`- /store/attachments/${transcript}`);
  });

  it("leaves a file name Dext never writes as ordinary text", () => {
    expect(storage.attachmentPrompt("@.dext-global/attachments/notes.md")).not.toContain("Dext attachment files");
  });

  it("hands an agent the path of a pasted video attachment", () => {
    const clip = `${"b".repeat(24)}.mp4`;
    expect(storage.attachmentPrompt(`What goes wrong in @.dext-global/attachments/${clip}?`))
      .toContain(`- /store/attachments/${clip}`);
  });

  it("tells an agent which tool decodes a video, and only for a video", () => {
    const clip = `${"c".repeat(24)}.mp4`;
    const still = `${"d".repeat(24)}.png`;
    expect(storage.attachmentPrompt(`@.dext-global/attachments/${clip}`)).toContain("dext_video_frames");
    expect(storage.attachmentPrompt(`@.dext-global/attachments/${still}`)).not.toContain("dext_video_frames");
  });
});

describe("Dext attachment pruning", () => {
  it("keeps an old attachment that saved history still references", async () => {
    const oldest = `${"1".repeat(24)}.png`;
    const middle = `${"2".repeat(24)}.png`;
    const newest = `${"3".repeat(24)}.png`;
    storageState.attachments.set(`/store/attachments/${oldest}`, 1);
    storageState.attachments.set(`/store/attachments/${middle}`, 2);
    storageState.attachments.set(`/store/attachments/${newest}`, 3);

    await storage.pruneAttachments(2, undefined, () => referencedAttachmentNames(`![shot](@.dext-global/attachments/${oldest})`));

    expect(storageState.deleted).toEqual([`/store/attachments/${middle}`]);
    expect([...storageState.attachments.keys()]).toEqual([`/store/attachments/${oldest}`, `/store/attachments/${newest}`]);
  });

  it("deletes the oldest attachment when nothing references it", async () => {
    const oldest = `terminal-${"4".repeat(24)}.log`;
    const newest = `terminal-${"5".repeat(24)}.log`;
    storageState.attachments.set(`/store/attachments/${oldest}`, 1);
    storageState.attachments.set(`/store/attachments/${newest}`, 2);

    await storage.pruneAttachments(1);

    expect(storageState.deleted).toEqual([`/store/attachments/${oldest}`]);
  });
});
