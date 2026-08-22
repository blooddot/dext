import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import CDP from "chrome-remote-interface";
import type { AgentProfile } from "../agentProfiles.js";
import {
  displayValue,
  type AgentConversationRequest,
  type AgentExecutionRequest,
  type AgentRunner
} from "./agentRunner.js";
import { ExecutionCancelledError } from "./executionErrors.js";
import type { AgentStreamEvent, AgentToolKind, FieldDefinition } from "./types.js";

const DEFAULT_TIMEOUT_MS = 3_600_000;
const DEFAULT_POLL_INTERVAL_MS = 300;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_INITIAL_RESPONSE_TIMEOUT_MS = 75_000;
const DEFAULT_RESPONSE_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_FINAL_CONTENT_GRACE_MS = 2_000;
const EARLY_EXIT_STARTUP_GRACE_MS = 4_000;
const DEFAULT_WORKSPACE_TIMEOUT_MS = 10_000;
const DEFAULT_WORKSPACE_POLL_INTERVAL_MS = 150;
const DEFAULT_INITIAL_LOAD_TIMEOUT_MS = 15_000;
const COMPOSER_SELECTOR = "textarea.aioa-biz-composer-editor";
const ASSISTANT_MESSAGE_SELECTOR = "article.aioa-message.assistant";
const USER_MESSAGE_SELECTOR = "article.aioa-message.user[data-message-id]";

export interface AioaAssistantMessage {
  id: string;
  text: string;
}

export interface AioaWorkLogText {
  kind: "text";
  id: string;
  text: string;
}

export interface AioaWorkLogStep {
  kind: "step";
  id: string;
  title: string;
  text: string;
  done: boolean;
  stepKind: AgentToolKind;
  /** Set when AIOA nested this step inside one of its own activity groups. */
  groupId?: string;
  groupLabel?: string;
  /** Set when AIOA gave the step its own row instead of folding it into a group. */
  solo?: boolean;
}

export type AioaWorkLogSegment = AioaWorkLogText | AioaWorkLogStep;

export interface AioaConversationState {
  busy: boolean;
  assistantIds: readonly string[];
  conversationId?: string;
}

export interface AioaConversationUpdate {
  busy: boolean;
  messages: readonly AioaAssistantMessage[];
  /** Prose and command cards of the latest visible .aioa-work-log, in the order
   * AIOA rendered them, so the Process timeline can interleave them the same way. */
  segments?: readonly AioaWorkLogSegment[];
  conversationId?: string;
}

export interface AioaCdpPage {
  state(): Promise<AioaConversationState>;
  createConversation(workspaceRoot: string): Promise<void>;
  submit(message: string): Promise<void>;
  updatesAfter(assistantIds: ReadonlySet<string>): Promise<AioaConversationUpdate>;
  stop?(): Promise<boolean>;
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
  workspaceNewTaskPoints?: readonly AioaPagePoint[];
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
  launch(executable: string, args: readonly string[]): Promise<AioaStartedProcess>;
}

/** Allocates one ephemeral IPv4 loopback port for a new local AIOA instance. */
export interface AioaCdpPortAllocator {
  allocate(): Promise<number>;
}

export type AioaProcessFailure =
  | { kind: "error"; error: Error }
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null };

/** The child is unreferenced so it can outlive the host, while launch failures and early exits stay observable. */
export interface AioaStartedProcess {
  readonly pid?: number;
  failure(): AioaProcessFailure | undefined;
}

interface AioaCdpRunnerOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  initialResponseTimeoutMs?: number;
  responseIdleTimeoutMs?: number;
  finalContentGraceMs?: number;
  now?: () => number;
}

interface AioaCdpConnectionOptions {
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  portAllocator?: AioaCdpPortAllocator;
}

type JsonRecord = Record<string, unknown>;

const DEXT_BASE64_PREFIX = "dext-base64:";
const DEXT_AGENT_BASE64_INSTRUCTION = [
  "For an agent response, the outer object must be valid JSON.",
  "When agent.patch.changes[].before, agent.patch.changes[].after, or agent.files[].content contains code or other text that could be difficult to escape, encode that field as UTF-8 standard Base64 prefixed exactly with 'dext-base64:'.",
  "Do not Base64-encode any other field."
].join(" ");

function timeoutDuration(timeoutMs: number): string {
  if (timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.ceil(timeoutMs / 1_000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

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
  // AIOA 首次启动时页面需要时间渲染，先轮询等待"新建任务"按钮出现，
  // 而不是立即快照一次就判定失败。
  const initialLoadAttempts = Math.max(1, Math.floor(DEFAULT_INITIAL_LOAD_TIMEOUT_MS / pollIntervalMs) + 1);
  const initial = await waitForSetupSnapshot(
    navigator,
    initialLoadAttempts,
    pollIntervalMs,
    wait,
    (snapshot) => (snapshot.workspaceNewTaskPoints?.length ?? 0) >= 1
      || snapshot.globalNewTaskPoints.length >= 1
  );
  if (!initial) {
    throw new Error("AIOA's global new-task button was not found.");
  }
  const workspaceNewTaskPoints = initial.workspaceNewTaskPoints ?? [];
  if (workspaceNewTaskPoints.length === 1) {
    await navigator.click(workspaceNewTaskPoints[0]!);
    const selectedTask = await waitForSetupSnapshot(
      navigator,
      attempts,
      pollIntervalMs,
      wait,
      (snapshot) => snapshot.visibleMessageCount === 0
        && normalizeAioaWorkspaceName(snapshot.selectedWorkspaceName ?? "") === normalizedWorkspaceName
    );
    if (!selectedTask) {
      throw new Error(`AIOA did not open a new task in workspace '${workspaceName}'.`);
    }
    return;
  }
  if (initial.globalNewTaskPoints.length > 1) {
    throw new Error("AIOA has multiple visible global new-task buttons.");
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

function isExecutablePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\") || value.includes("/") || value.includes("\\");
}

export function resolveAioaExecutable(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync
): string {
  const configured = command.trim();
  const fallback = defaultAioaExecutable(environment);
  const checked: string[] = [];

  if (configured && !isExecutablePath(configured)) return configured;
  if (configured) {
    checked.push(configured);
    if (fileExists(configured)) return configured;
  }
  if (!checked.includes(fallback)) {
    checked.push(fallback);
    if (fileExists(fallback)) return fallback;
  }
  // A bare executable may be resolved by the platform PATH. A concrete local
  // app path is always checked before Dext attempts to launch it.
  if (!isExecutablePath(fallback)) return fallback;
  throw new Error(`AIOA executable was not found. Checked: ${checked.map((path) => `'${path}'`).join(", ")}.`);
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

function decodeDextBase64(value: unknown): unknown {
  if (typeof value !== "string" || !value.startsWith(DEXT_BASE64_PREFIX)) return value;
  const encoded = value.slice(DEXT_BASE64_PREFIX.length);
  if (encoded && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("AIOA returned invalid dext-base64 content.");
  }
  const bytes = Buffer.from(encoded, "base64");
  const decoded = bytes.toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64") !== encoded) {
    throw new Error("AIOA returned invalid UTF-8 dext-base64 content.");
  }
  return decoded;
}

/** Decodes only the optional agent code-text fields documented in the API prompt. */
function decodeAgentBase64Fields(value: JsonRecord): JsonRecord {
  const patch = record(value.patch);
  const rawChanges = Array.isArray(patch?.changes) ? patch.changes as readonly unknown[] : undefined;
  const changes = rawChanges
    ? rawChanges.map((change): unknown => {
      const item = record(change);
      if (!item) return change;
      return {
        ...item,
        ...(typeof item.before === "string" ? { before: decodeDextBase64(item.before) } : {}),
        ...(typeof item.after === "string" ? { after: decodeDextBase64(item.after) } : {})
      };
    })
    : undefined;
  const rawFiles = Array.isArray(value.files) ? value.files as readonly unknown[] : undefined;
  const files = rawFiles
    ? rawFiles.map((file): unknown => {
      const item = record(file);
      return item
        ? { ...item, ...(typeof item.content === "string" ? { content: decodeDextBase64(item.content) } : {}) }
        : file;
    })
    : undefined;
  return {
    ...value,
    ...(patch && changes ? { patch: { ...patch, changes } } : {}),
    ...(files ? { files } : {})
  };
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
 * Re-emits only the work-log segments AIOA changed since the last poll, keeping
 * their rendered order and AIOA's own step grouping so the Process timeline can
 * mirror the work log instead of reconstructing it.
 */
function workLogEvents(
  segments: readonly AioaWorkLogSegment[] | undefined,
  seen: Map<string, string>
): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  for (const segment of segments ?? []) {
    const signature = segment.kind === "text"
      ? segment.text
      : [segment.title, segment.text, segment.done, segment.groupId, segment.groupLabel].join("\u0000");
    if (seen.get(segment.id) === signature) continue;
    seen.set(segment.id, signature);
    events.push(segment.kind === "text"
      ? { phase: "message", id: segment.id, text: segment.text, group: "aioa-work-log", replace: true }
      : {
        id: segment.id,
        phase: "tool",
        title: segment.title,
        text: segment.text,
        group: "aioa-work-log",
        toolKind: segment.stepKind,
        replace: true,
        ...(segment.groupId ? { groupId: segment.groupId } : {}),
        ...(segment.groupLabel ? { groupLabel: segment.groupLabel } : {}),
        ...(segment.solo ? { solo: true } : {}),
        ...(segment.done ? { done: true } : {})
      });
  }
  return events;
}

/**
 * AIOA owns the active model, tools, and permissions. This adapter requests a
 * preview-only Dext result and never reads private browser stores or IPC data.
 */
export function aioaBootstrapPrompt(request?: Pick<AgentExecutionRequest, "method" | "allowWorkspaceWrite">): string {
  const workspacePolicy = request?.method.id === "agent" && request.allowWorkspaceWrite
    ? "You may modify files only inside the selected trusted workspace. Do not install packages or change files outside that workspace. Return an auditable patch whenever the changes can be represented."
    : request?.method.id === "agent"
      ? "This is preview-only. Do not modify workspace files, install packages, or run commands that change state. When a change is requested, return a complete applicable patch with exact before and after content."
      : "Do not modify workspace files, install packages, or run commands that change state. For code edits, return a preview patch only.";
  return [
    "You are the AIOA execution adapter for Dext.",
    "Handle the following typed Dext request in the current AIOA conversation.",
    "A Define API <name> declaration remains active for this conversation. Later Request objects reference it by API name; defining the same name again replaces its previous definition.",
    workspacePolicy,
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
  return fields.filter((field) => !field.internal).map((field) => {
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
    if (field?.internal) continue;
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
    `Output: ${aioaOutputType(request.contract.outputJsonSchema)}`,
    ...(request.method.id === "agent" ? [DEXT_AGENT_BASE64_INSTRUCTION] : [])
  ].join("\n");
}

function aioaDefinitionSignature(request: AgentExecutionRequest): string {
  return JSON.stringify({
    version: request.method.version,
    input: aioaInputType(request.method.input),
    output: aioaOutputType(request.contract.outputJsonSchema),
    ...(request.method.id === "agent" ? { codeTextEncoding: DEXT_AGENT_BASE64_INSTRUCTION } : {})
  });
}

export function aioaTurnPrompt(request: AgentExecutionRequest, includeDefinition = true): string {
  const requestPrompt = `Request: ${aioaRequestPayload(request)}`;
  return includeDefinition ? `${aioaApiDefinition(request)}\n\n${requestPrompt}` : requestPrompt;
}

function aioaJsonRepairPrompt(request: AgentExecutionRequest): string {
  return [
    "Your previous response was not valid JSON for the active Dext API.",
    "Return only one replacement JSON object conforming exactly to the original Output definition. Do not include Markdown, explanation, or any text outside that object.",
    `The replacement object's kind must be ${JSON.stringify(request.method.output.kind)}.`,
    DEXT_AGENT_BASE64_INSTRUCTION
  ].join("\n\n");
}

export function aioaExecutionPrompt(request: AgentExecutionRequest): string {
  return [
    `Dext task: ${request.method.title}`,
    request.metadata.instruction,
    aioaBootstrapPrompt(request),
    aioaTurnPrompt(request, true)
  ].filter((part): part is string => Boolean(part)).join("\n\n");
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
    const workspaceName = workspaceNameFromRoot(workspaceRoot);
    await openAioaWorkspaceConversation(workspaceRoot, {
      snapshot: async () => this.conversationSetupSnapshot(workspaceName),
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
    const snapshot = await this.evaluate<{
      busy: boolean;
      messages: AioaAssistantMessage[];
      segments?: AioaWorkLogSegment[];
      conversationId?: string;
    }>(`
      (() => {
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const assistantMessages = [...document.querySelectorAll('${ASSISTANT_MESSAGE_SELECTOR}')].filter(isVisible);
        const userMessage = [...document.querySelectorAll('${USER_MESSAGE_SELECTOR}')].find(isVisible);
        const workLog = assistantMessages
          .flatMap((message) => [...message.querySelectorAll('.aioa-work-log')])
          .filter(isVisible)
          .at(-1);
        const workLogOwner = workLog
          ? assistantMessages.find((message) => message.contains(workLog))
          : undefined;
        const workLogId = workLogOwner?.getAttribute('data-message-id') || 'work-log';
        // AIOA collapses the work log and every step inside it, and innerText is
        // empty for a hidden subtree, so labels and bodies come from textContent.
        const textOf = (element) => (element?.textContent || '').replace(/\\u00a0/g, ' ').trim();
        // A summary's parts are separate elements with no whitespace between them,
        // so concatenating textContent would glue "已编辑 6 个文件" onto "+66-36".
        const joinParts = (element) => {
          if (!element) return '';
          const parts = [...element.children]
            .map((child) => joinParts(child))
            .filter(Boolean);
          if (!parts.length) return textOf(element).replace(/\\s+/g, ' ');
          return parts.join(' ');
        };
        const rowLabel = (element) => joinParts(element.querySelector(':scope > summary')).trim();
        const noteText = (element) => {
          const rendered = (element.innerText || '').trim();
          if (rendered) return rendered;
          const blocks = [...element.querySelectorAll('.aioa-rich-content > div > *')]
            .map((block) => textOf(block))
            .filter(Boolean);
          return blocks.length ? blocks.join('\\n\\n') : textOf(element);
        };
        const stepKind = (element) => {
          if (element.querySelector('.aioa-work-command-card') || element.matches('.aioa-work-command-step')) return 'command';
          if (element.matches('.aioa-work-file-step')) return 'file';
          if (element.matches('.aioa-work-image-step')) return 'image';
          return 'step';
        };
        const stepDetail = (element) => {
          const card = element.querySelector('.aioa-work-command-card');
          if (card) {
            const tool = textOf(card.querySelector('.aioa-work-command-tool'));
            const command = textOf(card.querySelector('.aioa-work-command-text'));
            const output = textOf(card.querySelector('.aioa-work-command-output'));
            const result = textOf(card.querySelector('.aioa-work-command-result'));
            const detail = [tool, command, output, result].filter(Boolean).join('\\n\\n') || textOf(card);
            return { title: command || tool || rowLabel(element) || 'Command', text: detail };
          }
          const label = rowLabel(element) || 'Step';
          const body = [...element.children]
            .filter((child) => child.tagName.toLowerCase() !== 'summary')
            .map((child) => textOf(child))
            .filter(Boolean)
            .join('\\n');
          return { title: label, text: body && !label.includes(body) ? label + '\\n\\n' + body : label };
        };
        const segments = [];
        let textIndex = 0;
        let stepIndex = 0;
        let groupIndex = 0;
        const pushText = (value) => {
          const text = (value || '').trim();
          if (!text) return;
          const last = segments[segments.length - 1];
          if (last && last.kind === 'text') {
            last.text = last.text + '\\n\\n' + text;
            return;
          }
          segments.push({ kind: 'text', id: workLogId + ':text:' + textIndex++, text });
        };
        const pushStep = (element, group) => {
          const detail = stepDetail(element);
          segments.push({
            kind: 'step',
            id: workLogId + ':step:' + stepIndex++,
            title: detail.title,
            text: detail.text,
            done: element.classList.contains('done'),
            stepKind: stepKind(element),
            ...(group ? { groupId: group.id, groupLabel: group.label } : { solo: true })
          });
        };
        const logBody = workLog ? (workLog.querySelector('.aioa-work-log-body') || workLog) : undefined;
        for (const child of logBody ? [...logBody.children] : []) {
          if (child.tagName.toLowerCase() === 'summary') continue;
          if (child.matches('.aioa-work-activity-group')) {
            const steps = [...child.querySelectorAll(':scope > .aioa-work-activity-group-body > .aioa-work-step')];
            if (!steps.length) { pushText(textOf(child)); continue; }
            const group = {
              id: workLogId + ':group:' + groupIndex++,
              label: rowLabel(child)
            };
            for (const step of steps) pushStep(step, group);
            continue;
          }
          if (child.matches('.aioa-work-step')) { pushStep(child, undefined); continue; }
          if (child.matches('.aioa-work-note')) { pushText(noteText(child)); continue; }
          pushText(textOf(child));
        }
        if (logBody && !segments.length) pushText(textOf(logBody));
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
          ...(segments.length ? { segments } : {}),
          conversationId: userMessage?.getAttribute('data-message-id') || undefined
        });
      })()
    `);
    return {
      busy: snapshot.busy === true,
      messages: snapshot.messages.filter((message) => !assistantIds.has(message.id) && message.text.length > 0),
      ...(snapshot.segments?.length ? { segments: snapshot.segments } : {}),
      ...(snapshot.conversationId ? { conversationId: snapshot.conversationId } : {})
    };
  }

  async stop(): Promise<boolean> {
    const point = await this.evaluate<AioaPagePoint | null>(`
      (() => {
        const button = [...document.querySelectorAll('button[aria-label="停止生成"]')]
          .find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const style = getComputedStyle(candidate);
            return rect.width > 0 && rect.height > 0
              && style.display !== 'none' && style.visibility !== 'hidden'
              && !candidate.disabled;
          });
        if (!button) return JSON.stringify(null);
        const rect = button.getBoundingClientRect();
        return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      })()
    `);
    if (!point) return false;
    await this.click(point);
    return true;
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async conversationSetupSnapshot(workspaceName: string): Promise<AioaConversationSetupSnapshot> {
    const workspaceLabel = `${workspaceName} 新建任务`;
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
        const workspaceNewTaskPoints = [...document.querySelectorAll('button')]
          .filter((button) => isVisible(button)
            && button.getAttribute('aria-label') === ${JSON.stringify(workspaceLabel)})
          .map(point)
          .filter(Boolean);
        const composer = document.querySelector('form.aioa-biz-chat-composer');
        const emptyWorkspaceSelector = [...document.querySelectorAll(
          'button[aria-expanded], button[aria-label*="选择工作空间"], [aria-label*="选择工作空间"]'
        )]
          .filter(isVisible)
          .find((button) => button.getAttribute('aria-label')?.includes('选择工作空间')
            || button.getAttribute('title') === '选择工作空间');
        const selectedWorkspaceSelector = composer
          ? [...composer.querySelectorAll('button[aria-expanded], [aria-label^="工作空间："]')]
            .filter(isVisible)
            .find((button) => Boolean(button.querySelector('svg.lucide-folder, svg.lucide-folder-open'))
              || button.getAttribute('aria-label')?.startsWith('工作空间：'))
          : undefined;
        const workspaceSelector = emptyWorkspaceSelector || selectedWorkspaceSelector;
        const workspaceSelectorPoint = point(workspaceSelector);
        const workspaceSearch = document.querySelector(
          'input[placeholder*="搜索工作空间"], input[aria-label*="工作空间"], input[placeholder*="搜索"]'
        );
        const workspaceSearchPoint = point(workspaceSearch);
        const pickerRoot = workspaceSearch?.closest(
          '[role="dialog"], [role="listbox"], [class*="project-picker"], [class*="workspace-picker"], [class*="popover"], [class*="dropdown"]'
        ) || document;
        // AIOA has used menuitemradio, option, and plain data rows across
        // releases. Keep the extraction scoped to the open picker so unrelated
        // menus cannot be mistaken for workspaces.
        const workspaceRows = [...pickerRoot.querySelectorAll(
          'button[role="menuitemradio"], [role="menuitemradio"], [role="option"], [aria-label$=" 工作空间"], [aria-label^="工作空间："], [data-workspace-id], [data-project-id]'
        )]
          .filter(isVisible)
          .map((row) => {
            const label = text(row) || row.getAttribute('aria-label') || row.getAttribute('title') || '';
            const name = label
              .replace(/^工作空间：\\s*/, '')
              .replace(/\\s+工作空间\\s*$/, '')
              .trim();
            return {
              name,
              point: point(row),
              selected: row.getAttribute('aria-checked') === 'true'
            };
          })
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
          ...(workspaceNewTaskPoints.length ? { workspaceNewTaskPoints } : {}),
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
  async launch(executable: string, args: readonly string[]): Promise<AioaStartedProcess> {
    let failure: AioaProcessFailure | undefined;
    // VS Code 本身是 Electron 应用，会向子进程泄漏 ELECTRON_RUN_AS_NODE 等
    // 变量，导致 AIOA 以纯 Node 模式启动并拒绝 Chromium 的调试参数。启动前
    // 清掉这些泄漏变量，让 AIOA 以正常的 GUI 模式运行。
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (/^(ELECTRON|CHROME)/i.test(key)) delete childEnv[key];
    }
    return new Promise<AioaStartedProcess>((resolve, reject) => {
      const child = spawn(executable, args, { stdio: "ignore", cwd: dirname(executable), env: childEnv });
      const captureError = (error: Error) => {
        failure ??= { kind: "error", error };
      };
      child.on("error", captureError);
      child.once("exit", (code, signal) => {
        failure ??= { kind: "exit", code, signal };
      });
      const onSpawnError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      const onSpawn = () => {
        child.off("error", onSpawnError);
        child.unref();
        resolve({
          ...(child.pid === undefined ? {} : { pid: child.pid }),
          failure: () => failure
        });
      };
      child.once("error", onSpawnError);
      child.once("spawn", onSpawn);
    });
  }
}

/** Uses the operating system to choose a currently free local port. The socket
 * is immediately released so Chromium can bind it with its own process. */
class NodeAioaCdpPortAllocator implements AioaCdpPortAllocator {
  allocate(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      const fail = (error: Error): void => {
        server.close();
        reject(error);
      };
      server.once("error", fail);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        server.off("error", fail);
        const address = server.address();
        if (!address || typeof address === "string" || !Number.isInteger(address.port) || address.port < 1) {
          server.close(() => reject(new Error("Unable to allocate an AIOA CDP port.")));
          return;
        }
        server.close((error) => {
          if (error) reject(error);
          else resolve(address.port);
        });
      });
    });
  }
}

function startupFailureDetail(failure: AioaProcessFailure): string {
  if (failure.kind === "error") return `AIOA launch error: ${failure.error.message}`;
  const code = failure.code === null ? "null" : String(failure.code);
  const signal = failure.signal ? `, signal ${failure.signal}` : "";
  return `AIOA exited before CDP became ready (code ${code}${signal})`;
}

/** Opens an existing local AIOA CDP instance, optionally launching it first. */
export class DefaultAioaCdpConnection implements AioaCdpConnection {
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly portAllocator: AioaCdpPortAllocator;
  private dynamicEndpoint: { key: string; endpoint: string } | undefined;

  constructor(
    private readonly connector: AioaCdpConnector = new ChromeRemoteAioaConnector(),
    private readonly launcher: AioaProcessLauncher = new NodeAioaProcessLauncher(),
    options: AioaCdpConnectionOptions = {}
  ) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.wait = options.sleep ?? sleep;
    this.portAllocator = options.portAllocator ?? new NodeAioaCdpPortAllocator();
  }

  async open(profile: AgentProfile): Promise<{ page: AioaCdpPage; launched: boolean }> {
    if (profile.provider !== "aioa") throw new Error("AIOA CDP can only open the AIOA profile.");
    const endpoint = normalizeAioaCdpEndpoint(profile.endpoint ?? "");
    const cacheKey = this.dynamicCacheKey(profile, endpoint);
    if (this.dynamicEndpoint && this.dynamicEndpoint.key !== cacheKey) this.dynamicEndpoint = undefined;
    if (this.dynamicEndpoint) {
      try {
        return { page: await this.connector.connect(this.dynamicEndpoint.endpoint), launched: false };
      } catch {
        this.dynamicEndpoint = undefined;
      }
    }
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
      return this.launchOnDynamicPort(profile, endpoint, cacheKey, initialError);
    }
  }

  private dynamicCacheKey(profile: AgentProfile, endpoint: string): string {
    return `${profile.connectionMode ?? "launch"}\u0000${endpoint}\u0000${profile.command.trim()}`;
  }

  private async launchOnDynamicPort(
    profile: AgentProfile,
    fixedEndpoint: string,
    cacheKey: string,
    initialError: unknown
  ): Promise<{ page: AioaCdpPage; launched: boolean }> {
    const executable = resolveAioaExecutable(profile.command);
    const fixedDetail = initialError instanceof Error ? initialError.message : String(initialError);
    let lastError: unknown = initialError;
    let lastEndpoint: string | undefined;
    let processFailure: AioaProcessFailure | undefined;

    // A port can be claimed after allocation, so retry one new ephemeral port
    // when the first launched instance never makes CDP available.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let port: number;
      try {
        port = await this.portAllocator.allocate();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to allocate an AIOA CDP port after ${fixedEndpoint} failed: ${detail}`);
      }
      const launchEndpoint = `http://127.0.0.1:${port}`;
      lastEndpoint = launchEndpoint;
      let process: AioaStartedProcess;
      try {
        process = await this.launcher.launch(executable, aioaLaunchArguments(launchEndpoint));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to launch AIOA after ${fixedEndpoint} failed; dynamic endpoint ${launchEndpoint}: ${detail}`);
      }

      const opened = await this.waitForLaunchedCdp(process, launchEndpoint);
      if (opened.page) {
        this.dynamicEndpoint = { key: cacheKey, endpoint: launchEndpoint };
        return { page: opened.page, launched: true };
      }
      lastError = opened.lastError;
      processFailure = opened.processFailure;
    }
    const cdpDetail = lastError instanceof Error ? lastError.message : "unknown startup error";
    const processDetail = processFailure ? ` ${startupFailureDetail(processFailure)}.` : "";
    throw new Error(
      `AIOA did not expose CDP after fixed endpoint ${fixedEndpoint} failed (${fixedDetail}). `
      + `Last dynamic endpoint: ${lastEndpoint}.${processDetail} Last CDP error: ${cdpDetail}`
    );
  }

  private async waitForLaunchedCdp(
    process: AioaStartedProcess,
    launchEndpoint: string
  ): Promise<{ page?: AioaCdpPage; lastError?: unknown; processFailure?: AioaProcessFailure }> {
    let lastError: unknown;
    let processFailure: AioaProcessFailure | undefined;
    const interval = Math.max(1, this.pollIntervalMs);
    const attempts = Math.max(1, Math.ceil(this.startupTimeoutMs / interval) + 1);
    const earlyExitAttempts = Math.max(1, Math.ceil(EARLY_EXIT_STARTUP_GRACE_MS / interval) + 1);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      processFailure ??= process.failure();
      try {
        return { page: await this.connector.connect(launchEndpoint) };
      } catch (error) {
        lastError = error;
      }
      // A crashed or rejected launch can never expose CDP, so stop polling
      // immediately instead of waiting out the full startup timeout.
      if (processFailure?.kind === "error") break;
      if (processFailure?.kind === "exit") {
        if (processFailure.code !== 0) break;
        // Electron forwards a second launch to the already-running instance and
        // exits with code 0. That instance cannot adopt a new CDP port, so do
        // not make the user wait through two full startup timeouts.
        if (attempt + 1 >= earlyExitAttempts) break;
      }
      if (attempt < attempts - 1) await this.wait(this.pollIntervalMs);
    }
    return {
      ...(lastError === undefined ? {} : { lastError }),
      ...(processFailure ? { processFailure } : {})
    };
  }
}

/** CDP runner for user-authorized Dext turns in a Dext-owned AIOA task. */
interface AioaOwnedSession {
  conversationId: string;
  apiDefinitions: Map<string, string>;
}

export class AioaCdpAgentRunner implements AgentRunner {
  private timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly initialResponseTimeoutMs: number;
  private responseIdleTimeoutMs: number;
  private readonly finalContentGraceMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, AioaOwnedSession>();

  constructor(
    private readonly connection: AioaCdpConnection = new DefaultAioaCdpConnection(),
    options: AioaCdpRunnerOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.wait = options.sleep ?? sleep;
    this.initialResponseTimeoutMs = options.initialResponseTimeoutMs ?? DEFAULT_INITIAL_RESPONSE_TIMEOUT_MS;
    this.responseIdleTimeoutMs = options.responseIdleTimeoutMs ?? DEFAULT_RESPONSE_IDLE_TIMEOUT_MS;
    this.finalContentGraceMs = options.finalContentGraceMs ?? DEFAULT_FINAL_CONTENT_GRACE_MS;
    this.now = options.now ?? Date.now;
  }

  /** The overall and idle budgets are the two AIOA waits users actually hit, so
   * they follow the settings while the runner keeps its open sessions. */
  setTimeouts(timeouts: { timeoutMs?: number; responseIdleTimeoutMs?: number }): void {
    if (timeouts.timeoutMs !== undefined) this.timeoutMs = timeouts.timeoutMs;
    if (timeouts.responseIdleTimeoutMs !== undefined) {
      this.responseIdleTimeoutMs = timeouts.responseIdleTimeoutMs;
    }
  }

  endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * A Dext output session must never send into a task the user selected in
   * AIOA. When its remembered task is no longer active, discard the binding
   * so this turn creates a fresh Dext-owned task instead.
   */
  private activeSession(sessionId: string | undefined, conversationId: string | undefined): AioaOwnedSession | undefined {
    const ownedSession = sessionId ? this.sessions.get(sessionId) : undefined;
    if (ownedSession && ownedSession.conversationId !== conversationId) {
      if (sessionId) this.sessions.delete(sessionId);
      return undefined;
    }
    return ownedSession;
  }

  async run(request: AgentExecutionRequest): Promise<unknown> {
    if (request.profile.provider !== "aioa") throw new Error("AIOA CDP runner can only execute the AIOA profile.");
    if (request.signal?.aborted) throw new ExecutionCancelledError();
    request.onEvent?.({ phase: "status", text: "Connecting to AIOA" });
    const { page, launched } = await this.connection.open(request.profile);
    try {
      const before = await page.state();
      if (before.busy) {
        throw new Error("AIOA is already generating. Wait for its current response before running Dext.");
      }
      const sessionId = request.metadata.agentSessionId;
      const ownedSession = this.activeSession(sessionId, before.conversationId);
      const ownedConversation = ownedSession?.conversationId;
      const definitionSignature = aioaDefinitionSignature(request);
      const includeDefinition = ownedSession?.apiDefinitions.get(request.method.id) !== definitionSignature;
      let initial: AioaConversationState;
      let prompt: string;
      if (ownedConversation) {
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
      if (request.signal?.aborted) throw new ExecutionCancelledError();
      await page.submit(prompt);
      const submitted = await page.state();
      request.onEvent?.({ phase: "status", text: "Waiting for AIOA response" });
      if (ownedSession && includeDefinition) {
        ownedSession.apiDefinitions.set(request.method.id, definitionSignature);
      }
      const knownMessages = new Set(initial.assistantIds);
      const submittedAt = this.now();
      const deadline = submittedAt + this.timeoutMs;
      let observedAssistant = false;
      let lastText = "";
      const segmentStates = new Map<string, string>();
      let receivedActivity = false;
      let lastActivityAt = submittedAt;
      let completedWithoutResultAt: number | undefined;
      let repairPromptSubmitted = false;
      let repairGenerationObserved = false;
      let repairResponseObserved = false;
      let malformedResultId: string | undefined;
      let malformedResultText = "";
      let conversationId = ownedConversation ?? submitted.conversationId ?? initial.conversationId;
      if (sessionId && !ownedSession && conversationId) {
        this.sessions.set(sessionId, {
          conversationId,
          apiDefinitions: new Map([[request.method.id, definitionSignature]])
        });
      }
      while (this.now() < deadline) {
        await this.wait(this.pollIntervalMs);
        if (request.signal?.aborted) {
          const current = await page.state();
          const ownsCurrentTask = Boolean(conversationId && current.conversationId === conversationId);
          if (ownsCurrentTask && current.busy) await page.stop?.();
          throw new ExecutionCancelledError();
        }
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
        const latestMessage = update.messages.at(-1);
        const text = latestMessage?.text.trim() ?? "";
        if (text) {
          observedAssistant = true;
          if (repairPromptSubmitted && (latestMessage?.id !== malformedResultId || text !== malformedResultText)) {
            repairResponseObserved = true;
          }
          if (text !== lastText) {
            receivedActivity = true;
            lastActivityAt = this.now();
          }
          if (text !== lastText && !looksLikeStructuredOutput(text, request.method.output.kind)) {
            request.onEvent?.({ phase: "message", id: "aioa-response", text, replace: true });
          }
          lastText = text;
        }
        repairGenerationObserved ||= repairPromptSubmitted && update.busy;
        const workLog = workLogEvents(update.segments, segmentStates);
        if (workLog.length) {
          receivedActivity = true;
          lastActivityAt = this.now();
          for (const event of workLog) request.onEvent?.(event);
        }
        if (observedAssistant && !update.busy) {
          if (!conversationId) {
            throw new Error("AIOA did not expose the new task identity required for safe Dext conversation reuse.");
          }
          const result = parseJsonOutput(lastText, request.method.output.kind);
          const resultRecord = record(result);
          if (resultRecord) {
            return request.method.id === "agent" ? decodeAgentBase64Fields(resultRecord) : resultRecord;
          }
          if (request.method.id === "agent" && !repairPromptSubmitted) {
            repairPromptSubmitted = true;
            malformedResultId = latestMessage?.id;
            malformedResultText = lastText;
            receivedActivity = true;
            lastActivityAt = this.now();
            request.onEvent?.({ phase: "status", text: "AIOA returned malformed JSON; requesting a format-only retry" });
            await page.submit(aioaJsonRepairPrompt(request));
            continue;
          }
          if (repairPromptSubmitted && !repairGenerationObserved && !repairResponseObserved) {
            continue;
          }
          throw new Error("AIOA did not return the JSON result required by this Dext API.");
        }
        if (!observedAssistant && !update.busy) {
          completedWithoutResultAt ??= this.now();
          if (this.now() - completedWithoutResultAt >= this.finalContentGraceMs) {
            throw new Error("AIOA finished without returning the JSON result required by this Dext API.");
          }
        } else {
          completedWithoutResultAt = undefined;
        }
        const elapsedSinceActivity = this.now() - lastActivityAt;
        if (!receivedActivity && elapsedSinceActivity >= this.initialResponseTimeoutMs) {
          throw new Error(
            `AIOA did not begin responding within ${Math.ceil(this.initialResponseTimeoutMs / 1_000)} seconds. `
            + "Check that its selected model is available, then run again."
          );
        }
        if (receivedActivity && elapsedSinceActivity >= this.responseIdleTimeoutMs) {
          throw new Error(
            `AIOA stopped responding for ${Math.ceil(this.responseIdleTimeoutMs / 1_000)} seconds before returning a result. `
            + "The AIOA task may be stalled; stop it there and run again."
          );
        }
      }
      throw new Error(`AIOA did not finish before Dext's ${timeoutDuration(this.timeoutMs)} timeout.`);
    } finally {
      await page.close();
    }
  }

  /** Sends ordinary chat text to the Dext-owned AIOA conversation. This path
   * deliberately does not define an API, parse JSON, or request a repair. */
  async runConversation(request: AgentConversationRequest): Promise<string> {
    if (request.profile.provider !== "aioa") throw new Error("AIOA CDP runner can only execute the AIOA profile.");
    if (request.signal?.aborted) throw new ExecutionCancelledError();
    request.onEvent?.({ phase: "status", text: "Connecting to AIOA" });
    const { page, launched } = await this.connection.open(request.profile);
    try {
      const before = await page.state();
      if (before.busy) {
        throw new Error("AIOA is already generating. Wait for its current response before running Dext.");
      }
      const sessionId = request.metadata.agentSessionId;
      const ownedSession = this.activeSession(sessionId, before.conversationId);
      const ownedConversation = ownedSession?.conversationId;
      let initial: AioaConversationState;
      if (ownedConversation) {
        initial = before;
        request.onEvent?.({ phase: "status", text: "Using Dext's existing AIOA task" });
      } else {
        request.onEvent?.({
          phase: "status",
          text: launched ? "AIOA started; creating a task in the Dext workspace" : "Creating an AIOA task in the Dext workspace"
        });
        await page.createConversation(request.cwd);
        initial = await page.state();
      }
      if (request.signal?.aborted) throw new ExecutionCancelledError();
      await page.submit(request.input);
      const submitted = await page.state();
      request.onEvent?.({ phase: "status", text: "Waiting for AIOA response" });
      const knownMessages = new Set(initial.assistantIds);
      const submittedAt = this.now();
      const deadline = submittedAt + this.timeoutMs;
      let observedAssistant = false;
      let lastText = "";
      const segmentStates = new Map<string, string>();
      let receivedActivity = false;
      let lastActivityAt = submittedAt;
      let completedWithoutResultAt: number | undefined;
      let conversationId = ownedConversation ?? submitted.conversationId ?? initial.conversationId;
      if (sessionId && !ownedSession && conversationId) {
        this.sessions.set(sessionId, { conversationId, apiDefinitions: new Map() });
      }
      while (this.now() < deadline) {
        await this.wait(this.pollIntervalMs);
        if (request.signal?.aborted) {
          const current = await page.state();
          const ownsCurrentTask = Boolean(conversationId && current.conversationId === conversationId);
          if (ownsCurrentTask && current.busy) await page.stop?.();
          throw new ExecutionCancelledError();
        }
        const update = await page.updatesAfter(knownMessages);
        if (!conversationId && update.conversationId) {
          conversationId = update.conversationId;
          if (sessionId) this.sessions.set(sessionId, { conversationId, apiDefinitions: new Map() });
        }
        const latestMessage = update.messages.at(-1);
        const text = latestMessage?.text.trim() ?? "";
        if (text) {
          observedAssistant = true;
          if (text !== lastText) {
            receivedActivity = true;
            lastActivityAt = this.now();
            request.onEvent?.({ phase: "message", id: "aioa-response", text, replace: true });
          }
          lastText = text;
        }
        const workLog = workLogEvents(update.segments, segmentStates);
        if (workLog.length) {
          receivedActivity = true;
          lastActivityAt = this.now();
          for (const event of workLog) request.onEvent?.(event);
        }
        if (observedAssistant && !update.busy) {
          if (!conversationId) {
            throw new Error("AIOA did not expose the new task identity required for safe Dext conversation reuse.");
          }
          return lastText;
        }
        if (!observedAssistant && !update.busy) {
          completedWithoutResultAt ??= this.now();
          if (this.now() - completedWithoutResultAt >= this.finalContentGraceMs) {
            throw new Error("AIOA finished without returning a response.");
          }
        } else {
          completedWithoutResultAt = undefined;
        }
        const elapsedSinceActivity = this.now() - lastActivityAt;
        if (!receivedActivity && elapsedSinceActivity >= this.initialResponseTimeoutMs) {
          throw new Error(
            `AIOA did not begin responding within ${Math.ceil(this.initialResponseTimeoutMs / 1_000)} seconds. `
            + "Check that its selected model is available, then run again."
          );
        }
        if (receivedActivity && elapsedSinceActivity >= this.responseIdleTimeoutMs) {
          throw new Error(
            `AIOA stopped responding for ${Math.ceil(this.responseIdleTimeoutMs / 1_000)} seconds before returning a result. `
            + "The AIOA task may be stalled; stop it there and run again."
          );
        }
      }
      throw new Error(`AIOA did not finish before Dext's ${timeoutDuration(this.timeoutMs)} timeout.`);
    } finally {
      await page.close();
    }
  }
}
