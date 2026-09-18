import { beforeEach, describe, expect, it, vi } from "vitest";
// Load the application during test collection. Its dependency graph can take
// longer than a hook's timeout to transform while the whole suite runs in parallel.
import { DextApplication } from "../src/application.js";
import { DEFAULT_AGENT_IDLE_TIMEOUT_MS, DEFAULT_AGENT_TIMEOUT_MS } from "../src/core/agentTimeout.js";

/** The `dext` configuration node, read the way `applyTimeoutSettings` does it:
 * a section-relative key plus the caller's own fallback. */
const store = vi.hoisted(() => ({ user: new Map<string, unknown>() }));

vi.mock("vscode", () => ({
  Uri: { file: (path: string) => ({ scheme: "file", fsPath: path, toString: () => path }) },
  workspace: {
    workspaceFolders: undefined,
    isTrusted: true,
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => (store.user.has(`dext.${key}`) ? store.user.get(`dext.${key}`) : fallback)
    })
  },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  commands: { executeCommand: () => Promise.resolve() },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  }
}));

/** `applyTimeoutSettings` touches only these two collaborators, so the instance
 * is built from the prototype and stubbed rather than through the constructor. */
function applicationWithStubs() {
  const application = Object.create(DextApplication.prototype) as DextApplication;
  const setTimeouts = vi.fn();
  Object.assign(application as unknown as Record<string, unknown>, {
    agentRunner: { setTimeouts },
    workflowRuntime: { setMaxConcurrency: vi.fn() }
  });
  return { application, setTimeouts };
}

describe("agent timeout settings", () => {
  beforeEach(() => {
    store.user.clear();
  });

  it("keeps the configured limits so the result repair shares the turn budget", () => {
    store.user.set("dext.agent.timeoutMs", 120_000);
    store.user.set("dext.agent.idleTimeoutMs", 30_000);
    const { application, setTimeouts } = applicationWithStubs();

    application.applyTimeoutSettings();

    expect(setTimeouts).toHaveBeenCalledWith({ agentTimeoutMs: 120_000, agentIdleTimeoutMs: 30_000 });
    // The one-shot result repair budgets itself from these fields, so a hardcoded
    // cap can no longer abort it while the message blames a setting that never
    // applied. Keeping them here is what makes the two paths share one knob.
    expect(application).toMatchObject({ agentTimeoutMs: 120_000, agentIdleTimeoutMs: 30_000 });
  });

  it("defaults to an unlimited total limit bounded by the idle limit", () => {
    const { application, setTimeouts } = applicationWithStubs();

    application.applyTimeoutSettings();

    expect(setTimeouts).toHaveBeenCalledWith({
      agentTimeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      agentIdleTimeoutMs: DEFAULT_AGENT_IDLE_TIMEOUT_MS
    });
    expect(application).toMatchObject({ agentTimeoutMs: 0, agentIdleTimeoutMs: 600_000 });
  });

  it("falls back to the defaults for values that are not usable timeouts", () => {
    store.user.set("dext.agent.timeoutMs", -5);
    store.user.set("dext.agent.idleTimeoutMs", 1.5);
    const { application, setTimeouts } = applicationWithStubs();

    application.applyTimeoutSettings();

    expect(setTimeouts).toHaveBeenCalledWith({
      agentTimeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      agentIdleTimeoutMs: DEFAULT_AGENT_IDLE_TIMEOUT_MS
    });
    expect(application).toMatchObject({
      agentTimeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      agentIdleTimeoutMs: DEFAULT_AGENT_IDLE_TIMEOUT_MS
    });
  });
});
