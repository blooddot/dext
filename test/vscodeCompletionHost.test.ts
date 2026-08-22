import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCompletionSettings, type CompletionSettings } from "../src/core/completionProvider.js";
import type * as CompletionHostModule from "../src/vscodeCompletionHost.js";

const state = vi.hoisted(() => ({
  ignoreFiles: new Map<string, string>(),
  statusItems: [] as { text: string; command: string | undefined; shown: number; hidden: number }[],
  messages: [] as string[],
  commands: [] as string[]
}));

vi.mock("vscode", () => {
  class Position {
    constructor(readonly line: number, readonly character: number) {}
  }
  class Range {
    constructor(readonly start: Position, readonly end: Position) {}
  }
  class InlineCompletionItem {
    constructor(readonly insertText: string, readonly range: Range) {}
  }
  return {
    Position,
    Range,
    InlineCompletionItem,
    StatusBarAlignment: { Right: 2 },
    window: {
      createStatusBarItem: () => {
        const item = {
          text: "",
          tooltip: "",
          command: undefined as string | undefined,
          shown: 0,
          hidden: 0,
          show() { this.shown += 1; },
          hide() { this.hidden += 1; },
          dispose() { /* nothing to release in the test double */ }
        };
        state.statusItems.push(item);
        return item;
      },
      showInformationMessage: (message: string) => {
        state.messages.push(message);
        return Promise.resolve(undefined);
      },
      showWarningMessage: (message: string) => {
        state.messages.push(message);
        return Promise.resolve(undefined);
      }
    },
    workspace: {
      getWorkspaceFolder: () => ({ uri: { path: "/repo" } }),
      asRelativePath: (uri: { path: string }) => uri.path.replace(/^\/repo\//, ""),
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
      fs: {
        readFile: async (uri: { path: string }) => {
          const content = state.ignoreFiles.get(uri.path.split("/").pop() ?? "");
          if (content === undefined) throw new Error("not found");
          return new TextEncoder().encode(content);
        }
      }
    },
    commands: {
      executeCommand: (command: string) => {
        state.commands.push(command);
        return Promise.resolve(undefined);
      }
    },
    Uri: {
      joinPath: (base: { path: string }, ...segments: string[]) => ({ path: [base.path, ...segments].join("/") })
    }
  };
});

let DextCompletionHost: typeof CompletionHostModule.DextCompletionHost;

function settings(overrides: Partial<CompletionSettings> = {}): CompletionSettings {
  return normalizeCompletionSettings({
    enabled: true,
    endpoint: "https://models.example/v1",
    model: "small-fim",
    debounceMs: 1,
    ...overrides
  });
}

function document(text: string, options: { path?: string; languageId?: string; scheme?: string } = {}) {
  return {
    uri: { scheme: options.scheme ?? "file", path: options.path ?? "/repo/src/app.ts" },
    languageId: options.languageId ?? "typescript",
    getText: () => text,
    offsetAt: () => text.length
  } as never;
}

const position = { line: 0, character: 0 } as never;
const context = {} as never;

function cancellation(cancelled = false) {
  return { isCancellationRequested: cancelled, onCancellationRequested: () => undefined } as never;
}

describe("inline completion host", () => {
  beforeAll(async () => {
    ({ DextCompletionHost } = await import("../src/vscodeCompletionHost.js"));
  });

  beforeEach(() => {
    state.ignoreFiles.clear();
    state.statusItems.length = 0;
    state.messages.length = 0;
    state.commands.length = 0;
    vi.unstubAllGlobals();
  });

  function host(overrides: Partial<CompletionSettings> = {}) {
    return new DextCompletionHost({
      settings: () => settings(overrides),
      apiKey: async () => "key"
    });
  }

  it("asks the model once per cursor position and serves the rest from cache", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ text: "return 1;" }] })));
    vi.stubGlobal("fetch", fetchImpl);
    const provider = host();
    const first = await provider.provideInlineCompletionItems(
      document("const a = "), position, context, cancellation()
    );
    expect(first.map((item) => item.insertText)).toEqual(["return 1;"]);
    const second = await provider.provideInlineCompletionItems(
      document("const a = "), position, context, cancellation()
    );
    expect(second.map((item) => item.insertText)).toEqual(["return 1;"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it("waits on a generation already in flight instead of restarting it per keystroke", async () => {
    // The editor cancels the previous call on every keystroke. What matters is
    // that the request it started survives, because abandoning a nearly
    // finished generation and asking again is most of the wait.
    let release = (): void => undefined;
    let entered = (): void => undefined;
    const arrived = new Promise<void>((resolve) => { release = resolve; });
    const inFlight = new Promise<void>((resolve) => { entered = resolve; });
    const fetchImpl = vi.fn(async () => {
      entered();
      await arrived;
      return new Response(JSON.stringify({ choices: [{ text: "items.length" }] }));
    });
    vi.stubGlobal("fetch", fetchImpl);
    const provider = host();

    const first = provider.provideInlineCompletionItems(
      document("const total = "), position, context, cancellation()
    );
    await inFlight;
    // Two more characters typed while that request is still out.
    const second = provider.provideInlineCompletionItems(
      document("const total = i"), position, context, cancellation()
    );
    const third = provider.provideInlineCompletionItems(
      document("const total = it"), position, context, cancellation()
    );
    release();

    expect((await first).map((item) => item.insertText)).toEqual(["items.length"]);
    // Each keystroke gets what is left of the same answer, rather than its own.
    expect((await second).map((item) => item.insertText)).toEqual(["tems.length"]);
    expect((await third).map((item) => item.insertText)).toEqual(["ems.length"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it("abandons a generation once what was typed no longer matches it", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ text: "items.length" }] })));
    vi.stubGlobal("fetch", fetchImpl);
    const provider = host();
    await provider.provideInlineCompletionItems(
      document("const total = "), position, context, cancellation()
    );
    // 'x' is not how the suggestion started, so reusing it would be wrong.
    await provider.provideInlineCompletionItems(
      document("const total = x"), position, context, cancellation()
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    provider.dispose();
  });

  it("keeps an answer that arrived after the editor gave up, rather than paying for it twice", async () => {
    // The editor abandons the call the moment the next key goes down, which
    // here happens while the model is answering. The generation it paid for
    // still answers the position it asked about.
    const token = { isCancellationRequested: false, onCancellationRequested: () => undefined };
    const fetchImpl = vi.fn(async () => {
      token.isCancellationRequested = true;
      return new Response(JSON.stringify({ choices: [{ text: "return 1;" }] }));
    });
    vi.stubGlobal("fetch", fetchImpl);
    const provider = host();
    expect(await provider.provideInlineCompletionItems(
      document("const a = "), position, context, token as never
    )).toEqual([]);
    expect(provider.report().outcome).toContain("kept for the next keystroke");

    expect((await provider.provideInlineCompletionItems(
      document("const a = "), position, context, cancellation()
    )).map((item) => item.insertText)).toEqual(["return 1;"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it("answers a rate limit by slowing down rather than by blaming the setup", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "Token 请求频率超限: 4 qps" } }),
      { status: 429 }
    ));
    vi.stubGlobal("fetch", fetchImpl);
    const provider = host();
    expect(await provider.provideInlineCompletionItems(
      document("const a = "), position, context, cancellation()
    )).toEqual([]);
    const notice = state.messages.at(-1) ?? "";
    expect(notice).toContain("4 qps");
    expect(notice).toContain("spacing its completion requests out");
    // Telling someone it will "keep trying quietly" while being refused for
    // trying too often is the wrong advice.
    expect(notice).not.toContain("keep trying quietly");
    provider.dispose();
  });

  it("reads the API key once rather than on every keystroke", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ text: "x" }] })));
    vi.stubGlobal("fetch", fetchImpl);
    const apiKey = vi.fn(async () => "key");
    const provider = new DextCompletionHost({ settings: () => settings(), apiKey });
    await provider.provideInlineCompletionItems(document("const a = "), position, context, cancellation());
    await provider.provideInlineCompletionItems(document("const b = "), position, context, cancellation());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Secret storage is the OS keychain, which is far too slow to ask per key.
    expect(apiKey).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it("does not reach the network when the request is already superseded", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ text: "x" }] })));
    vi.stubGlobal("fetch", fetchImpl);
    const provider = host();
    // The keystroke that asked for this was replaced while the debounce ran.
    expect(await provider.provideInlineCompletionItems(
      document("const a = "), position, context, cancellation(true)
    )).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("stays out of files the workspace excludes, with .dextignore able to add and re-include", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ text: "x" }] })));
    vi.stubGlobal("fetch", fetchImpl);
    state.ignoreFiles.set(".gitignore", "dist/\n");
    state.ignoreFiles.set(".dextignore", "*.secret.ts\n!dist/keep.ts\n");
    const provider = host();
    expect(await provider.provideInlineCompletionItems(
      document("const a = ", { path: "/repo/dist/bundle.ts" }), position, context, cancellation()
    )).toEqual([]);
    expect(await provider.provideInlineCompletionItems(
      document("const a = ", { path: "/repo/src/api.secret.ts" }), position, context, cancellation()
    )).toEqual([]);
    // `.dextignore` is read last, so it can bring a file back that .gitignore
    // excluded.
    expect(await provider.provideInlineCompletionItems(
      document("const a = ", { path: "/repo/dist/keep.ts" }), position, context, cancellation()
    )).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it("honors .dextignore alone when .gitignore is turned off", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ text: "x" }] })));
    state.ignoreFiles.set(".gitignore", "dist/\n");
    state.ignoreFiles.set(".dextignore", "vendor/\n");
    const provider = host({ ignoreGitignore: false });
    expect(await provider.provideInlineCompletionItems(
      document("const a = ", { path: "/repo/dist/bundle.ts" }), position, context, cancellation()
    )).toHaveLength(1);
    expect(await provider.provideInlineCompletionItems(
      document("const a = ", { path: "/repo/vendor/lib.ts" }), position, context, cancellation()
    )).toEqual([]);
    provider.dispose();
  });

  it("leaves .dx files to the typed API provider and skips non-file documents", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ text: "x" }] })));
    vi.stubGlobal("fetch", fetchImpl);
    const provider = host();
    expect(await provider.provideInlineCompletionItems(
      document("ask(", { languageId: "dext-api" }), position, context, cancellation()
    )).toEqual([]);
    expect(await provider.provideInlineCompletionItems(
      document("const a = ", { scheme: "untitled" }), position, context, cancellation()
    )).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("records which gate stopped it, so a silent provider can be diagnosed", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ text: "return 1;" }] })));
    const provider = host();
    // Nothing has asked yet, which is the fact that rules Dext out entirely.
    expect(provider.report()).toMatchObject({ invocations: 0, outcome: "never asked for a completion" });

    await provider.provideInlineCompletionItems(document("const a = "), position, context, cancellation());
    expect(provider.report()).toMatchObject({ invocations: 1, outcome: "offered a completion" });

    await provider.provideInlineCompletionItems(
      document("ask(", { languageId: "dext-api" }), position, context, cancellation()
    );
    expect(provider.report().outcome).toContain("typed API provider");

    await provider.provideInlineCompletionItems(
      document("const a = ", { scheme: "untitled" }), position, context, cancellation()
    );
    expect(provider.report().outcome).toContain("scheme is 'untitled'");

    provider.toggle();
    await provider.provideInlineCompletionItems(document("const b = "), position, context, cancellation());
    expect(provider.report().outcome).toContain("switched off for this window");
    expect(provider.report().invocations).toBe(4);
    provider.dispose();
  });

  it("tells a timed-out request apart from a model with nothing to add", async () => {
    // Both come back from `complete` as an empty string, which is right for a
    // keystroke and useless for a diagnosis. Reporting a timeout as "nothing to
    // insert" is what sent an earlier investigation after the wrong cause.
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const slow = host({ timeoutMs: 5 });
    expect(await slow.provideInlineCompletionItems(
      document("const a = "), position, context, cancellation()
    )).toEqual([]);
    expect(slow.report().outcome).toContain("did not answer within 5ms");
    slow.dispose();

    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ text: "" }] })));
    const quiet = host();
    await quiet.provideInlineCompletionItems(document("const a = "), position, context, cancellation());
    expect(quiet.report().outcome).toBe("the model answered with nothing to insert");
    quiet.dispose();
  });

  it("does not cache a failure, so one outage cannot poison a position", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("upstream is down", { status: 502 })
        : new Response(JSON.stringify({ choices: [{ text: "return 1;" }] }));
    });
    const provider = host();
    expect(await provider.provideInlineCompletionItems(
      document("const a = "), position, context, cancellation()
    )).toEqual([]);
    // The same position is asked again rather than served the earlier nothing.
    expect(await provider.provideInlineCompletionItems(
      document("const a = "), position, context, cancellation()
    )).toHaveLength(1);
    expect(attempts).toBe(2);
    provider.dispose();
  });

  it("keeps a status bar entry point whether or not the backend is configured", async () => {
    const configured = host();
    const item = state.statusItems.at(-1)!;
    expect(item.command).toBe("dext.completionMenu");
    expect(item.text).toContain("Dext");
    expect(item.shown).toBe(1);
    // Turning it off for the window stops completing without touching settings.
    configured.toggle();
    expect(item.text).toContain("circle-slash");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ text: "x" }] })));
    expect(await configured.provideInlineCompletionItems(
      document("const a = "), position, context, cancellation()
    )).toEqual([]);
    configured.toggle();
    expect(await configured.provideInlineCompletionItems(
      document("const a = "), position, context, cancellation()
    )).toHaveLength(1);
    configured.dispose();

    // An unconfigured backend still shows the item: it is the way into the setup
    // wizard, and hiding it left a first-time user with nothing to click.
    state.statusItems.length = 0;
    const unconfigured = new DextCompletionHost({
      settings: () => normalizeCompletionSettings({ enabled: true }),
      apiKey: async () => undefined
    });
    const dormant = state.statusItems.at(-1)!;
    expect(dormant.shown).toBe(1);
    expect(dormant.text).toContain("off");
    expect(dormant.command).toBe("dext.completionMenu");
    // Nothing to toggle yet, so the switch leads to configuration instead.
    unconfigured.toggle();
    expect(state.commands).toEqual(["dext.configureCompletionModel"]);
    unconfigured.dispose();
  });
});
