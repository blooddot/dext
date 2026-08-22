import { createHash } from "node:crypto";
import type { SecretStorageLike } from "./mcpSecrets.js";

export type CompletionApi = "openai" | "openai-chat" | "ollama" | "anthropic";

export const COMPLETION_APIS: readonly CompletionApi[] = ["openai", "openai-chat", "anthropic", "ollama"];

/** Chat endpoints have no notion of a suffix, so the cursor has to be described
 * in the prompt and the reply cleaned up afterwards. */
export function isChatApi(api: CompletionApi): boolean {
  return api === "openai-chat" || api === "anthropic";
}

export interface CompletionSettings {
  enabled: boolean;
  /** `openai` speaks the OpenAI-compatible completions API with `suffix`;
   * `ollama` speaks `/api/generate` with its own FIM fields; `openai-chat` and
   * `anthropic` have no fill-in-the-middle endpoint at all and emulate one over
   * a chat request. */
  api: CompletionApi;
  endpoint: string;
  model: string;
  maxTokens: number;
  debounceMs: number;
  /** Characters of code before the cursor sent as the prefix. */
  prefixChars: number;
  /** Characters of code after the cursor sent as the suffix. */
  suffixChars: number;
  timeoutMs: number;
  /** Whether `.gitignore` is honored in addition to `.dextignore`. */
  ignoreGitignore: boolean;
}

export const DEFAULT_COMPLETION_SETTINGS: CompletionSettings = {
  enabled: false,
  api: "openai",
  endpoint: "",
  model: "",
  // Generation time scales with this, and it is the one number that decides how
  // long a suggestion takes to appear. A continuation is a line or two, not a
  // function, and the stop sequence usually ends it sooner anyway.
  maxTokens: 64,
  debounceMs: 200,
  prefixChars: 4000,
  suffixChars: 1000,
  // A hosted gateway routinely needs more than three seconds to emit 128
  // tokens, and a request abandoned at that point burns the tokens without ever
  // showing anything. Waiting longer costs nothing: the editor cancels the
  // request the moment the next key is pressed.
  timeoutMs: 10_000,
  ignoreGitignore: true
};

/** Every field is contributed as its own `dext.completion.*` setting, so the
 * list is derived from the defaults rather than repeated by hand. */
export const COMPLETION_FIELDS = Object.keys(DEFAULT_COMPLETION_SETTINGS) as (keyof CompletionSettings)[];

/** Where each format usually lives, offered as the prefilled value in the setup
 * wizard so the common case is a keystroke rather than a lookup. */
export const DEFAULT_ENDPOINTS: Record<CompletionApi, string> = {
  openai: "https://api.openai.com/v1",
  "openai-chat": "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  ollama: "http://localhost:11434"
};

/** Ollama is a local server with no authentication, so asking for a key there
 * would be a step that can only be skipped. */
export function requiresApiKey(api: CompletionApi): boolean {
  return api !== "ollama";
}

export interface CompletionRequest {
  prefix: string;
  suffix: string;
  /** Language id of the document, passed through as a hint where the API takes
   * one. Never used to decide whether to complete. */
  languageId?: string;
}

export type CompletionFetch = (url: string, init: RequestInit) => Promise<Response>;

const COMPLETION_KEY = "dext.completion.key";

/** The API key never goes into settings: a key in `settings.json` ends up in
 * source control or a synced profile sooner or later. Unlike an MCP server, a
 * completion model belongs to the person rather than the project, so the key is
 * global: the model is configured in user settings, and a workspace-scoped key
 * would mean re-entering it in every repository. */
export class CompletionKeyStore {
  constructor(
    private readonly secrets: SecretStorageLike,
    private readonly workspaceScope: () => string | undefined = () => undefined
  ) {}

  async get(): Promise<string | undefined> {
    const value = await this.secrets.get(COMPLETION_KEY);
    if (value) return value;
    // Keys stored while this was workspace-scoped would otherwise look lost.
    const legacy = this.legacyKey();
    if (!legacy) return undefined;
    const carried = await this.secrets.get(legacy);
    if (!carried) return undefined;
    await this.secrets.store(COMPLETION_KEY, carried);
    await this.secrets.delete(legacy);
    return carried;
  }

  async store(value: string): Promise<void> {
    if (!value.trim()) throw new Error("A completion API key cannot be empty.");
    await this.secrets.store(COMPLETION_KEY, value.trim());
  }

  async delete(): Promise<void> {
    await this.secrets.delete(COMPLETION_KEY);
    const legacy = this.legacyKey();
    if (legacy) await this.secrets.delete(legacy);
  }

  private legacyKey(): string | undefined {
    const workspace = this.workspaceScope();
    if (!workspace) return undefined;
    const scope = createHash("sha256").update(`${workspace}\u0000completion`).digest("hex");
    return `${COMPLETION_KEY}.${scope}`;
  }
}

/** Reads settings that arrive from user configuration, so every field is checked
 * rather than trusted. A bad value falls back to the default instead of failing
 * a keystroke. */
export function normalizeCompletionSettings(raw: unknown): CompletionSettings {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const positive = (name: keyof CompletionSettings, fallback: number, max: number): number => {
    const candidate = value[name];
    return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
      ? Math.min(Math.floor(candidate), max)
      : fallback;
  };
  const endpoint = typeof value.endpoint === "string" ? value.endpoint.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  const api = COMPLETION_APIS.find((candidate) => candidate === value.api) ?? "openai";
  return {
    // An endpoint and a model are both required, so enabling without them stays
    // off rather than failing on every keystroke.
    enabled: value.enabled === true && Boolean(endpoint) && Boolean(model),
    api,
    endpoint,
    model,
    maxTokens: positive("maxTokens", DEFAULT_COMPLETION_SETTINGS.maxTokens, 2048),
    debounceMs: positive("debounceMs", DEFAULT_COMPLETION_SETTINGS.debounceMs, 5000),
    prefixChars: positive("prefixChars", DEFAULT_COMPLETION_SETTINGS.prefixChars, 32_000),
    suffixChars: positive("suffixChars", DEFAULT_COMPLETION_SETTINGS.suffixChars, 32_000),
    timeoutMs: positive("timeoutMs", DEFAULT_COMPLETION_SETTINGS.timeoutMs, 30_000),
    ignoreGitignore: value.ignoreGitignore !== false
  };
}

/** Chat models wrap code in fences however firmly they are told not to, and a
 * stray ``` inserted into a source file is worse than no completion. Only used
 * for chat-shaped backends: a real FIM model emitting a fence means the file
 * genuinely contains one. */
export function stripCodeFence(text: string): string {
  const opening = /^\s*```[^\n]*\n/.exec(text);
  if (!opening) return text;
  const withoutOpening = text.slice(opening[0].length);
  const closing = withoutOpening.lastIndexOf("```");
  return closing === -1 ? withoutOpening : withoutOpening.slice(0, closing).replace(/\n$/, "");
}

/** A completion is only useful up to the point it stops being a continuation of
 * the current line, and a model that keeps going past the suffix produces a
 * duplicate. This drops the tail that already exists after the cursor. */
export function trimCompletion(text: string, suffix: string): string {
  let value = text.replace(/^\r/, "");
  // The suffix often starts with the newline the cursor sits before, so the
  // first line that actually has content is the one to compare against.
  const nextSuffixLine = suffix.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  if (nextSuffixLine && value.trimEnd().endsWith(nextSuffixLine)) {
    value = value.trimEnd().slice(0, -nextSuffixLine.length);
  }
  // Trailing whitespace-only lines add nothing and make the ghost text jump.
  return value.replace(/[ \t]+$/, "").replace(/\n\s*$/, "");
}

export function endpointFor(settings: Pick<CompletionSettings, "api" | "endpoint">): string {
  const base = settings.endpoint.replace(/\/+$/, "");
  if (settings.api === "ollama") {
    return /\/api\/generate$/.test(base) ? base : `${base}/api/generate`;
  }
  if (settings.api === "anthropic") {
    return /\/messages$/.test(base) ? base : `${base}/messages`;
  }
  if (settings.api === "openai-chat") {
    return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  }
  // Only append to a base that is not already the completions path, and never
  // turn a chat path into `/chat/completions/completions`.
  return /\/completions$/.test(base) ? base : `${base}/completions`;
}

/** A chat model has no fill-in-the-middle endpoint, so the cursor has to be
 * described in words. Kept blunt and repetitive on purpose: a chat model given
 * room to be helpful will explain the code instead of continuing it. */
const CHAT_SYSTEM = [
  "You are a code completion engine. You are given the code before the cursor and the code after it.",
  "Reply with the code that belongs at the cursor and nothing else.",
  "Never repeat the code before or after the cursor. Never use markdown code fences.",
  "Never explain, apologise, or add commentary. An empty reply is correct when nothing should be inserted."
].join(" ");

function chatPrompt(request: CompletionRequest): string {
  const language = request.languageId ? `Language: ${request.languageId}\n` : "";
  return `${language}<before_cursor>\n${request.prefix}\n</before_cursor>\n<after_cursor>\n${request.suffix}\n</after_cursor>`;
}

function headersFor(settings: CompletionSettings, apiKey?: string): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (!apiKey) return headers;
  if (settings.api === "anthropic") {
    headers.set("x-api-key", apiKey);
    headers.set("anthropic-version", "2023-06-01");
    return headers;
  }
  headers.set("Authorization", `Bearer ${apiKey}`);
  return headers;
}

/** Without this a model runs to `maxTokens` every single time, which is both the
 * slowest it can possibly be and how a completion ends up containing a second
 * copy of a function that already exists further down the file. A blank line is
 * the end of the thing being written far more often than not. */
const STOP = ["\n\n"];

function body(settings: CompletionSettings, request: CompletionRequest): string {
  if (settings.api === "ollama") {
    return JSON.stringify({
      model: settings.model,
      prompt: request.prefix,
      suffix: request.suffix,
      stream: false,
      options: { num_predict: settings.maxTokens, stop: STOP }
    });
  }
  if (settings.api === "anthropic") {
    return JSON.stringify({
      model: settings.model,
      max_tokens: settings.maxTokens,
      system: CHAT_SYSTEM,
      messages: [{ role: "user", content: chatPrompt(request) }],
      stop_sequences: STOP,
      stream: false
    });
  }
  if (settings.api === "openai-chat") {
    return JSON.stringify({
      model: settings.model,
      max_tokens: settings.maxTokens,
      messages: [
        { role: "system", content: CHAT_SYSTEM },
        { role: "user", content: chatPrompt(request) }
      ],
      stop: STOP,
      stream: false
    });
  }
  return JSON.stringify({
    model: settings.model,
    prompt: request.prefix,
    suffix: request.suffix,
    max_tokens: settings.maxTokens,
    stop: STOP,
    stream: false
  });
}

function extract(api: CompletionApi, payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const value = payload as Record<string, unknown>;
  if (api === "ollama") return typeof value.response === "string" ? value.response : "";
  if (api === "anthropic") {
    const blocks: unknown[] = Array.isArray(value.content) ? value.content : [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const entry = block as Record<string, unknown>;
      if (entry.type === "text" && typeof entry.text === "string") return entry.text;
    }
    return "";
  }
  const choices: unknown[] = Array.isArray(value.choices) ? value.choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const choice = first as Record<string, unknown>;
  if (api === "openai-chat") {
    const message = choice.message;
    if (!message || typeof message !== "object") return "";
    const content = (message as Record<string, unknown>).content;
    return typeof content === "string" ? content : "";
  }
  return typeof choice.text === "string" ? choice.text : "";
}

/** Requests a fill-in-the-middle completion. Errors are returned as an empty
 * string rather than thrown: a completion that fails should be invisible, not an
 * error notification on every keystroke. */
export class CompletionClient {
  constructor(
    private readonly fetchImpl: CompletionFetch = (url, init) => fetch(url, init),
    private readonly onError: (message: string) => void = () => undefined
  ) {}

  async complete(
    settings: CompletionSettings,
    request: CompletionRequest,
    apiKey?: string,
    signal?: AbortSignal
  ): Promise<string> {
    if (!settings.enabled) return "";
    try {
      return await this.request(settings, request, apiKey, signal);
    } catch (error) {
      // A cancelled request is the normal case while typing, not a problem.
      if (!signal?.aborted) this.onError(error instanceof Error ? error.message : String(error));
      return "";
    }
  }

  /** The connectivity test the setup wizard runs. Same transport as `complete`,
   * but failures are thrown rather than swallowed: silence is the right answer
   * to a broken keystroke and the wrong answer to "is this configured?". */
  async verify(settings: CompletionSettings, apiKey?: string, request?: CompletionRequest): Promise<string> {
    const completion = await this.request(
      { ...settings, enabled: true, timeoutMs: Math.max(settings.timeoutMs, 10_000) },
      request ?? { prefix: "def add(a, b):\n    return ", suffix: "\n", languageId: "python" },
      apiKey
    );
    // Reaching the endpoint is not the same as understanding it. A chat model
    // answered through the completions format returns a perfectly valid 200
    // whose body has no `text` field, which would otherwise look like success
    // here and produce nothing but silence while typing.
    if (!completion.trim()) throw new Error(formatMismatch(settings));
    return completion;
  }

  private async request(
    settings: CompletionSettings,
    request: CompletionRequest,
    apiKey?: string,
    signal?: AbortSignal
  ): Promise<string> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, settings.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(endpointFor(settings), {
          method: "POST",
          headers: headersFor(settings, apiKey),
          body: body(settings, request),
          redirect: "manual",
          signal: controller.signal
        });
      } catch {
        if (controller.signal.aborted && !signal?.aborted) {
          throw new Error(`The completion model did not answer within ${settings.timeoutMs}ms.`);
        }
        throw new Error(`The completion model at ${endpointFor(settings)} is not reachable.`);
      }
      if (!response.ok) {
        throw new Error(`The completion model returned HTTP ${response.status}. ${await detail(response)}`.trim());
      }
      const payload: unknown = await response.json();
      const text = extract(settings.api, payload);
      if (!text && looksLikeAnotherFormat(settings.api, payload)) throw new Error(formatMismatch(settings));
      return trimCompletion(isChatApi(settings.api) ? stripCodeFence(text) : text, request.suffix);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

const API_LABELS: Record<CompletionApi, string> = {
  openai: "OpenAI-compatible FIM",
  "openai-chat": "OpenAI Chat Completions",
  anthropic: "Anthropic Messages",
  ollama: "Ollama"
};

/** The most common way to configure this wrongly is to point a chat model at the
 * fill-in-the-middle endpoint, or the reverse. Both return a valid response that
 * the other format cannot read a single character out of, so the advice has to
 * name the swap rather than say "no completion". */
function formatMismatch(settings: Pick<CompletionSettings, "api" | "endpoint" | "model">): string {
  const suggestion = settings.api === "openai"
    ? " Models served over /chat/completions need the OpenAI Chat Completions format instead."
    : settings.api === "openai-chat"
      ? " Models that support fill-in-the-middle need the OpenAI-compatible FIM format instead."
      : "";
  return `${endpointFor(settings)} answered, but nothing could be read out of the reply as `
    + `${API_LABELS[settings.api]}. The API format is probably wrong for this endpoint.${suggestion}`;
}

/** True when the body carries text under a different format's field, which is
 * proof of a misconfiguration rather than a model with nothing to add. */
function looksLikeAnotherFormat(api: CompletionApi, payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const value = payload as Record<string, unknown>;
  for (const candidate of COMPLETION_APIS) {
    if (candidate === api) continue;
    if (extract(candidate, value).trim()) return true;
  }
  return false;
}

/** The status code alone rarely says which of the key, the model name or the URL
 * is wrong, and the body usually does. An empty body is left out rather than
 * appended as a stray `{}`. */
async function detail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text || text === "{}" || text === "null") return "";
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
  } catch {
    return "";
  }
}

/** Bounded cache keyed on the exact prefix and suffix, so the same cursor
 * position never asks twice. Least-recently-used entries go first. */
export class CompletionCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly limit = 64) {}

  private static key(request: CompletionRequest): string {
    return `${request.prefix}\u0000${request.suffix}`;
  }

  get(request: CompletionRequest): string | undefined {
    const key = CompletionCache.key(request);
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key)!;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(request: CompletionRequest, value: string): void {
    const key = CompletionCache.key(request);
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Takes the prefix and suffix windows around a cursor. Sizing is by characters
 * rather than lines so a file of long generated lines cannot blow the budget. */
export function completionWindow(
  text: string,
  offset: number,
  settings: Pick<CompletionSettings, "prefixChars" | "suffixChars">
): CompletionRequest {
  const cursor = Math.max(0, Math.min(offset, text.length));
  return {
    prefix: text.slice(Math.max(0, cursor - settings.prefixChars), cursor),
    suffix: text.slice(cursor, cursor + settings.suffixChars)
  };
}
