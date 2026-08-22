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
  // A keystroke landing while a generation is in flight waits on that one
  // rather than starting a second, so this is the delay before the first
  // request of a burst rather than protection against one request per
  // character. Keeping requests under whatever rate the provider allows is the
  // pacer's job, and doing it here as well would only be a delay everyone pays
  // on every suggestion.
  debounceMs: 80,
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
  /** Set when the completion cannot usefully run past the end of the current
   * line, which lets the model stop several times sooner. */
  singleLine?: boolean;
}

const LINE_COMMENT = /^\s*(\/\/|#|--|;)/;

/** Whether a completion here is allowed to span lines. This decides how long the
 * suggestion takes to appear far more than anything else does: a single-line
 * completion stops at the first newline, so the wait is a handful of tokens
 * rather than a whole block. Both cases below are ones where extra lines would
 * be discarded anyway. */
export function completesSingleLine(request: Pick<CompletionRequest, "prefix" | "suffix">): boolean {
  // Something already follows the cursor on this line, so the completion is
  // filling a gap in an existing line rather than writing new ones.
  const lineEnd = request.suffix.indexOf("\n");
  const restOfLine = lineEnd === -1 ? request.suffix : request.suffix.slice(0, lineEnd);
  if (restOfLine.trim()) return true;
  // A comment continues to the end of the line and no further.
  const currentLine = request.prefix.slice(request.prefix.lastIndexOf("\n") + 1);
  return LINE_COMMENT.test(currentLine);
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

/** The tags that describe the cursor to a chat model. Some models close the last
 * one after answering, and an editor that inserted that would be writing the
 * prompt into the file, so it is cut off wherever it appears. */
const SCAFFOLD_TAGS = ["</after_cursor>", "<after_cursor>", "</before_cursor>", "<before_cursor>"];
const SCAFFOLD = /<\/?(?:before|after)_cursor>[\s\S]*$/;

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

/** Without these a model runs to `maxTokens` every single time, which is both the
 * slowest it can possibly be and how a completion ends up containing a second
 * copy of a function that already exists further down the file. A blank line
 * ends the thing being written far more often than not, and a single-line
 * completion ends at the newline. */
function stopTokens(api: CompletionApi, request: CompletionRequest): string[] {
  // A chat model is told where the cursor is in words, so it has no sense of the
  // column and opens on a fresh line often enough that a bare newline stop would
  // hand back an empty reply instead of a single line. The leading blank is
  // dropped on arrival and the cut is made here instead.
  if (isChatApi(api)) return ["\n\n", SCAFFOLD_TAGS[0]!];
  return request.singleLine ? ["\n"] : ["\n\n"];
}

function body(settings: CompletionSettings, request: CompletionRequest, stream: boolean): string {
  const stop = stopTokens(settings.api, request);
  if (settings.api === "ollama") {
    return JSON.stringify({
      model: settings.model,
      prompt: request.prefix,
      suffix: request.suffix,
      stream,
      options: { num_predict: settings.maxTokens, stop }
    });
  }
  if (settings.api === "anthropic") {
    return JSON.stringify({
      model: settings.model,
      max_tokens: settings.maxTokens,
      system: CHAT_SYSTEM,
      messages: [{ role: "user", content: chatPrompt(request) }],
      stop_sequences: stop,
      stream
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
      stop,
      stream
    });
  }
  return JSON.stringify({
    model: settings.model,
    prompt: request.prefix,
    suffix: request.suffix,
    max_tokens: settings.maxTokens,
    stop,
    stream
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

/** One delta out of a streamed chunk. Streaming uses different fields from the
 * complete reply for the two chat formats, which is why `extract` cannot be
 * reused: a chat model sends `delta.content` while generating and `message
 * .content` once finished. */
function streamDelta(api: CompletionApi, payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const value = payload as Record<string, unknown>;
  if (api === "ollama") return typeof value.response === "string" ? value.response : "";
  if (api === "anthropic") {
    const delta = value.delta;
    if (!delta || typeof delta !== "object") return "";
    const text = (delta as Record<string, unknown>).text;
    return typeof text === "string" ? text : "";
  }
  const choices: unknown[] = Array.isArray(value.choices) ? value.choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const choice = first as Record<string, unknown>;
  if (api === "openai-chat") {
    const delta = choice.delta;
    if (!delta || typeof delta !== "object") return "";
    const content = (delta as Record<string, unknown>).content;
    return typeof content === "string" ? content : "";
  }
  return typeof choice.text === "string" ? choice.text : "";
}

/** Ollama streams bare JSON per line; everyone else uses server-sent events.
 * Returns undefined for a line that carries no delta at all. */
function streamLine(api: CompletionApi, line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let json = trimmed;
  if (api !== "ollama") {
    if (!trimmed.startsWith("data:")) return undefined;
    json = trimmed.slice("data:".length).trim();
    if (!json || json === "[DONE]") return undefined;
  }
  try {
    return streamDelta(api, JSON.parse(json));
  } catch {
    return undefined;
  }
}

/** How much of what has arrived so far is worth keeping, once it is certain that
 * nothing later can add to it. Returning a value ends the request early, which
 * is the whole point of streaming: a model asked for 64 tokens usually produces
 * a usable completion in the first handful. */
export function truncateAtStop(text: string, singleLine: boolean): string | undefined {
  if (singleLine) {
    const newline = text.indexOf("\n");
    // A leading newline means the model chose to start on the next line, which
    // is exactly what a single-line completion must not do.
    return newline === -1 ? undefined : text.slice(0, newline);
  }
  const blank = text.indexOf("\n\n");
  return blank === -1 ? undefined : text.slice(0, blank);
}

/** What a chat model actually meant, once its habits are taken off: a fence it
 * was told not to use, the newline it starts on because it is writing a reply
 * rather than continuing a line, and the closing tag from the prompt, which
 * inserted into a file would be the editor writing its own prompt into the code.
 * A real FIM model gets none of this, because from one of those a leading
 * newline is a deliberate choice and there is no prompt scaffolding to echo. */
function shapeReply(api: CompletionApi, request: CompletionRequest, text: string): string {
  const shaped = isChatApi(api)
    ? stripCodeFence(text).replace(/^\n+/, "").replace(SCAFFOLD, "")
    : text;
  // A chat backend is not sent the single-line stop, so the cut it would have
  // made server-side is made here, and a streamed reply that already stopped
  // early passes through unchanged.
  return truncateAtStop(shaped, request.singleLine === true) ?? shaped;
}

/** Where the wait went. Time to the first token is the provider's queue, network
 * and prefill; the rest is generation, which is the only part that responds to
 * `maxTokens` and the stop sequences. Tuning either without knowing which one
 * dominates is guesswork. */
export interface CompletionTiming {
  /** Undefined where the reply did not stream, so no token can be timed. */
  firstTokenMs: number | undefined;
  totalMs: number;
}

export interface CompletionFailure {
  message: string;
  /** The provider refused because requests were arriving too quickly, which is
   * answered by slowing down rather than by telling anyone to fix something. */
  rateLimited: boolean;
  /** How long the provider asked to be left alone for, where it said. */
  retryAfterMs?: number;
}

/** Carries the status out of the transport so that a refusal for going too fast
 * can be told apart from a wrong key or a wrong URL. */
class CompletionHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message);
  }
}

/** `Retry-After` is either a number of seconds or a date. Anything else is
 * ignored rather than guessed at. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("Retry-After");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Requests a fill-in-the-middle completion. Errors are returned as an empty
 * string rather than thrown: a completion that fails should be invisible, not an
 * error notification on every keystroke. */
export class CompletionClient {
  constructor(
    private readonly fetchImpl: CompletionFetch = (url, init) => fetch(url, init),
    private readonly onError: (failure: CompletionFailure) => void = () => undefined,
    private readonly onTiming: (timing: CompletionTiming) => void = () => undefined
  ) {}

  async complete(
    settings: CompletionSettings,
    request: CompletionRequest,
    apiKey?: string,
    signal?: AbortSignal
  ): Promise<string> {
    if (!settings.enabled) return "";
    try {
      return await this.request(settings, request, apiKey, signal, { stream: true, measure: true });
    } catch (error) {
      // A cancelled request is the normal case while typing, not a problem.
      if (!signal?.aborted) this.onError(failureOf(error));
      return "";
    }
  }

  /** The connectivity test the setup wizard runs. Same transport as `complete`,
   * but failures are thrown rather than swallowed: silence is the right answer
   * to a broken keystroke and the wrong answer to "is this configured?". It also
   * does not stream, because a whole reply can be checked against every format
   * to say which one the endpoint actually speaks, and a stream of deltas the
   * chosen format cannot read is indistinguishable from an empty answer. */
  async verify(settings: CompletionSettings, apiKey?: string, request?: CompletionRequest): Promise<string> {
    const completion = await this.request(
      { ...settings, enabled: true, timeoutMs: Math.max(settings.timeoutMs, 10_000) },
      request ?? { prefix: "def add(a, b):\n    return ", suffix: "\n", languageId: "python" },
      apiKey,
      undefined,
      // Deliberately unmeasured. This request does not stream, so timing it
      // would record a first-token time of "never" and the diagnosis would then
      // report that the endpoint refuses to stream, having proved no such thing.
      { stream: false, measure: false }
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
    apiKey: string | undefined,
    signal: AbortSignal | undefined,
    { stream, measure }: { stream: boolean; measure: boolean }
  ): Promise<string> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, settings.timeoutMs);
    const sentAt = Date.now();
    let firstTokenAt: number | undefined;
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(endpointFor(settings), {
          method: "POST",
          headers: headersFor(settings, apiKey),
          body: body(settings, request, stream),
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
        const after = retryAfterMs(response);
        throw new CompletionHttpError(
          `The completion model returned HTTP ${response.status}. ${await detail(response)}`.trim(),
          response.status,
          after
        );
      }
      const text = stream && response.body
        ? await this.readStreamed(response.body, settings, request, controller, (at) => { firstTokenAt = at; })
        : this.fromPayload(await response.json(), settings);
      if (measure) {
        this.onTiming({
          firstTokenMs: firstTokenAt === undefined ? undefined : firstTokenAt - sentAt,
          totalMs: Date.now() - sentAt
        });
      }
      return trimCompletion(shapeReply(settings.api, request, text), request.suffix);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  /** Not every endpoint honours the stream flag. One that answers with an
   * ordinary body would otherwise read as a stream carrying no deltas, so the
   * body it did send is parsed as a whole rather than discarded. */
  private async readStreamed(
    body: ReadableStream<Uint8Array>,
    settings: CompletionSettings,
    request: CompletionRequest,
    controller: AbortController,
    onFirstToken: (at: number) => void
  ): Promise<string> {
    const streamed = await readStream(body, settings.api, request, controller, onFirstToken);
    if (streamed.streaming) return streamed.text;
    try {
      return this.fromPayload(JSON.parse(streamed.raw), settings);
    } catch (error) {
      if (error instanceof CompletionFormatError) throw error;
      return "";
    }
  }

  private fromPayload(payload: unknown, settings: CompletionSettings): string {
    const text = extract(settings.api, payload);
    if (!text && looksLikeAnotherFormat(settings.api, payload)) {
      throw new CompletionFormatError(formatMismatch(settings));
    }
    return text;
  }
}

/** Distinguished from a parse failure so that the advice about the API format
 * survives being thrown out of a body that was not JSON after all. */
class CompletionFormatError extends Error {}

function failureOf(error: unknown): CompletionFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof CompletionHttpError)) return { message, rateLimited: false };
  const failure: CompletionFailure = { message, rateLimited: error.status === 429 };
  return error.retryAfterMs === undefined ? failure : { ...failure, retryAfterMs: error.retryAfterMs };
}

/** The interval tried first, once a provider has refused for going too fast.
 * Roughly three requests a second, which is under every published limit seen so
 * far without being slow enough to notice. */
const FIRST_INTERVAL = 300;
const MAX_INTERVAL = 3000;
/** How long without a refusal before the spacing is eased back off. */
const RELAX_AFTER = 30_000;

/** Providers meter a completion backend by requests per second, and one that
 * allows four of them refuses the fifth rather than queueing it. No setting can
 * predict that limit, and asking someone to find out what theirs is and type it
 * in is a poor substitute for noticing: requests go out as fast as they are
 * asked for until one is refused, and are then spaced out by an interval that
 * doubles while refusals continue and relaxes once they stop. */
export class CompletionPacer {
  private interval = 0;
  private last = 0;
  private lastRefusal = 0;

  /** How long to hold the next request back for. */
  wait(now: number): number {
    this.relax(now);
    if (this.interval === 0) return 0;
    return Math.max(0, this.last + this.interval - now);
  }

  started(now: number): void {
    this.last = now;
  }

  refused(now: number, retryAfter?: number): void {
    this.lastRefusal = now;
    const doubled = this.interval === 0 ? FIRST_INTERVAL : this.interval * 2;
    this.interval = Math.min(Math.max(doubled, retryAfter ?? 0), MAX_INTERVAL);
  }

  /** What is currently being enforced, for the diagnosis to report. */
  get spacing(): number {
    return this.interval;
  }

  private relax(now: number): void {
    if (this.interval === 0 || now - this.lastRefusal < RELAX_AFTER) return;
    this.lastRefusal = now;
    this.interval = this.interval <= FIRST_INTERVAL ? 0 : Math.floor(this.interval / 2);
  }
}

/** Reads deltas as they arrive and stops the request as soon as the completion
 * is decidably finished, rather than waiting for the model to reach its token
 * budget. This is the difference between a suggestion appearing in a few hundred
 * milliseconds and appearing in a few seconds. */
async function readStream(
  body: ReadableStream<Uint8Array>,
  api: CompletionApi,
  request: CompletionRequest,
  controller: AbortController,
  onFirstToken: (at: number) => void
): Promise<{ text: string; raw: string; streaming: boolean }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const singleLine = request.singleLine === true;
  let pending = "";
  let raw = "";
  let text = "";
  let streaming = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const delta = streamLine(api, pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (delta) {
          if (!streaming) onFirstToken(Date.now());
          streaming = true;
          text += delta;
          // Stripped before the test so that a chat model's opening newline
          // cannot end a single-line completion before it has written anything.
          const sofar = isChatApi(api) ? text.replace(/^\n+/, "") : text;
          // Reaching the prompt's own closing tag means the answer is over,
          // whatever the model intends to write next.
          const scaffold = isChatApi(api) && SCAFFOLD.test(sofar);
          const finished = scaffold ? sofar.replace(SCAFFOLD, "") : truncateAtStop(sofar, singleLine);
          if (finished !== undefined) {
            controller.abort();
            return { text: finished, raw, streaming: true };
          }
        }
        newline = pending.indexOf("\n");
      }
    }
    const last = streamLine(api, pending);
    if (last) {
      streaming = true;
      text += last;
    }
  } catch {
    // A stream cut short still leaves something worth offering, and a keystroke
    // is not the place to report a dropped connection.
  } finally {
    reader.releaseLock();
  }
  return { text: truncateAtStop(text, singleLine) ?? text, raw, streaming };
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

/** The longest run of typed characters a cached completion is followed forward
 * through. Past this the answer is stale enough to be worth asking again. */
const MAX_TYPED = 32;

/** Whether `next` is `earlier` with `typed` appended. The prefix is a window
 * onto the file rather than the whole of it, so in a long file the window has
 * also slid forward by the same number of characters, and the two cases have to
 * be told apart by length. */
function continues(earlier: string, next: string, typed: string): boolean {
  const head = next.slice(0, next.length - typed.length);
  return earlier.length <= head.length ? head.endsWith(earlier) : earlier.endsWith(head);
}

/** What has been typed at the cursor since `earlier` was the prefix, or
 * undefined when the two are not the same position followed by typing. An empty
 * string means the cursor has not moved at all. Both the cache and the reuse of
 * a generation still in flight turn on this question. */
export function typedSince(earlier: string, next: string): string | undefined {
  const limit = Math.min(MAX_TYPED, next.length);
  for (let length = 0; length <= limit; length += 1) {
    const typed = next.slice(next.length - length);
    if (continues(earlier, next, typed)) return typed;
  }
  return undefined;
}

/** Bounded cache keyed on the prefix and suffix. As well as the same position
 * never being asked twice, a position reached by typing the start of what was
 * already suggested is served from what is left of that suggestion. Without
 * that, every character typed into a suggestion costs a whole round trip, which
 * is most of why completion feels slow even when the model is quick.
 * Least-recently-used entries go first. */
export class CompletionCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly limit = 64) {}

  private static key(request: CompletionRequest): string {
    return `${request.prefix}\u0000${request.suffix}`;
  }

  get(request: CompletionRequest): string | undefined {
    const key = CompletionCache.key(request);
    if (this.entries.has(key)) {
      const value = this.entries.get(key)!;
      this.entries.delete(key);
      this.entries.set(key, value);
      return value;
    }
    return this.typedForward(request);
  }

  /** Newest first, so the most recent suggestion for this spot wins. Typing only
   * ever inserts at the cursor, which is why the suffix has to match exactly
   * while the prefix is allowed to have grown. */
  private typedForward(request: CompletionRequest): string | undefined {
    for (const [key, value] of [...this.entries].reverse()) {
      const split = key.indexOf("\u0000");
      if (key.slice(split + 1) !== request.suffix) continue;
      const typed = typedSince(key.slice(0, split), request.prefix);
      // An empty match is the same position, which the exact lookup has already
      // ruled out by the time this runs.
      if (!typed || !value.startsWith(typed)) continue;
      return value.slice(typed.length);
    }
    return undefined;
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

/** How far the cursor travels before the start of the prefix window moves. */
const WINDOW_STEP = 1024;

/** Where the prefix window begins. Every provider worth using caches the prompt
 * it has already processed and charges nothing to re-read it, but the cache only
 * hits where the prompt begins the same way it did last time. A window whose
 * start slides by one character per keystroke never hits it once, so the start
 * is quantised and then snapped to a line boundary: it stays put for a thousand
 * characters of cursor movement rather than moving with every letter. */
function windowStart(text: string, cursor: number, prefixChars: number): number {
  const earliest = cursor - prefixChars;
  if (earliest <= 0) return 0;
  const quantised = Math.ceil(earliest / WINDOW_STEP) * WINDOW_STEP;
  // A window smaller than the step has nothing to gain here, and rounding it up
  // would leave no prefix at all.
  if (quantised >= cursor) return earliest;
  const boundary = text.indexOf("\n", quantised);
  return boundary === -1 || boundary >= cursor ? quantised : boundary + 1;
}

/** Takes the prefix and suffix windows around a cursor. Sizing is by characters
 * rather than lines so a file of long generated lines cannot blow the budget. */
export function completionWindow(
  text: string,
  offset: number,
  settings: Pick<CompletionSettings, "prefixChars" | "suffixChars">
): CompletionRequest {
  const cursor = Math.max(0, Math.min(offset, text.length));
  const window = {
    prefix: text.slice(windowStart(text, cursor, settings.prefixChars), cursor),
    suffix: text.slice(cursor, cursor + settings.suffixChars)
  };
  return { ...window, singleLine: completesSingleLine(window) };
}
