/**
 * The kernel: one long-lived Node process that runs a user's TypeScript.
 *
 * Started by `src/runner/dextHost.ts` with `--import ./dextLoader.mjs`, it
 * answers the message shapes in `dextProtocol.ts`:
 *
 * - `ready` once the loader is installed;
 * - `run` for each composer run: the loader is re-registered with a fresh
 *   generation so every workspace module is evaluated again, then the entry
 *   module is imported (and its exported `main` awaited when it has one). Calls
 *   the module left running are awaited before the run is reported: a run is not
 *   over while it is waiting for a Dext API;
 * - `request`/`step` messages come from `dextRuntime.mjs`, which user code gets
 *   through `import { ask } from "dext"`;
 * - `runDone` with the module's return value or a readable error.
 *
 * `console.log` / `console.error` are captured per run as process-output steps
 * (chunks written in the same tick are merged, one step is capped at 64 KiB) and
 * are still forwarded to the real streams. An object argument is rendered as
 * indented JSON rather than `util.inspect`'s depth-limited `[Object]`, so a logged
 * payload reaches Output whole.
 */

import * as nodeModule from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { silenceTypeStrippingWarnings } from "./dextWarnings.mjs";

const LOADER_URL = new URL("./dextLoader.mjs", import.meta.url);
const MAX_STREAM_CHUNK = 64 * 1024;
const workspaceRoot = path.resolve(process.env.DEXT_WORKSPACE_ROOT ?? process.cwd());

silenceTypeStrippingWarnings();

let generation = 0;
let activeRuntime;

function send(message) {
  if (typeof process.send === "function") process.send(message);
}

const streams = {
  stdout: { channel: "stdout", text: "", scheduled: false },
  stderr: { channel: "stderr", text: "", scheduled: false }
};

function streamStep(state, text) {
  send({ type: "step", step: { method: state.channel, state: "success", stream: { channel: state.channel, text } } });
}

function flush(state) {
  if (!state.text) return;
  const text = state.text;
  state.text = "";
  streamStep(state, text);
}

function append(state, text) {
  if (!activeRuntime?.isRunActive()) return;
  state.text += text;
  while (state.text.length >= MAX_STREAM_CHUNK) {
    const head = state.text.slice(0, MAX_STREAM_CHUNK);
    state.text = state.text.slice(MAX_STREAM_CHUNK);
    streamStep(state, head);
  }
  if (state.scheduled) return;
  state.scheduled = true;
  setImmediate(() => {
    state.scheduled = false;
    flush(state);
  });
}

function flushAll() {
  flush(streams.stdout);
  flush(streams.stderr);
}

// `dextRuntime.mjs` calls this before it records a step, so console output that
// happened before a call always arrives before the call's own step.
globalThis.__dextFlushStreams = flushAll;

function capture(channel) {
  const state = streams[channel];
  const original = process[channel].write.bind(process[channel]);
  process[channel].write = (chunk, encoding, callback) => {
    let text;
    if (typeof chunk === "string") text = chunk;
    else if (Buffer.isBuffer(chunk)) text = chunk.toString(typeof encoding === "string" ? encoding : "utf8");
    else text = String(chunk);
    append(state, text);
    return original(chunk, encoding, callback);
  };
}

capture("stdout");
capture("stderr");

/** Whether a value is plain data JSON can carry: a plain object, an array, or null. */
function isPlainData(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null || Array.isArray(value);
}

/**
 * One `console` argument as Output shows it.
 *
 * A logged object used to reach Output through `util.inspect`'s defaults, which stop at
 * depth 2 — a payload nested three deep arrived as `[Object]` — and quote strings with
 * single quotes, which nothing else in Dext does. An object is therefore rendered as
 * indented JSON before Node's own formatting joins the line. Strings and primitives are
 * passed through untouched, so `%s`/`%d`, `%o` and the space join keep working. A value
 * JSON cannot carry (a `Map`, a cycle, a class instance) falls back to `util.inspect`,
 * which shows its structure at full depth instead of dropping it.
 */
function consoleArgument(value) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return value.stack ?? String(value);
  if (isPlainData(value)) {
    try {
      const json = JSON.stringify(value, null, 2);
      if (json !== undefined) return json;
    } catch {
      // A cycle or a getter that throws: `inspect` below shows what it can.
    }
  }
  return inspect(value, { depth: null, colors: false, breakLength: 100 });
}

/** `console` as a browser has it: an object argument is rendered as a value, not lost to
 * `[Object]`. The captured text is what Output and History already render. */
function patchConsole() {
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const original = console[method];
    if (typeof original !== "function") continue;
    console[method] = (...args) => original(...args.map((argument) => consoleArgument(argument)));
  }
}

patchConsole();

function describeError(error) {
  if (error instanceof Error) {
    const code = typeof error.code === "string" ? ` (${error.code})` : "";
    return `${error.message}${code}`;
  }
  return String(error);
}

/**
 * A run that used one of Dext's own names as if it were a global — `git.commit()`
 * was the old `.dx` spelling, and `ask(...)` needs an import — fails with V8's
 * `X is not defined`. The names are known here: the built-in ones are the runtime
 * module's exports, and an API directory named `X` is what the specifier resolves to.
 * Saying so is the difference between a squiggle and a fix.
 *
 * The binding the suggestion names is one the module actually exports: Dext runs
 * `main`, so that is what an API normally exports, and a module that exports something
 * else is imported by a name it has rather than by `main`.
 */
/**
 * The runtime module user code imports, loaded through this kernel's own loader:
 * `dext` is what `dextLoader.mjs` maps to the runtime file it hands to user code, so
 * the kernel and user code share one instance. A copy bundled into this file would
 * keep its own in-flight registry, and a run that called an API without `await` would
 * be reported finished while the call — and the agent behind it — was still running.
 */
function runtimeModule() {
  return import("dext").catch(() => undefined);
}

async function undefinedNameHint(message, apiRoots) {
  const match = /^([A-Za-z_$][A-Za-z0-9_$]*) is not defined/.exec(message);
  if (!match) return message;
  const name = match[1];
  const runtime = await runtimeModule();
  if (runtime && name in runtime) return `${message}\nCode mode imports what it calls, so use: import { ${name} } from "dext";`;
  for (const root of apiRoots) {
    let entries;
    let directory = path.join(root, name);
    try {
      entries = readdirSync(directory);
    } catch {
      // Not a directory below this root: `.dext/api/<name>.ts` is handled here.
      try {
        if (!readdirSync(root).includes(`${name}.ts`)) continue;
        directory = root;
        entries = [`${name}.ts`];
      } catch {
        continue;
      }
    }
    const file = entries.filter((entry) => /\.(ts|mts)$/.test(entry)).sort()[0];
    if (!file) continue;
    const leaf = file.replace(/\.(ts|mts)$/, "");
    const source = readFileSync(path.join(directory, file), "utf8");
    const names = [...source.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((entry) => entry[1]);
    for (const entry of source.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) names.push(entry[1]);
    const alias = leaf !== "main" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(leaf) ? leaf : "main";
    const fallback = alias === "main" ? "main" : `main as ${alias}`;
    const binding = names.includes("main") ? fallback : names.includes(alias) ? alias : names[0] ?? fallback;
    const specifier = directory === root ? `dext/api/${leaf}` : `dext/api/${name}/${leaf}`;
    return `${message}\nCode mode imports what it calls, so use: import { ${binding} } from "${specifier}";`;
  }
  return message;
}

async function run(id, file, replay, apiRoots) {
  const roots = Array.isArray(apiRoots) && apiRoots.length ? apiRoots : [path.join(workspaceRoot, ".dext", "api")];
  generation += 1;
  nodeModule.register(LOADER_URL, {
    parentURL: import.meta.url,
    data: { workspaceRoot, generation, apiRoots: roots }
  });
  // Read by `dextRuntime.mjs`. Reset for every run so one attempt can never replay
  // another attempt's recorded calls.
  globalThis.__dextReplay = Array.isArray(replay) ? replay : [];
  globalThis.__dextReplayIndex = 0;
  const runtime = await import("dext");
  activeRuntime = runtime;
  await runtime.withRun(generation, async () => {
    const entry = pathToFileURL(path.resolve(file));
    entry.searchParams.set("dextRun", String(generation));
    try {
      const module = await import(entry.href);
      const value = typeof module.main === "function" ? await module.main() : undefined;
      const settled = await settle();
      flushAll();
      if (settled.failure !== undefined) {
        send({ type: "runDone", id, ok: false, error: describeError(settled.failure) });
      } else if (value === undefined) send({ type: "runDone", id, ok: true });
      else {
        const { toDextJson } = await import("./dextSerialization.mjs");
        send({ type: "runDone", id, ok: true, result: toDextJson(value, "The run result") });
      }
    } catch (error) {
      // A failed run still waits for what it started, so the turn does not close while
      // an agent it launched is running.
      await settle();
      flushAll();
      send({ type: "runDone", id, ok: false, error: await undefinedNameHint(describeError(error), roots) });
    }
  });
}

/**
 * Waits for the calls this run left in flight before the run is reported.
 *
 * A call written without `await` is ordinary TypeScript — the editor's types already say
 * it returns a promise — so the run waits for it silently rather than reporting it. What
 * the wait is for is that the work cannot outlive the turn: a floating call that failed
 * still fails the run, instead of landing where nothing is listening.
 */
async function settle() {
  const runtime = await runtimeModule();
  return await runtime?.settleCalls() ?? {};
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "run") {
    void run(message.id, message.file, message.replay, message.apiRoots);
    return;
  }
  if (message.type === "shutdown") {
    process.exit(0);
  }
});

process.on("unhandledRejection", (reason) => {
  append(streams.stderr, `Unhandled rejection: ${describeError(reason)}\n`);
});

send({
  type: "ready",
  node: process.versions.node,
  execPath: process.execPath,
  nativeTypescript: typeof nodeModule.stripTypeScriptTypes === "function",
  protocol: 1
});
