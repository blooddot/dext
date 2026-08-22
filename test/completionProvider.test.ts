import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CompletionCache,
  CompletionClient,
  CompletionKeyStore,
  DEFAULT_ENDPOINTS,
  completionWindow,
  endpointFor,
  isChatApi,
  normalizeCompletionSettings,
  requiresApiKey,
  stripCodeFence,
  trimCompletion,
  type CompletionFetch,
  type CompletionSettings
} from "../src/core/completionProvider.js";
import { isIgnored, parseIgnoreRules } from "../src/core/ignoreRules.js";

const settings = (overrides: Partial<CompletionSettings> = {}): CompletionSettings =>
  normalizeCompletionSettings({
    enabled: true,
    endpoint: "https://models.example/v1",
    model: "small-fim",
    ...overrides
  });

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("completion model backend", () => {
  it("stays off until an endpoint and a model are both configured", () => {
    expect(normalizeCompletionSettings({ enabled: true }).enabled).toBe(false);
    expect(normalizeCompletionSettings({ enabled: true, endpoint: "https://x/v1" }).enabled).toBe(false);
    expect(settings().enabled).toBe(true);
    // A nonsense value falls back rather than breaking every keystroke.
    expect(settings({ maxTokens: -5 }).maxTokens).toBe(64);
    expect(settings({ debounceMs: 0 }).debounceMs).toBe(200);
    // Ceilings keep a typo from turning a completion into a full generation.
    expect(settings({ maxTokens: 1_000_000 }).maxTokens).toBe(2048);
    expect(settings({ api: "ollama" }).api).toBe("ollama");
    expect(settings({ api: "whatever" as never }).api).toBe("openai");
  });

  it("speaks the OpenAI-compatible fill-in-the-middle shape and sends the key as a bearer", async () => {
    const fetchImpl = vi.fn<CompletionFetch>(async () => jsonResponse({ choices: [{ text: "return 1;" }] }));
    const client = new CompletionClient(fetchImpl);
    const completion = await client.complete(
      settings(),
      { prefix: "function one() {\n  ", suffix: "\n}" },
      "secret-key"
    );
    expect(completion).toBe("return 1;");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://models.example/v1/completions");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer secret-key");
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({ model: "small-fim", prompt: "function one() {\n  ", suffix: "\n}", stream: false });
    expect(sent.max_tokens).toBe(64);
    // Left to run to max_tokens the model keeps going into whatever follows,
    // which is slow and produces a second copy of the next function.
    expect(sent.stop).toEqual(["\n\n"]);
  });

  it("speaks Ollama's generate shape when that API is selected", async () => {
    const fetchImpl = vi.fn<CompletionFetch>(async () => jsonResponse({ response: "return 1;" }));
    const client = new CompletionClient(fetchImpl);
    const completion = await client.complete(
      settings({ api: "ollama", endpoint: "http://localhost:11434" }),
      { prefix: "a", suffix: "b" }
    );
    expect(completion).toBe("return 1;");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://localhost:11434/api/generate");
    // No key configured means no Authorization header at all.
    expect(new Headers(init.headers).get("Authorization")).toBeNull();
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "small-fim",
      prompt: "a",
      suffix: "b",
      options: { num_predict: 64, stop: ["\n\n"] }
    });
  });

  it("stays silent on failure and reports a real outage once", async () => {
    const errors: string[] = [];
    const failing = new CompletionClient(async () => jsonResponse({}, 500), (message) => errors.push(message));
    expect(await failing.complete(settings(), { prefix: "a", suffix: "" })).toBe("");
    expect(errors).toEqual(["The completion model returned HTTP 500."]);

    // A request cancelled by the next keystroke is normal, so it says nothing.
    const cancelled: string[] = [];
    const hanging = new CompletionClient(
      (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
      (message) => cancelled.push(message)
    );
    const controller = new AbortController();
    const pending = hanging.complete(settings(), { prefix: "a", suffix: "" }, undefined, controller.signal);
    controller.abort();
    expect(await pending).toBe("");
    expect(cancelled).toEqual([]);

    // A disabled backend never reaches the network.
    const untouched = vi.fn(async () => jsonResponse({}));
    expect(await new CompletionClient(untouched).complete(
      normalizeCompletionSettings({ enabled: false }),
      { prefix: "a", suffix: "" }
    )).toBe("");
    expect(untouched).not.toHaveBeenCalled();
  });

  it("drops a completion tail that repeats what already follows the cursor", () => {
    expect(trimCompletion("return 1;\n}", "\n}\n")).toBe("return 1;");
    expect(trimCompletion("return 1;   ", "")).toBe("return 1;");
    expect(trimCompletion("first\nsecond", "\nunrelated")).toBe("first\nsecond");
  });

  it("windows by characters so one long line cannot blow the budget", () => {
    const text = `${"a".repeat(50)}CURSOR${"b".repeat(50)}`;
    const window = completionWindow(text, 50, { prefixChars: 10, suffixChars: 6 });
    expect(window.prefix).toBe("a".repeat(10));
    expect(window.suffix).toBe("CURSOR");
    // An offset past the end clamps instead of producing undefined slices.
    expect(completionWindow("abc", 99, { prefixChars: 2, suffixChars: 2 }))
      .toEqual({ prefix: "bc", suffix: "" });
  });

  it("caches by exact cursor position and evicts the least recently used entry", () => {
    const cache = new CompletionCache(2);
    cache.set({ prefix: "a", suffix: "" }, "one");
    cache.set({ prefix: "b", suffix: "" }, "two");
    // Reading 'a' makes 'b' the oldest, so the next insert drops 'b'.
    expect(cache.get({ prefix: "a", suffix: "" })).toBe("one");
    cache.set({ prefix: "c", suffix: "" }, "three");
    expect(cache.get({ prefix: "b", suffix: "" })).toBeUndefined();
    expect(cache.get({ prefix: "a", suffix: "" })).toBe("one");
    // The suffix is part of the key: the same prefix in different surroundings is
    // a different completion.
    expect(cache.get({ prefix: "a", suffix: "x" })).toBeUndefined();
  });

  it("keeps the API key in secret storage, shared across workspaces", async () => {
    const stored = new Map<string, string>();
    const secrets = {
      get: async (key: string) => stored.get(key),
      store: async (key: string, value: string) => void stored.set(key, value),
      delete: async (key: string) => void stored.delete(key)
    };
    const store = new CompletionKeyStore(secrets, () => "/repo/one");
    await store.store("  key-one  ");
    expect(await store.get()).toBe("key-one");
    // The completion model is configured in user settings, so a second project
    // uses the same key rather than asking for it again.
    expect(await new CompletionKeyStore(secrets, () => "/repo/two").get()).toBe("key-one");
    // A window with no folder open still completes.
    expect(await new CompletionKeyStore(secrets).get()).toBe("key-one");
    await expect(store.store(" ")).rejects.toThrow(/cannot be empty/);
    await store.delete();
    expect(await store.get()).toBeUndefined();
  });

  it("carries a key stored while the secret was still workspace-scoped", async () => {
    const legacy = `dext.completion.key.${createHash("sha256").update("/repo/one\u0000completion").digest("hex")}`;
    const stored = new Map<string, string>([[legacy, "old-key"]]);
    const secrets = {
      get: async (key: string) => stored.get(key),
      store: async (key: string, value: string) => void stored.set(key, value),
      delete: async (key: string) => void stored.delete(key)
    };
    const store = new CompletionKeyStore(secrets, () => "/repo/one");
    expect(await store.get()).toBe("old-key");
    // Promoted on read, so the old scoped entry does not linger.
    expect(stored.get("dext.completion.key")).toBe("old-key");
    expect(stored.has(legacy)).toBe(false);
  });
});

describe("anthropic completion transport", () => {
  const anthropic = (overrides: Partial<CompletionSettings> = {}): CompletionSettings =>
    settings({ api: "anthropic", endpoint: "https://api.anthropic.com/v1", model: "claude-fast", ...overrides });

  it("posts to /messages with Anthropic's own headers rather than a bearer token", async () => {
    const fetchImpl = vi.fn<CompletionFetch>(async () =>
      jsonResponse({ content: [{ type: "text", text: "return a + b" }] }));
    const completion = await new CompletionClient(fetchImpl).complete(
      anthropic(),
      { prefix: "def add(a, b):\n    ", suffix: "\n", languageId: "python" },
      "sk-ant-key"
    );
    expect(completion).toBe("return a + b");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("sk-ant-key");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("Authorization")).toBeNull();
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({ model: "claude-fast", max_tokens: 64, stop_sequences: ["\n\n"] });
    // No FIM endpoint exists, so the cursor has to be described in the prompt.
    const messages = sent.messages as { content: string }[];
    expect(messages[0]!.content).toContain("def add(a, b):");
    expect(messages[0]!.content).toContain("<after_cursor>");
    expect(typeof sent.system).toBe("string");
  });

  it("unwraps the code fence a chat model adds however firmly it is told not to", async () => {
    expect(stripCodeFence("```python\nreturn 1\n```")).toBe("return 1");
    expect(stripCodeFence("```\nreturn 1\n```")).toBe("return 1");
    // An unterminated fence still loses the opening line.
    expect(stripCodeFence("```ts\nreturn 1")).toBe("return 1");
    // Ordinary code is untouched, including code that merely mentions a fence.
    expect(stripCodeFence("return 1")).toBe("return 1");
    expect(stripCodeFence("const md = \"```\";")).toBe("const md = \"```\";");

    const fetchImpl = vi.fn<CompletionFetch>(async () =>
      jsonResponse({ content: [{ type: "text", text: "```python\nreturn a + b\n```" }] }));
    expect(await new CompletionClient(fetchImpl).complete(anthropic(), { prefix: "a", suffix: "" }))
      .toBe("return a + b");
  });

  it("skips non-text content blocks instead of returning their JSON", async () => {
    const fetchImpl = vi.fn<CompletionFetch>(async () => jsonResponse({
      content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "answer" }]
    }));
    expect(await new CompletionClient(fetchImpl).complete(anthropic(), { prefix: "a", suffix: "" }))
      .toBe("answer");
  });

  it("is accepted by the settings normalizer alongside the other formats", () => {
    expect(settings({ api: "anthropic" }).api).toBe("anthropic");
    expect(requiresApiKey("anthropic")).toBe(true);
    expect(requiresApiKey("openai")).toBe(true);
    // A local Ollama server has nothing to authenticate against.
    expect(requiresApiKey("ollama")).toBe(false);
    expect(DEFAULT_ENDPOINTS.anthropic).toBe("https://api.anthropic.com/v1");
    // The path is appended only when it is not already there.
    expect(endpointFor({ api: "anthropic", endpoint: "https://api.anthropic.com/v1/messages" }))
      .toBe("https://api.anthropic.com/v1/messages");
    expect(endpointFor({ api: "anthropic", endpoint: "https://proxy.example/v1/" }))
      .toBe("https://proxy.example/v1/messages");
  });
});

describe("openai chat completion transport", () => {
  const chat = (overrides: Partial<CompletionSettings> = {}): CompletionSettings =>
    settings({ api: "openai-chat", endpoint: "https://api.deepseek.com/v1", model: "deepseek-v4-pro", ...overrides });

  it("posts to /chat/completions and reads the message content", async () => {
    const fetchImpl = vi.fn<CompletionFetch>(async () =>
      jsonResponse({ choices: [{ message: { role: "assistant", content: "return a + b" } }] }));
    const completion = await new CompletionClient(fetchImpl).complete(
      chat(),
      { prefix: "def add(a, b):\n    ", suffix: "\n", languageId: "python" },
      "sk-key"
    );
    expect(completion).toBe("return a + b");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer sk-key");
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    const messages = sent.messages as { role: string; content: string }[];
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(messages[1]!.content).toContain("<after_cursor>");
    // The chat path also unwraps a fence, which chat models add unprompted.
    const fenced = vi.fn<CompletionFetch>(async () =>
      jsonResponse({ choices: [{ message: { content: "```python\nreturn a + b\n```" } }] }));
    expect(await new CompletionClient(fenced).complete(chat(), { prefix: "a", suffix: "" }))
      .toBe("return a + b");
  });

  it("keeps the two OpenAI paths apart", () => {
    expect(endpointFor({ api: "openai", endpoint: "https://api.openai.com/v1" }))
      .toBe("https://api.openai.com/v1/completions");
    expect(endpointFor({ api: "openai-chat", endpoint: "https://api.openai.com/v1" }))
      .toBe("https://api.openai.com/v1/chat/completions");
    // A base that already names the path is left alone rather than doubled.
    expect(endpointFor({ api: "openai-chat", endpoint: "https://gateway/v1/chat/completions" }))
      .toBe("https://gateway/v1/chat/completions");
    expect(settings({ api: "openai-chat" }).api).toBe("openai-chat");
    expect(isChatApi("openai-chat")).toBe(true);
    expect(isChatApi("anthropic")).toBe(true);
    expect(isChatApi("openai")).toBe(false);
    expect(isChatApi("ollama")).toBe(false);
  });

  it("says the format is wrong when a chat model answers the FIM endpoint", async () => {
    // The exact misconfiguration that looks like a working setup: HTTP 200, a
    // well-formed body, and not one character the chosen format can read.
    const errors: string[] = [];
    const chatShaped = jsonResponse({ choices: [{ message: { content: "return a + b" } }] });
    const client = new CompletionClient(async () => chatShaped.clone(), (message) => errors.push(message));
    expect(await client.complete(settings({ api: "openai" }), { prefix: "a", suffix: "" })).toBe("");
    expect(errors.at(-1)).toContain("OpenAI Chat Completions format instead");

    // And the reverse, for a FIM endpoint configured as chat.
    const fimShaped = jsonResponse({ choices: [{ text: "return a + b" }] });
    const swapped: string[] = [];
    const other = new CompletionClient(async () => fimShaped.clone(), (message) => swapped.push(message));
    expect(await other.complete(chat(), { prefix: "a", suffix: "" })).toBe("");
    expect(swapped.at(-1)).toContain("OpenAI-compatible FIM format instead");

    // A model that genuinely has nothing to add stays silent, as before.
    const quiet: string[] = [];
    const empty = new CompletionClient(async () => jsonResponse({ choices: [{ text: "" }] }), (m) => quiet.push(m));
    expect(await empty.complete(settings(), { prefix: "a", suffix: "" })).toBe("");
    expect(quiet).toEqual([]);
  });
});

describe("connectivity test", () => {
  it("throws what went wrong instead of swallowing it the way typing does", async () => {
    const client = new CompletionClient(async () => new Response("no such model", { status: 404 }));
    // The same failure is silent during a keystroke and loud during a test.
    expect(await client.complete(settings(), { prefix: "a", suffix: "" })).toBe("");
    await expect(client.verify(settings())).rejects.toThrow(/HTTP 404\. no such model/);

    const offline = new CompletionClient(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(offline.verify(settings())).rejects.toThrow(/not reachable/);
  });

  it("does not call a reply it cannot read a success", async () => {
    // Reaching the endpoint is not the same as understanding it. Reporting this
    // as a passing test is what let a wrong API format look like a working
    // setup that simply never completed anything.
    const chatShaped = new CompletionClient(async () =>
      jsonResponse({ choices: [{ message: { content: "return a + b" } }] }));
    await expect(chatShaped.verify(settings({ api: "openai" })))
      .rejects.toThrow(/API format is probably wrong/);

    // An endpoint that answers with nothing at all is equally not a pass.
    const silent = new CompletionClient(async () => jsonResponse({ choices: [] }));
    await expect(silent.verify(settings())).rejects.toThrow(/nothing could be read/);
  });

  it("reaches the model even when the feature has not been enabled yet", async () => {
    const fetchImpl = vi.fn<CompletionFetch>(async () => jsonResponse({ choices: [{ text: "ok" }] }));
    // Settings written by the wizard are tested before they are saved, so
    // `enabled` is still false at that point.
    const pending = normalizeCompletionSettings({
      enabled: false,
      endpoint: "https://models.example/v1",
      model: "small-fim"
    });
    expect(await new CompletionClient(fetchImpl).verify(pending)).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("ignore rules", () => {
  it("matches the gitignore subset Dext relies on", () => {
    const rules = parseIgnoreRules([
      "# comment",
      "",
      "node_modules/",
      "*.log",
      "/dist",
      "build/**/*.map",
      "secrets.env",
      "!keep.log"
    ].join("\n"));
    expect(isIgnored(rules, "node_modules/pkg/index.js")).toBe(true);
    // An unanchored pattern applies at any depth.
    expect(isIgnored(rules, "packages/app/node_modules/pkg/index.js")).toBe(true);
    expect(isIgnored(rules, "src/app.log")).toBe(true);
    expect(isIgnored(rules, "dist/main.js")).toBe(true);
    // An anchored pattern only matches at the root.
    expect(isIgnored(rules, "packages/dist/main.js")).toBe(false);
    expect(isIgnored(rules, "build/a/b/app.map")).toBe(true);
    expect(isIgnored(rules, "secrets.env")).toBe(true);
    expect(isIgnored(rules, "src/index.ts")).toBe(false);
    // A later negation re-includes what an earlier pattern excluded.
    expect(isIgnored(rules, "keep.log")).toBe(false);
    // Windows separators are normalized before matching.
    expect(isIgnored(rules, "src\\app.log")).toBe(true);
  });
});
