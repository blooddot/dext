import type { WebviewRequest, WebviewResponse } from "../webviewProtocol.js";

export interface ClipboardReadResult {
  text: string;
  contextAttached: boolean;
  codeReference?: { expression: string; payload: string };
  fileReferences?: Array<{ expression: string; payload: string }>;
}

interface PendingWrite {
  kind: "write";
  resolve(value: boolean): void;
}

interface PendingRead {
  kind: "read";
  resolve(value: ClipboardReadResult | undefined): void;
}

type PendingClipboardRequest = PendingWrite | PendingRead;

export class ClipboardClient {
  private nextRequestId = 0;
  private readonly pending = new Map<number, PendingClipboardRequest>();

  constructor(private readonly post: (request: WebviewRequest) => void) {}

  write(text: string): Promise<boolean> {
    const requestId = ++this.nextRequestId;
    const result = new Promise<boolean>((resolve) => this.pending.set(requestId, { kind: "write", resolve }));
    this.post({ type: "clipboardWrite", requestId, text });
    return result;
  }

  read(purpose: "code" | "text"): Promise<ClipboardReadResult | undefined> {
    const requestId = ++this.nextRequestId;
    const result = new Promise<ClipboardReadResult | undefined>((resolve) => {
      this.pending.set(requestId, { kind: "read", resolve });
    });
    this.post({ type: "clipboardRead", requestId, purpose });
    return result;
  }

  accept(response: WebviewResponse): boolean {
    if (response.type !== "clipboardWriteResult" && response.type !== "clipboardReadResult") {
      return false;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending) return true;
    this.pending.delete(response.requestId);
    if (response.type === "clipboardWriteResult" && pending.kind === "write") {
      pending.resolve(response.success);
    } else if (response.type === "clipboardReadResult" && pending.kind === "read") {
      pending.resolve(response.success
        ? {
            text: response.text,
            contextAttached: response.contextAttached,
            ...(response.codeReference ? { codeReference: response.codeReference } : {}),
            ...(response.fileReferences ? { fileReferences: response.fileReferences } : {})
          }
        : undefined);
    }
    return true;
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      if (pending.kind === "write") pending.resolve(false);
      else pending.resolve(undefined);
    }
    this.pending.clear();
  }
}
