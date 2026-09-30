/**
 * The `dext` module a user's TypeScript imports.
 *
 * Every export is one Dext capability. A call sends a `request` to the extension
 * host, which executes it through the ordinary runtime (contract validation
 * included), records a step, and answers. Steps are therefore recorded at the
 * call boundary in user code — no source rewriting is involved.
 *
 * The same module instance is shared by the kernel and by user code: the loader
 * maps the bare `dext` specifier to this file, and the kernel imports it by path.
 */

import { toDextJson } from "./dextSerialization.mjs";

const pending = new Map();
/** Request promise -> the method it called, so `settleCalls` can name the calls a
 * run let run on its own instead of only counting them. */
const inFlight = new Map();
const failures = [];
let sequence = 0;

process.on("message", (message) => {
  if (!message || typeof message !== "object" || message.type !== "response") return;
  const entry = pending.get(message.requestId);
  if (!entry) return;
  pending.delete(message.requestId);
  entry(message);
});

/** Starts a run: a failure from an earlier attempt must not fail this one. */
export function beginRun() {
  failures.length = 0;
}

/**
 * Waits for every call that is still in flight, and reports the calls the run let run
 * on its own.
 *
 * User code that calls a Dext API without `await` leaves the work behind the run: the
 * module body ends while the extension is still executing the agent the call started,
 * so the run would report success and the turn would close while the model was still
 * working — the answer, and the failure, arriving after the UI stopped listening. The
 * run waits here instead, and a floating call that failed fails the run.
 *
 * The calls are named, once each and in the order they were issued, because a result
 * the caller's own code never sees is only actionable if the report says which call
 * dropped it. The snapshot is taken before waiting: a call the waiting itself resumes
 * was awaited by user code, so it is not one the run left behind.
 */
export async function settleCalls() {
  const floating = inFlight.size;
  const methods = [...new Set(inFlight.values())];
  while (inFlight.size) {
    await Promise.allSettled([...inFlight.keys()]);
    // A finished call resumes user code, which may issue the next one.
    await new Promise((resolve) => setImmediate(resolve));
  }
  const failure = failures.shift();
  failures.length = 0;
  return { floating, methods, ...(failure === undefined ? {} : { failure }) };
}

function flushStreams() {
  if (typeof globalThis.__dextFlushStreams === "function") globalThis.__dextFlushStreams();
}

/** JSON with sorted keys; must stay identical to `stableStringify` in
 * `src/runner/dextResumeCache.ts`, which fingerprints the recorded calls. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

const REPLAY_MISMATCH =
  "The Code file or a value it reads changed since it stopped, so the recorded calls no longer line up. Retry to run it from the start.";

/**
 * A call that still matches the recorded sequence returns the recorded response
 * instead of asking the extension host again. A mismatch means the second run took
 * a different path (a clock, a random value, a direct filesystem read), which makes
 * every later recorded response unsafe to reuse — so the run stops with a readable
 * error instead of reusing the wrong answer.
 */
function replay(method, args) {
  const entries = globalThis.__dextReplay;
  if (!Array.isArray(entries)) return undefined;
  const index = globalThis.__dextReplayIndex ?? 0;
  if (index >= entries.length) return undefined;
  const entry = entries[index];
  if (entry.method !== method || stableStringify(entry.arguments) !== stableStringify(args)) {
    throw new Error(REPLAY_MISMATCH);
  }
  globalThis.__dextReplayIndex = index + 1;
  return entry.response;
}

function requireChannel() {
  if (typeof process.send !== "function") {
    throw new Error("Dext APIs are only available inside a Dext run.");
  }
}

async function invoke(method, options) {
  requireChannel();
  const args = options === undefined || options === null ? {} : options;
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${method}() takes one object of named arguments, for example ${method}({ input: "..." }).`);
  }
  const recorded = replay(method, args);
  if (recorded !== undefined) {
    flushStreams();
    process.send({ type: "step", step: { method, state: "success", response: recorded } });
    return recorded.result;
  }
  const id = ++sequence;
  const payload = {
    type: "request",
    id,
    method,
    arguments: toDextJson(args, `The arguments of ${method}()`)
  };
  flushStreams();
  const completion = new Promise((resolve, reject) => {
    pending.set(id, resolve);
    try {
      process.send(payload);
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
  inFlight.set(completion, method);
  let reply;
  try {
    reply = await completion;
  } finally {
    inFlight.delete(completion);
  }
  if (reply.error) {
    flushStreams();
    process.send({ type: "step", step: { method, state: "failed", error: reply.error } });
    // Kept for `settleCalls`: a call nobody awaited has no caller to throw into.
    failures.push(new Error(reply.error));
    throw new Error(reply.error);
  }
  flushStreams();
  process.send({ type: "step", step: { method, state: "success", response: reply.response } });
  return reply.response.result;
}

/** Ask a question and get its result. */
export async function ask(options) {
  return invoke("ask", options);
}

/** Draft or revise a plan document. */
export async function plan(options) {
  return invoke("plan", options);
}

/** Hand a task to the selected Agent CLI. */
export async function agent(options) {
  return invoke("agent", options);
}

/** Apply the patch carried by an Agent result. */
export async function apply(options) {
  return invoke("apply", options);
}

/** Run a command in the workspace and get its captured output. */
export async function terminal(options) {
  return invoke("terminal", options);
}

/** Run a Dext skill through the selected Agent CLI. */
export async function skill(options) {
  return invoke("skill", options);
}

/** Render a Dext template with model-supplied field values. */
export async function template(options) {
  return invoke("template", options);
}

/** Interactive questions. The run waits here until the user answers. */
export const ui = {
  select: (options) => invoke("ui.select", options),
  radio: (options) => invoke("ui.radio", options),
  checkbox: (options) => invoke("ui.checkbox", options),
  input: (options) => invoke("ui.input", options),
  confirm: (options) => invoke("ui.confirm", options),
  alert: (options) => invoke("ui.alert", options),
  form: (options) => invoke("ui.form", options)
};

const MCP_PROXY_MARKER = Symbol("dext.mcp");

/** `mcp.<server>.<tool>({...})` without generating a name per configured tool. */
export const mcp = new Proxy({}, {
  get: (_target, server) => {
    if (typeof server !== "string") return undefined;
    return new Proxy({}, {
      get: (_inner, tool) => {
        if (typeof tool !== "string" || tool === "then" || tool === MCP_PROXY_MARKER) return undefined;
        return (options) => invoke(`mcp.${server}.${tool}`, options);
      }
    });
  }
});
