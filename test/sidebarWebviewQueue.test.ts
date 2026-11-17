import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) }
}));

import { DextSidebarProvider } from "../src/app/sidebarProvider.js";
import { ReadyMessageQueue } from "../src/shared/lib/readyMessageQueue.js";
import type { WebviewResponse } from "../src/platform/webviewProtocol.js";

const reference: WebviewResponse = {
  type: "insertFileReferences",
  expressions: ["@file:///c%3A/Users/TU/notes.md#L2,1-L4,3"]
};

/** A provider with only what a host message needs, plus a Webview that answers
 * `postMessage` the way VS Code does for a hidden view (no live document). */
function harness(postMessage: (message: WebviewResponse) => Promise<boolean>) {
  const sidebar = Object.create(DextSidebarProvider.prototype) as {
    messageQueue: ReadyMessageQueue<WebviewResponse>;
    view: { webview: { postMessage(message: WebviewResponse): Promise<boolean> } };
    postWhenReady(message: WebviewResponse): void;
  };
  const messageQueue = new ReadyMessageQueue<WebviewResponse>();
  messageQueue.markReady();
  sidebar.messageQueue = messageQueue;
  sidebar.view = { webview: { postMessage } };
  return { sidebar, messageQueue };
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("host messages to a Webview without a live document", () => {
  it("keeps an Add to Dext reference for the next ready instead of dropping it", async () => {
    const postMessage = vi.fn(async () => false);
    const { sidebar, messageQueue } = harness(postMessage);

    sidebar.postWhenReady(reference);
    await settled();

    expect(postMessage).toHaveBeenCalledOnce();
    expect(messageQueue.markReady()).toEqual([reference]);
  });

  it("does not keep a message the Webview received", async () => {
    const postMessage = vi.fn(async () => true);
    const { sidebar, messageQueue } = harness(postMessage);

    sidebar.postWhenReady(reference);
    await settled();

    expect(postMessage).toHaveBeenCalledOnce();
    expect(messageQueue.markReady()).toEqual([]);
  });
});
