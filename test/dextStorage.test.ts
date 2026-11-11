import { describe, expect, it, vi } from "vitest";
import { DextStorage } from "../src/platform/vscode/dextStorage.js";

vi.mock("vscode", () => ({
  Uri: {
    parse: (value: string) => ({ scheme: value.split(":")[0] }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join("/") })
  },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) }
}));

const storage = new DextStorage({ fsPath: "/store" } as never);
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
