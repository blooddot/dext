import { describe, expect, it } from "vitest";
import type { WebviewRequest, WebviewResponse } from "../src/webviewProtocol.js";
import {
  LanguageRequestBroker,
  sourceSnapshotMatches
} from "../src/webview/languageClient.js";

class Cancellation {
  isCancellationRequested = false;
  private listener: (() => void) | undefined;

  onCancellationRequested(listener: () => void): { dispose(): void } {
    this.listener = listener;
    return { dispose: () => { this.listener = undefined; } };
  }

  cancel(): void {
    this.isCancellationRequested = true;
    this.listener?.();
  }
}

function languageResponse(requestId: number): WebviewResponse {
  return { type: "language", requestId, completions: [], diagnostics: [] };
}

describe("Webview language request broker", () => {
  it("routes out-of-order responses to their matching requests", async () => {
    const requests: WebviewRequest[] = [];
    const broker = new LanguageRequestBroker((request) => requests.push(request));
    const first = broker.request("core.", 5);
    const second = broker.request("core.code.", 10);
    const firstId = requests[0]?.type === "language" ? requests[0].requestId : -1;
    const secondId = requests[1]?.type === "language" ? requests[1].requestId : -1;

    expect(broker.accept(languageResponse(secondId))).toBe(true);
    expect((await second)?.requestId).toBe(secondId);
    expect(broker.accept(languageResponse(firstId))).toBe(true);
    expect((await first)?.requestId).toBe(firstId);
  });

  it("cancels a provider request and ignores its late response", async () => {
    const requests: WebviewRequest[] = [];
    const cancellation = new Cancellation();
    const broker = new LanguageRequestBroker((request) => requests.push(request));
    const response = broker.request("core.", 5, cancellation);
    const requestId = requests[0]?.type === "language" ? requests[0].requestId : -1;

    cancellation.cancel();
    expect(await response).toBeUndefined();
    expect(broker.accept(languageResponse(requestId))).toBe(false);
  });

  it("rejects an outdated source snapshot", () => {
    expect(sourceSnapshotMatches("core.code.review(", "core.code.review(")).toBe(true);
    expect(sourceSnapshotMatches("core.code.review(target: ", "core.code.review(")).toBe(false);
  });
});
