import type {
  AxAIFeatures,
  AxAIService,
  AxAIServiceMetrics,
  AxAIServiceOptions,
  AxChatRequest,
  AxChatResponse,
  AxChatResponseResult,
  AxEmbedRequest,
  AxEmbedResponse,
  AxLoggerFunction,
  AxModelConfig,
  AxModelUsage,
  AxSpeechRequest,
  AxSpeechResponse,
  AxTranscriptionRequest,
  AxTranscriptionResponse
} from "@ax-llm/ax";
import { agentResultCandidates } from "./resultBoundary.js";
import type { AgentTokenUsage } from "./types.js";

/** One text-in/text-out CLI call. The transport owns process spawning, CLI
 * selection, and abort/timeout of the underlying child process. */
export type CliAxTransport = (
  prompt: string,
  signal?: AbortSignal
) => Promise<{ text: string; usage?: AgentTokenUsage }>;

export interface CliAxAIServiceOptions {
  id: string;
  label: string;
  outputField: string;
  transport: CliAxTransport;
  model?: string;
}

function emptyLatency(): AxAIServiceMetrics["latency"]["chat"] {
  return { mean: 0, p95: 0, p99: 0, samples: [] };
}

function emptyErrors(): AxAIServiceMetrics["errors"]["chat"] {
  return { count: 0, rate: 0, total: 0 };
}

function percentile(samples: readonly number[], fraction: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index]!;
}

function textParts(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part !== "object" || part === null || (part as { type?: unknown }).type !== "text") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function renderMessage(message: AxChatRequest["chatPrompt"][number]): string {
  if (message.role === "function") {
    const content = textParts(message.content);
    return `Function: ${(message.result ?? content).trim()}`;
  }
  if (message.role === "assistant") {
    const content = typeof message.content === "string" ? message.content : textParts(message.content);
    return `Assistant: ${content}`;
  }
  if (message.role === "system") return `System: ${message.content}`;
  return `User: ${textParts(message.content)}`;
}

/** Renders ax's chatPrompt into the single text block a CLI accepts. Ax message
 * roles are preserved as labels; function/tool calls are not part of this
 * transport (the service declares `functions: false`). */
export function renderChatPrompt(prompt: AxChatRequest["chatPrompt"]): string {
  return prompt.map(renderMessage).join("\n\n");
}

function modelUsage(serviceId: string, model: string | undefined, usage: AgentTokenUsage | undefined): AxModelUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  return {
    ai: serviceId,
    model: model ?? "unknown",
    tokens: {
      promptTokens,
      completionTokens,
      totalTokens: usage.totalTokens ?? promptTokens + completionTokens,
      ...(usage.cachedInputTokens !== undefined ? { cacheReadTokens: usage.cachedInputTokens } : {})
    }
  };
}

function envelope(raw: string, outputField: string): string {
  const candidates = agentResultCandidates(raw);
  // Prefer an explicit envelope, then the first Dext-shaped object (this keeps
  // the outer object when the result contains nested objects), then the first
  // recoverable object at all.
  const match = candidates.find((candidate) => Object.hasOwn(candidate.value, outputField))
    ?? candidates.find((candidate) => typeof candidate.value.kind === "string")
    ?? candidates[0];
  if (!match) return raw;
  const content = Object.hasOwn(match.value, outputField) ? match.value : { [outputField]: match.value };
  return JSON.stringify(content);
}

/** Minimal `AxAIService` implementation backed by Dext's one-shot read-only CLI
 * calls. It intentionally ignores `functions` and `responseFormat`: the CLI
 * receives one prompt and returns one piece of text. `structuredOutputs` is
 * true because Dext's result schemas use complex nested fields; ax then asks
 * for a JSON envelope and this service wraps the parsed object in
 * `{[outputField]: value}` before returning it. */
export class CliAxAIService implements AxAIService {
  private readonly metrics: AxAIServiceMetrics = {
    latency: { chat: emptyLatency(), embed: emptyLatency() },
    errors: { chat: emptyErrors(), embed: emptyErrors() }
  };
  private options: AxAIServiceOptions = {};
  private lastUsedModelConfig: AxModelConfig | undefined;
  private readonly model: string | undefined;

  constructor(private readonly config: CliAxAIServiceOptions) {
    this.model = config.model;
  }

  getId(): string {
    return this.config.id;
  }

  getName(): string {
    return this.config.label;
  }

  getFeatures(): AxAIFeatures {
    return {
      functions: false,
      streaming: false,
      structuredOutputs: true,
      media: {
        images: { supported: false, formats: [] },
        audio: { supported: false, formats: [] },
        files: { supported: false, formats: [], uploadMethod: "none" },
        urls: { supported: false, webSearch: false, contextFetching: false }
      },
      caching: { supported: false, types: [] },
      thinking: false,
      multiTurn: true
    };
  }

  getModelList(): undefined {
    return undefined;
  }

  getMetrics(): AxAIServiceMetrics {
    return this.metrics;
  }

  getLogger(): AxLoggerFunction {
    return () => undefined;
  }

  getLastUsedChatModel(): undefined {
    return undefined;
  }

  getLastUsedEmbedModel(): undefined {
    return undefined;
  }

  getLastUsedModelConfig(): AxModelConfig | undefined {
    return this.lastUsedModelConfig;
  }

  async chat(
    req: Readonly<AxChatRequest>,
    options: Readonly<AxAIServiceOptions> = {}
  ): Promise<AxChatResponse | ReadableStream<AxChatResponse>> {
    const started = Date.now();
    this.metrics.errors.chat.total += 1;
    try {
      const prompt = renderChatPrompt(req.chatPrompt);
      const response = await this.perform(prompt, options);
      const content = envelope(response.text, this.config.outputField);
      const result: AxChatResponseResult = { index: 0, content };
      if (req.modelConfig) this.lastUsedModelConfig = req.modelConfig;
      const usage = modelUsage(this.config.id, this.model, response.usage);
      return { results: [result], ...(usage ? { modelUsage: usage } : {}) };
    } catch (error) {
      this.metrics.errors.chat.count += 1;
      this.metrics.errors.chat.rate = this.metrics.errors.chat.count / this.metrics.errors.chat.total;
      throw error;
    } finally {
      const elapsed = Date.now() - started;
      const latency = this.metrics.latency.chat;
      latency.samples.push(elapsed);
      latency.mean = latency.samples.reduce((sum, value) => sum + value, 0) / latency.samples.length;
      latency.p95 = percentile(latency.samples, 0.95);
      latency.p99 = percentile(latency.samples, 0.99);
      this.metrics.errors.chat.rate = this.metrics.errors.chat.count / this.metrics.errors.chat.total;
    }
  }

  private perform(
    prompt: string,
    options: Readonly<AxAIServiceOptions>
  ): Promise<{ text: string; usage?: AgentTokenUsage }> {
    const external = options.abortSignal ?? this.options.abortSignal;
    if (external?.aborted) {
      const reason = external.reason instanceof Error ? external.reason : new Error("Aborted.");
      return Promise.reject(reason);
    }
    const timeout = options.timeout ?? this.options.timeout;
    if (!timeout || timeout <= 0 || timeout === Infinity) return this.config.transport(prompt, external);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`CLI call timed out after ${timeout}ms.`)), timeout);
    const bridge = (): void => controller.abort(external?.reason ?? new Error("Aborted."));
    external?.addEventListener("abort", bridge, { once: true });
    return this.config.transport(prompt, controller.signal).finally(() => {
      clearTimeout(timer);
      external?.removeEventListener("abort", bridge);
    });
  }

  embed(req: Readonly<AxEmbedRequest>, options?: Readonly<AxAIServiceOptions>): Promise<AxEmbedResponse> {
    void req; void options;
    return Promise.reject(new Error("CLI result repair does not support embeddings."));
  }

  transcribe(req: Readonly<AxTranscriptionRequest>, options?: Readonly<AxAIServiceOptions>): Promise<AxTranscriptionResponse> {
    void req; void options;
    return Promise.reject(new Error("CLI result repair does not support transcription."));
  }

  speak(req: Readonly<AxSpeechRequest>, options?: Readonly<AxAIServiceOptions>): Promise<AxSpeechResponse> {
    void req; void options;
    return Promise.reject(new Error("CLI result repair does not support speech."));
  }

  getEstimatedCost(modelUsage?: AxModelUsage): number {
    void modelUsage;
    return 0;
  }

  setOptions(options: Readonly<AxAIServiceOptions>): void {
    this.options = { ...this.options, ...options };
  }

  getOptions(): Readonly<AxAIServiceOptions> {
    return this.options;
  }
}
