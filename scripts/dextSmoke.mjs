/**
 * The Phase 0 smoke check: real TypeScript -> long-lived kernel -> steps.
 *
 * It plays the extension host's part by hand (spawn, handshake, answer `ask`)
 * with no VS Code involved, so it can prove the loop from a terminal:
 *
 *   node scripts/dextSmoke.mjs [file.ts]
 *
 * Defaults to `test/fixtures/language.ts`. Exits non-zero unless the run records
 * an `ask` step, a stdout step and a stderr step, and the module's own output is
 * returned to the caller.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerDirectory = path.join(root, "src", "runner");
const entry = path.resolve(process.argv[2] ?? path.join(root, "test", "fixtures", "language.ts"));

const child = spawn(
  process.execPath,
  ["--import", pathToFileURL(path.join(runnerDirectory, "dextLoader.mjs")).href, path.join(runnerDirectory, "dextKernel.mjs")],
  {
    cwd: root,
    env: {
      ...process.env,
      DEXT_WORKSPACE_ROOT: root,
      DEXT_LOADER_AUTOREGISTER: "1"
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  }
);

const steps = [];
let runId = 1;

child.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  switch (message.type) {
    case "ready":
      console.log(`kernel ready: node ${message.node}, native TypeScript: ${message.nativeTypescript}`);
      child.send({ type: "run", id: runId, file: entry });
      return;
    case "request":
      // Stand in for DextRuntime.execute: `ask` without an Agent profile answers
      // with its own input, which is exactly what the extension host's fallback
      // handler does.
      child.send({
        type: "response",
        requestId: message.id,
        response: {
          invocation: { kind: "invocation", method: message.method, arguments: [], source: "code" },
          method: { id: message.method, title: message.method, kind: "builtin", source: "builtin" },
          result: { kind: "ask", text: String(message.arguments.input ?? "") },
          durationMs: 0
        }
      });
      return;
    case "step":
      steps.push(message.step);
      if (message.step.stream) {
        console.log(`step stream/${message.step.stream.channel}: ${JSON.stringify(message.step.stream.text)}`);
      } else {
        console.log(`step ${message.step.method} ${message.step.state} -> ${JSON.stringify(message.step.response?.result ?? message.step.error)}`);
      }
      return;
    case "runDone": {
      console.log(`runDone ok=${message.ok} result=${JSON.stringify(message.result ?? null)}`);
      const channels = steps.filter((step) => step.stream).map((step) => step.stream.channel);
      const failures = [];
      if (!steps.some((step) => step.method === "ask" && step.response)) failures.push("no ask step");
      if (!channels.includes("stdout")) failures.push("no stdout step");
      if (!channels.includes("stderr")) failures.push("no stderr step");
      if (!message.ok) failures.push(`run failed: ${message.error}`);
      child.send({ type: "shutdown" });
      if (failures.length) {
        console.error(`smoke failed: ${failures.join(", ")}`);
        process.exitCode = 1;
      } else {
        console.log("smoke passed: ask + stdout + stderr steps recorded by one kernel.");
      }
      return;
    }
    case "fatal":
      console.error(`kernel fatal: ${message.message}`);
      process.exitCode = 1;
      child.kill();
      return;
    default:
      return;
  }
});

child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("exit", (code) => {
  if (process.exitCode) return;
  if (code !== 0 && code !== null) {
    console.error(`kernel exited with code ${code}`);
    process.exitCode = 1;
  }
});
