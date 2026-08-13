import { describe, expect, it } from "vitest";
import type { WebviewRequest } from "../src/webviewProtocol.js";
import { ClipboardClient } from "../src/webview/clipboardClient.js";

describe("ClipboardClient", () => {
  it("matches Host write acknowledgements to their request", async () => {
    const requests: WebviewRequest[] = [];
    const client = new ClipboardClient((request) => requests.push(request));
    const written = client.write("selected code");
    const request = requests[0];
    expect(request?.type).toBe("clipboardWrite");
    const requestId = request?.type === "clipboardWrite" ? request.requestId : -1;

    expect(client.accept({ type: "clipboardWriteResult", requestId, success: true })).toBe(true);
    await expect(written).resolves.toBe(true);
  });

  it("returns ordinary text from Host reads", async () => {
    const requests: WebviewRequest[] = [];
    const client = new ClipboardClient((request) => requests.push(request));
    const read = client.read("code");
    const request = requests[0];
    const requestId = request?.type === "clipboardRead" ? request.requestId : -1;

    expect(request).toMatchObject({ type: "clipboardRead", purpose: "code" });
    client.accept({
      type: "clipboardReadResult",
      requestId,
      success: true,
      text: "selected code",
      contextAttached: false
    });
    await expect(read).resolves.toEqual({ text: "selected code", contextAttached: false });
  });

  it("returns a structured Code reference without exposing staged source text", async () => {
    const requests: WebviewRequest[] = [];
    const client = new ClipboardClient((request) => requests.push(request));
    const read = client.read("code");
    const request = requests[0];
    const requestId = request?.type === "clipboardRead" ? request.requestId : -1;

    client.accept({
      type: "clipboardReadResult",
      requestId,
      success: true,
      text: 'ref.file("src/extension.ts#L1,1-L1,2")',
      contextAttached: false,
      codeReference: {
        expression: 'ref.file("src/extension.ts#L1,1-L1,2")',
        payload: "src/extension.ts#L1,1-L1,2"
      }
    });

    await expect(read).resolves.toEqual({
      text: 'ref.file("src/extension.ts#L1,1-L1,2")',
      contextAttached: false,
      codeReference: {
        expression: 'ref.file("src/extension.ts#L1,1-L1,2")',
        payload: "src/extension.ts#L1,1-L1,2"
      }
    });
  });

  it("settles outstanding requests when the Webview unloads", async () => {
    const client = new ClipboardClient(() => undefined);
    const write = client.write("text");
    const read = client.read("code");
    client.dispose();

    await expect(write).resolves.toBe(false);
    await expect(read).resolves.toBeUndefined();
  });
});
