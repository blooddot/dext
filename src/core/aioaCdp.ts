import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import CDP from "chrome-remote-interface";
import type { AgentProfile } from "../agentProfiles.js";
import { displayValue, type AgentExecutionRequest, type AgentRunner } from "./agentRunner.js";
import type { FieldDefinition } from "./types.js";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 300;
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_WORKSPACE_TIMEOUT_MS = 2_000;
const DEFAULT_WORKSPACE_POLL_INTERVAL_MS = 100;
const COMPOSER_SELECTOR = "textarea.aioa-biz-composer-editor";
const ASSISTANT_MESSAGE_SELECTOR = "article.aioa-message.assistant";
const USER_MESSAGE_SELECTOR = "article.aioa-message.user[data-message-id]";

export interface AioaAssistantMessage {
  id: string;
  text: string;
}

export interface AioaConversationState {
  busy: boolean;
  assistantIds: readonly string[];
  conversationId?: string;
}

export interface AioaConversationUpdate {
  busy: boolean;
  messages: readonly AioaAssistantMessage[];
  conversationId?: string;
}

export interface AioaCdpPage {
  state(): Promise<AioaConversationState>;
  createConversation(workspaceRoot: string): Promise<void>;
  submit(message: string): Promise<void>;
  updatesAfter(assistantIds: ReadonlySet<string>): Promise<AioaConversationUpdate>;
  close(): Promise<void>;
}

export interface AioaPagePoint {
  x: number;
  y: number;
}

export interface AioaWorkspacePickerRow {
  name: string;
  point: AioaPagePoint;
  selected: boolean;
}

export interface AioaConversationSetupSnapshot {
  globalNewTaskPoints: readonly AioaPagePoint[];
  visibleMessageCount: number;
  workspaceRows: readonly AioaWorkspacePickerRow[];
  workspaceSelectorPoint?: AioaPagePoint;
  workspaceSearchPoint?: AioaPagePoint;
  selectedWorkspaceName?: string;
}

export interface AioaConversationSetupNavigator {
  snapshot(): Promise<AioaConversationSetupSnapshot>;
  click(point: AioaPagePoint): Promise<void>;
  replaceText(point: AioaPagePoint, text: string): Promise<void>;
}

export type AioaTrustedInput = Pick<CDP.Client["Input"], "dispatchKeyEvent" | "dispatchMouseEvent" | "insertText">;

interface AioaWorkspaceNavigationOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface AioaCdpConnection {
  open(profile: AgentProfile): Promise<{ page: AioaCdpPage; launched: boolean }>;
}

export interface AioaCdpConnector {
  connect(endpoint: string): Promise<AioaCdpPage>;
}

export interface AioaProcessLauncher {
  launch(executable: string, args: readonly string[]): Promise<void>;
}

interface AioaCdpRunnerOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface AioaCdpConnectionOptions {
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function normalizeAioaWorkspaceName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function workspaceNameFromRoot(workspaceRoot: string): string {
  const normalizedRoot = workspaceRoot.replace(/[\\/]+$/, "");
  const workspaceName = normalizedRoot.split(/[\\/]/).at(-1)?.trim();
  if (!workspaceName) throw new Error("Dext cannot determine the AIOA workspace name.");
  return workspaceName;
}

function visibleWorkspaceList(snapshot: AioaConversationSetupSnapshot): string {
  return snapshot.workspaceRows.length > 0
    ? snapshot.workspaceRows.map((row) => `'${row.name}'`).join(", ")
    : "(none)";
}

async function clickAioaPoint(input: AioaTrustedInput, point: AioaPagePoint): Promise<void> {
  await input.dispatchMouseEvent({ type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await input.dispatchMouseEvent({ type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

export async function replaceAioaText(
  input: AioaTrustedInput,
  point: AioaPagePoint,
  text: string
): Promise<void> {
  await clickAioaPoint(input, point);
  await input.dispatchKeyEvent({
    type: "keyDown",
    key: "Control",
    code: "ControlLeft",
    modifiers: 2,
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17
  });
  await input.dispatchKeyEvent({
    type: "keyDown",
    key: "a",
    code: "KeyA",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65
  });
  await input.dispatchKeyEvent({
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65
  });
  await input.dispatchKeyEvent({
    type: "keyUp",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17
  });
  await input.dispatchKeyEvent({
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8
  });
  await input.dispatchKeyEvent({
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8
  });
  if (text) await input.insertText({ text });
}

async function waitForSetupSnapshot(
  navigator: AioaConversationSetupNavigator,
  attempts: number,
  pollIntervalMs: number,
  wait: (milliseconds: number) => Promise<void>,
  predicate: (snapshot: AioaConversationSetupSnapshot) => boolean
): Promise<AioaConversationSetupSnapshot | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const snapshot = await navigator.snapshot();
    if (predicate(snapshot)) return snapshot;
    if (attempt < attempts - 1) await wait(pollIntervalMs);
  }
  return undefined;
}

export async function openAioaWorkspaceConversation(
  workspaceRoot: string,
  navigator: AioaConversationSetupNavigator,
  options: AioaWorkspaceNavigationOptions = {}
): Promise<void> {
  const workspaceName = workspaceNameFromRoot(workspaceRoot);
  const normalizedWorkspaceName = normalizeAioaWorkspaceName(workspaceName);
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKSPACE_TIMEOUT_MS;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_WORKSPACE_POLL_INTERVAL_MS);
  const wait = options.sleep ?? sleep;
  const attempts = Math.max(1, Math.floor(timeoutMs / pollIntervalMs) + 1);
  const initial = await navigator.snapshot();
  if (initial.globalNewTaskPoints.length !== 1) {
    throw new Error(
      initial.globalNewTaskPoints.length === 0
        ? "AIOA's global new-task button was not found."
        : "AIOA has multiple visible global new-task buttons."
    );
  }
  await navigator.click(initial.globalNewTaskPoints[0]!);

  const emptyTask = await waitForSetupSnapshot(
    navigator,
    attempts,
    pollIntervalMs,
    wait,
    (snapshot) => snapshot.visibleMessageCount === 0 && Boolean(snapshot.workspaceSelectorPoint)
  );
  if (!emptyTask?.workspaceSelectorPoint) {
    throw new Error("AIOA did not open a new empty task with a workspace selector.");
  }
  await navigator.click(emptyTask.workspaceSelectorPoint);

  const picker = await waitForSetupSnapshot(
    navigator,
    attempts,
    pollIntervalMs,
    wait,
    (snapshot) => Boolean(snapshot.workspaceSearchPoint)
  );
  if (!picker?.workspaceSearchPoint) {
    throw new Error("AIOA's workspace picker did not open.");
  }
  await navigator.replaceText(picker.workspaceSearchPoint, workspaceName);
  await wait(pollIntervalMs);

  let latestPicker = picker;
  let selectedRow: AioaWorkspacePickerRow | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latestPicker = await navigator.snapshot();
    const matches = latestPicker.workspaceRows.filter(
      (row) => normalizeAioaWorkspaceName(row.name) === normalizedWorkspaceName
    );
    if (matches.length > 1) {
      throw new Error(
        `AIOA has multiple workspaces matching '${workspaceName}'. `
        + `Rename the duplicate workspaces and retry. Visible picker workspaces: ${visibleWorkspaceList(latestPicker)}.`
      );
    }
    selectedRow = matches[0];
    if (selectedRow) break;
    if (attempt < attempts - 1) await wait(pollIntervalMs);
  }
  if (!selectedRow) {
    throw new Error(
      `AIOA workspace '${workspaceName}' was not found in the workspace picker. `
      + `Visible picker workspaces: ${visibleWorkspaceList(latestPicker)}.`
    );
  }
  await navigator.click(selectedRow.point);

  const selectedTask = await waitForSetupSnapshot(
    navigator,
    attempts,
    pollIntervalMs,
    wait,
    (snapshot) => snapshot.visibleMessageCount === 0
      && normalizeAioaWorkspaceName(snapshot.selectedWorkspaceName ?? "") === normalizedWorkspaceName
  );
  if (!selectedTask) {
    throw new Error(`AIOA did not select workspace '${workspaceName}' on the new empty task.`);
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

/** CDP is unauthenticated, so Dext only accepts an explicit local endpoint. */
export function normalizeAioaCdpEndpoint(raw: string): string {
  const input = raw.trim();
  if (!input) throw new Error("AIOA CDP URL is required.");
  let endpoint: URL;
  try {
    endpoint = new URL(input);
  } catch {
    throw new Error("AIOA CDP URL must be a valid http://localhost URL.");
  }
  if (endpoint.protocol !== "http:" || !isLoopbackHost(endpoint.hostname)) {
    throw new Error("AIOA CDP must use an http://localhost loopback URL.");
  }
  if (!endpoint.port) throw new Error("AIOA CDP URL must include a port.");
  if (endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("AIOA CDP URL cannot include credentials, a path, a query, or a fragment.");
  }
  return endpoint.toString().replace(/\/$/, "");
}

function cdpConnectionOptions(endpoint: string): { host: string; port: number } {
  const url = new URL(normalizeAioaCdpEndpoint(endpoint));
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("AIOA CDP URL has an invalid port.");
  }
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
}

export function defaultAioaExecutable(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.LOCALAPPDATA
    ? join(environment.LOCALAPPDATA, "Programs", "AIOA", "AIOA.exe")
    : "AIOA.exe";
}

export function aioaLaunchArguments(endpoint: string): string[] {
  const { port } = cdpConnectionOptions(endpoint);
  return [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1"
  ];
}

function resolveAioaExecutable(command: string): string {
  const executable = command.trim() || defaultAioaExecutable();
  if (/^[A-Za-z]:[\\/]/.test(executable) && !existsSync(executable)) {
    throw new Error(`AIOA executable was not found: ${executable}`);
  }
  return executable;
}

export function parseJsonOutput(text: string, expectedKind?: string): unknown {
  const matchesExpectedKind = (value: unknown): boolean => {
    if (!expectedKind) return true;
    return record(value)?.kind === expectedKind;
  };
  const parseCandidate = (candidate: string): unknown => {
    try {
      const value: unknown = JSON.parse(candidate);
      return matchesExpectedKind(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = text.trim();
  const directResult = parseCandidate(direct);
  if (directResult !== undefined) return directResult;

  // AIOA occasionally wraps a compliant response in a JSON fence.
  const candidates = [...direct.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates.reverse()) {
    const result = parseCandidate(candidate);
    if (result !== undefined) return result;
  }
  for (const candidate of jsonObjectCandidates(direct)) {
    const result = parseCandidate(candidate);
    if (result !== undefined) return result;
  }
  return undefined;
}

/** Extracts complete top-level JSON objects while ignoring braces inside strings. */
function jsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quoted && character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "\"") {
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
      if (depth === 0) {
        candidates.push(text.slice(start, index + 1));
        break;
      }
    }
  }
  return candidates;
}

function looksLikeStructuredOutput(text: string, expectedKind: string): boolean {
  return parseJsonOutput(text, expectedKind) !== undefined;
}

/**
 * AIOA owns the active model, tools, and permissions. This adapter requests a
 * preview-only Dext result and never reads private browser stores or IPC data.
 */
export function aioaBootstrapPrompt(): string {
  return [
    "You are the AIOA execution adapter for Dext.",
    "Handle the following typed Dext request in the current AIOA conversation.",
    "A Define API <name> declaration remains active for this conversation. Later Request objects reference it by API name; defining the same name again replaces its previous definition.",
    "Do not modify workspace files, install packages, or run commands that change state. For code edits, return a preview patch only.",
    "Do not reveal private chain-of-thought. You may use tools, then return only one JSON object that conforms exactly to the referenced API's Output definition."
  ].join("\n\n");
}

function fieldScalarType(field: FieldDefinition, type: FieldDefinition["type"]): string {
  if (type === "context") return "Context";
  if (type === "result") return "DextResult";
  if (type === "enum") return field.values?.length
    ? field.values.map((value) => JSON.stringify(value)).join("|")
    : "string";
  return type;
}

function fieldType(field: FieldDefinition): string {
  const types = [...new Set([field.type, ...(field.accepts ?? [])])]
    .map((type) => fieldScalarType(field, type));
  const scalar = types.join("|");
  return field.multiple ? `${types.length > 1 ? `(${scalar})` : scalar}[]` : scalar;
}

export function aioaInputType(fields: readonly FieldDefinition[]): string {
  return fields.map((field) => {
    const optional = !field.required || field.default !== undefined ? "?" : "";
    const defaultValue = field.default === undefined ? "" : `=${JSON.stringify(field.default)}`;
    return `${field.name}${optional}:${fieldType(field)}${defaultValue}`;
  }).join(", ");
}

type JsonSchema = Record<string, unknown>;

function stableSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSchema);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, stableSchema(child)])
  );
}

function localSchemaReference(root: JsonSchema, reference: string): JsonSchema | undefined {
  if (!reference.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const segment of reference.slice(2).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    current = record(current)?.[key];
  }
  return record(current);
}

function schemaUnion(types: readonly string[]): string {
  const unique = [...new Set(types)];
  return unique.length === 1 ? unique[0]! : unique.join("|");
}

function schemaType(value: unknown, root: JsonSchema, resolving: ReadonlySet<string>): string {
  const schema = record(value);
  if (!schema) return "unknown";
  let result: string | undefined;
  let hasLiteral = false;
  if (typeof schema.$ref === "string") {
    if (resolving.has(schema.$ref)) return "unknown";
    const target = localSchemaReference(root, schema.$ref);
    if (target) result = schemaType(target, root, new Set([...resolving, schema.$ref]));
  }
  if ("const" in schema) {
    result = JSON.stringify(schema.const);
    hasLiteral = true;
  } else if (Array.isArray(schema.enum) && schema.enum.length) {
    result = schemaUnion(schema.enum.map((item) => JSON.stringify(item)));
    hasLiteral = true;
  }

  for (const key of ["anyOf", "oneOf"]) {
    const alternatives = Array.isArray(schema[key]) ? schema[key] as unknown[] : [];
    if (!alternatives.length) continue;
    const union = schemaUnion(alternatives.map((item) => schemaType(item, root, resolving)));
    result = result ? `(${result})&(${union})` : union;
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    const intersection = schema.allOf.map((item) => schemaType(item, root, resolving)).join("&");
    result = result ? `(${result})&${intersection}` : intersection;
  }

  const declaredTypes = Array.isArray(schema.type)
    ? schema.type.filter((item): item is string => typeof item === "string")
    : typeof schema.type === "string" ? [schema.type] : [];
  const concreteTypes = declaredTypes.map((type) => {
    if (type === "null") return "null";
    if (type === "integer") return "number";
    if (type === "array") {
      const itemType = schemaType(schema.items, root, resolving);
      return `${itemType.includes("|") || itemType.includes("&") ? `(${itemType})` : itemType}[]`;
    }
    if (type !== "object") return type;
    const properties = record(schema.properties) ?? {};
    const required = new Set(
      Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []
    );
    const members = Object.entries(properties).map(([key, child]) =>
      `${JSON.stringify(key)}${required.has(key) ? "" : "?"}:${schemaType(child, root, resolving)}`
    );
    if (schema.additionalProperties === true) members.push("[key:string]:unknown");
    else if (record(schema.additionalProperties)) {
      members.push(`[key:string]:${schemaType(schema.additionalProperties, root, resolving)}`);
    }
    return `{${members.join(",")}}`;
  });
  if (concreteTypes.length && !hasLiteral) {
    const concrete = schemaUnion(concreteTypes);
    result = result ? `(${result})&${concrete}` : concrete;
  }
  if (!result && (schema.properties || "additionalProperties" in schema)) {
    result = schemaType({ ...schema, type: "object" }, root, resolving);
  }
  result ??= "unknown";
  if (schema.nullable === true && !result.split("|").includes("null")) result = `${result}|null`;
  return result;
}

export function aioaOutputType(value: object): string {
  const root = stableSchema(value) as JsonSchema;
  return schemaType(root, root, new Set());
}

export function aioaRequestPayload(request: AgentExecutionRequest): string {
  const fields = new Map(request.method.input.map((field) => [field.name, field]));
  const payload: Record<string, unknown> = { api: request.method.id };
  for (const [name, rawValue] of Object.entries(request.resolved.arguments)) {
    if (rawValue === undefined) continue;
    const field = fields.get(name);
    let value = displayValue(rawValue);
    if (field?.multiple && !Array.isArray(value)) value = [value];
    const acceptsContext = field?.type === "context" || field?.accepts?.includes("context") === true;
    if (acceptsContext && Array.isArray(value) && value.length === 0) continue;
    payload[name] = value;
  }
  return JSON.stringify(payload);
}

export function aioaApiDefinition(request: AgentExecutionRequest): string {
  return [
    `Define API ${request.method.id}`,
    `Input: ${aioaInputType(request.method.input)}`,
    `Output: ${aioaOutputType(request.contract.outputJsonSchema)}`
  ].join("\n");
}

function aioaDefinitionSignature(request: AgentExecutionRequest): string {
  return JSON.stringify({
    version: request.method.version,
    input: aioaInputType(request.method.input),
    output: aioaOutputType(request.contract.outputJsonSchema)
  });
}

export function aioaTurnPrompt(request: AgentExecutionRequest, includeDefinition = true): string {
  const requestPrompt = `Request: ${aioaRequestPayload(request)}`;
  return includeDefinition ? `${aioaApiDefinition(request)}\n\n${requestPrompt}` : requestPrompt;
}

export function aioaExecutionPrompt(request: AgentExecutionRequest): string {
  return `Dext task: ${request.method.title}\n\n${aioaBootstrapPrompt()}\n\n${aioaTurnPrompt(request, true)}`;
}

class ChromeRemoteAioaPage implements AioaCdpPage {
  constructor(private readonly client: CDP.Client) {}

  async state(): Promise<AioaConversationState> {
    const snapshot = await this.evaluate<{ busy: boolean; assistantIds: string[]; conversationId?: string }>(`
      (() => {
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const assistantMessages = [...document.querySelectorAll('${ASSISTANT_MESSAGE_SELECTOR}')].filter(isVisible);
        const userMessage = [...document.querySelectorAll('${USER_MESSAGE_SELECTOR}')].find(isVisible);
        return JSON.stringify({
          busy: [...document.querySelectorAll('button[aria-label="停止生成"]')]
            .some((button) => isVisible(button) && !button.disabled),
          assistantIds: assistantMessages
            .map((message, index) => message.getAttribute('data-message-id') || 'position:' + index),
          conversationId: userMessage?.getAttribute('data-message-id') || undefined
        });
      })()
    `);
    return {
      busy: snapshot.busy === true,
      assistantIds: snapshot.assistantIds.filter((id) => typeof id === "string"),
      ...(snapshot.conversationId ? { conversationId: snapshot.conversationId } : {})
    };
  }

  async createConversation(workspaceRoot: string): Promise<void> {
    await openAioaWorkspaceConversation(workspaceRoot, {
      snapshot: async () => this.conversationSetupSnapshot(),
      click: async (point) => this.click(point),
      replaceText: async (point, text) => replaceAioaText(this.client.Input, point, text)
    });
  }

  async submit(message: string): Promise<void> {
    const document = await this.client.DOM.getDocument({ depth: 1 });
    const selector = await this.client.DOM.querySelector({ nodeId: document.root.nodeId, selector: COMPOSER_SELECTOR });
    if (!selector.nodeId) {
      throw new Error("AIOA's message editor was not found. Open an AIOA conversation and retry.");
    }
    await this.client.DOM.focus({ nodeId: selector.nodeId });
    await this.client.Input.insertText({ text: message });
    await this.client.Input.dispatchKeyEvent({
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });
    await this.client.Input.dispatchKeyEvent({
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });
  }

  async updatesAfter(assistantIds: ReadonlySet<string>): Promise<AioaConversationUpdate> {
    const snapshot = await this.evaluate<{ busy: boolean; messages: AioaAssistantMessage[]; conversationId?: string }>(`
      (() => {
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const assistantMessages = [...document.querySelectorAll('${ASSISTANT_MESSAGE_SELECTOR}')].filter(isVisible);
        const userMessage = [...document.querySelectorAll('${USER_MESSAGE_SELECTOR}')].find(isVisible);
        return JSON.stringify({
          busy: [...document.querySelectorAll('button[aria-label="停止生成"]')]
            .some((button) => isVisible(button) && !button.disabled),
          messages: assistantMessages
            .map((message, index) => {
              const finalContent = [...message.querySelectorAll('.aioa-chat-rich-content')]
                .filter((content) => !content.closest('.aioa-work-log'))
                .at(-1);
              return {
                id: message.getAttribute('data-message-id') || 'position:' + index,
                text: (finalContent?.innerText || '').trim()
              };
            })
            .slice(-4),
          conversationId: userMessage?.getAttribute('data-message-id') || undefined
        });
      })()
    `);
    return {
      busy: snapshot.busy === true,
      messages: snapshot.messages.filter((message) => !assistantIds.has(message.id) && message.text.length > 0),
      ...(snapshot.conversationId ? { conversationId: snapshot.conversationId } : {})
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async conversationSetupSnapshot(): Promise<AioaConversationSetupSnapshot> {
    return this.evaluate<AioaConversationSetupSnapshot>(`
      (() => {
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const point = (element) => {
          if (!element || !isVisible(element)) return undefined;
          const rect = element.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        };
        const text = (element) => (element?.innerText || element?.textContent || '').trim();
        const globalNewTaskPoints = [...document.querySelectorAll('button')]
          .filter((button) => isVisible(button)
            && text(button) === '新建任务')
          .map(point)
          .filter(Boolean);
        const composer = document.querySelector('form.aioa-biz-chat-composer');
        const emptyWorkspaceSelector = [...document.querySelectorAll('button[aria-expanded]')]
          .filter(isVisible)
          .find((button) => button.getAttribute('aria-label') === '选择工作空间'
            || button.getAttribute('title') === '选择工作空间');
        const selectedWorkspaceSelector = composer
          ? [...composer.querySelectorAll('button[aria-expanded]')]
            .filter(isVisible)
            .find((button) => Boolean(button.querySelector('svg.lucide-folder, svg.lucide-folder-open')))
          : undefined;
        const workspaceSelector = emptyWorkspaceSelector || selectedWorkspaceSelector;
        const workspaceSelectorPoint = point(workspaceSelector);
        const workspaceSearch = document.querySelector('input[placeholder="搜索工作空间"]');
        const workspaceSearchPoint = point(workspaceSearch);
        const pickerRoot = workspaceSearch?.closest('[class*="project-picker"]') || document;
        const workspaceRows = [...pickerRoot.querySelectorAll('button[role="menuitemradio"]')]
          .filter(isVisible)
          .map((row) => ({
            name: text(row),
            point: point(row),
            selected: row.getAttribute('aria-checked') === 'true'
          }))
          .filter((row) => row.point && row.name !== '不使用工作空间');
        const selectedProject = composer
          ? [...composer.querySelectorAll('.aioa-composer-context-project')].find(isVisible)
          : undefined;
        const selectorText = text(workspaceSelector);
        const selectedWorkspaceName = text(selectedProject)
          || (selectorText && selectorText !== '选择工作空间' ? selectorText : undefined);
        const visibleMessageCount = [...document.querySelectorAll('article.aioa-message.user, article.aioa-message.assistant')]
          .filter(isVisible)
          .length;
        return JSON.stringify({
          globalNewTaskPoints,
          visibleMessageCount,
          workspaceRows,
          ...(workspaceSelectorPoint ? { workspaceSelectorPoint } : {}),
          ...(workspaceSearchPoint ? { workspaceSearchPoint } : {}),
          ...(selectedWorkspaceName ? { selectedWorkspaceName } : {})
        });
      })()
    `);
  }

  private async click(point: AioaPagePoint): Promise<void> {
    await clickAioaPoint(this.client.Input, point);
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const response = await this.client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    if (typeof response.result.value !== "string") {
      throw new Error("AIOA returned an unexpected CDP page response.");
    }
    try {
      return JSON.parse(response.result.value) as T;
    } catch {
      throw new Error("AIOA returned invalid CDP page data.");
    }
  }
}

class ChromeRemoteAioaConnector implements AioaCdpConnector {
  async connect(endpoint: string): Promise<AioaCdpPage> {
    const options = cdpConnectionOptions(endpoint);
    const targets = await CDP.List(options);
    const target = targets.find((candidate) => candidate.type === "page" && candidate.url.startsWith("app://"));
    if (!target) throw new Error("AIOA CDP is reachable, but its main page is not ready.");
    const client = await CDP({ ...options, target: target.id });
    try {
      await client.DOM.enable({});
      return new ChromeRemoteAioaPage(client);
    } catch (error) {
      await client.close();
      throw error;
    }
  }
}

class NodeAioaProcessLauncher implements AioaProcessLauncher {
  async launch(executable: string, args: readonly string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }
}

/** Opens an existing local AIOA CDP instance, optionally launching it first. */
export class DefaultAioaCdpConnection implements AioaCdpConnection {
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly connector: AioaCdpConnector = new ChromeRemoteAioaConnector(),
    private readonly launcher: AioaProcessLauncher = new NodeAioaProcessLauncher(),
    options: AioaCdpConnectionOptions = {}
  ) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.wait = options.sleep ?? sleep;
  }

  async open(profile: AgentProfile): Promise<{ page: AioaCdpPage; launched: boolean }> {
    if (profile.provider !== "aioa") throw new Error("AIOA CDP can only open the AIOA profile.");
    const endpoint = normalizeAioaCdpEndpoint(profile.endpoint ?? "");
    try {
      return { page: await this.connector.connect(endpoint), launched: false };
    } catch (initialError) {
      if (profile.connectionMode !== "launch") {
        const detail = initialError instanceof Error ? initialError.message : String(initialError);
        throw new Error(
          `Unable to attach to AIOA at ${endpoint}: ${detail}. `
          + "Choose Dext: Configure Agent > AIOA > Launch to start AIOA automatically."
        );
      }
    }

    const executable = resolveAioaExecutable(profile.command);
    await this.launcher.launch(executable, aioaLaunchArguments(endpoint));
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return { page: await this.connector.connect(endpoint), launched: true };
      } catch (error) {
        lastError = error;
        await this.wait(this.pollIntervalMs);
      }
    }
    const detail = lastError instanceof Error ? lastError.message : "unknown startup error";
    throw new Error(
      `AIOA did not expose CDP at ${endpoint} after launch. Quit an existing AIOA instance and run again. ${detail}`
    );
  }
}

/** CDP runner for user-authorized Dext turns in a Dext-owned AIOA task. */
interface AioaOwnedSession {
  conversationId: string;
  apiDefinitions: Map<string, string>;
}

export class AioaCdpAgentRunner implements AgentRunner {
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly sessions = new Map<string, AioaOwnedSession>();

  constructor(
    private readonly connection: AioaCdpConnection = new DefaultAioaCdpConnection(),
    options: AioaCdpRunnerOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.wait = options.sleep ?? sleep;
  }

  endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async run(request: AgentExecutionRequest): Promise<unknown> {
    if (request.profile.provider !== "aioa") throw new Error("AIOA CDP runner can only execute the AIOA profile.");
    request.onEvent?.({ phase: "status", text: "Connecting to AIOA" });
    const { page, launched } = await this.connection.open(request.profile);
    try {
      const before = await page.state();
      if (before.busy) {
        throw new Error("AIOA is already generating. Wait for its current response before running Dext.");
      }
      const sessionId = request.metadata.agentSessionId;
      const ownedSession = sessionId ? this.sessions.get(sessionId) : undefined;
      const ownedConversation = ownedSession?.conversationId;
      const definitionSignature = aioaDefinitionSignature(request);
      const includeDefinition = ownedSession?.apiDefinitions.get(request.method.id) !== definitionSignature;
      let initial: AioaConversationState;
      let prompt: string;
      if (ownedConversation) {
        if (before.conversationId !== ownedConversation) {
          throw new Error("The active AIOA task is not the task created for this Dext Output session. Switch back or clear Dext Output to start a new task.");
        }
        initial = before;
        prompt = aioaTurnPrompt(request, includeDefinition);
        request.onEvent?.({ phase: "status", text: "Using Dext's existing AIOA task" });
      } else {
        request.onEvent?.({
          phase: "status",
          text: launched ? "AIOA started; creating a task in the Dext workspace" : "Creating an AIOA task in the Dext workspace"
        });
        await page.createConversation(request.cwd);
        initial = await page.state();
        prompt = aioaExecutionPrompt(request);
      }
      await page.submit(prompt);
      if (ownedSession && includeDefinition) {
        ownedSession.apiDefinitions.set(request.method.id, definitionSignature);
      }
      const knownMessages = new Set(initial.assistantIds);
      const deadline = Date.now() + this.timeoutMs;
      let observedAssistant = false;
      let lastText = "";
      let conversationId = ownedConversation;
      while (Date.now() < deadline) {
        await this.wait(this.pollIntervalMs);
        const update = await page.updatesAfter(knownMessages);
        if (!conversationId && update.conversationId) {
          conversationId = update.conversationId;
          if (sessionId) {
            this.sessions.set(sessionId, {
              conversationId,
              apiDefinitions: new Map([[request.method.id, definitionSignature]])
            });
          }
        }
        const text = update.messages.at(-1)?.text.trim() ?? "";
        if (text) {
          observedAssistant = true;
          if (text !== lastText && !looksLikeStructuredOutput(text, request.method.output.kind)) {
            request.onEvent?.({ phase: "message", id: "aioa-response", text, replace: true });
          }
          lastText = text;
        }
        if (observedAssistant && !update.busy) {
          if (!conversationId) {
            throw new Error("AIOA did not expose the new task identity required for safe Dext conversation reuse.");
          }
          const result = parseJsonOutput(lastText, request.method.output.kind);
          if (result === undefined || !record(result)) {
            throw new Error("AIOA did not return the JSON result required by this Dext API.");
          }
          return result;
        }
      }
      throw new Error("AIOA did not finish before Dext's 10 minute timeout.");
    } finally {
      await page.close();
    }
  }
}
