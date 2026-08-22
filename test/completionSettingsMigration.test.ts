import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Memento } from "vscode";
import type { DextApplication as DextApplicationType } from "../src/application.js";

/** A stand-in for the configuration tree. VS Code builds it by splitting keys on
 * dots, so `dext.completion` is a node whose value is assembled from whatever
 * `dext.completion.*` keys exist. Reproducing that is the whole point of these
 * tests: it is what made the migration mistake the flat keys for the very
 * object it was supposed to be removing. */
const store = vi.hoisted(() => ({
  user: new Map<string, unknown>(),
  workspace: new Map<string, unknown>()
}));

const CONFIGURATION_TARGET = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

function node(scope: Map<string, unknown>, section: string): unknown {
  if (scope.has(section)) return scope.get(section);
  const children: Record<string, unknown> = {};
  const prefix = `${section}.`;
  for (const [key, value] of scope) {
    if (key.startsWith(prefix)) children[key.slice(prefix.length)] = value;
  }
  return Object.keys(children).length > 0 ? children : undefined;
}

vi.mock("vscode", () => ({
  ConfigurationTarget: CONFIGURATION_TARGET,
  Uri: { file: (path: string) => ({ scheme: "file", fsPath: path, toString: () => path }) },
  workspace: {
    workspaceFolders: undefined,
    isTrusted: true,
    onDidChangeConfiguration: () => ({ dispose() {} }),
    getConfiguration: (root?: string) => {
      const full = (section: string) => (root ? `${root}.${section}` : section);
      return {
        get: (section: string) => node(store.user, full(section)) ?? undefined,
        inspect: (section: string) => ({
          globalValue: node(store.user, full(section)),
          workspaceValue: node(store.workspace, full(section)),
          workspaceFolderValue: undefined
        }),
        update: (section: string, value: unknown, target: number) => {
          const scope = target === CONFIGURATION_TARGET.Workspace ? store.workspace : store.user;
          const key = full(section);
          if (value === undefined) scope.delete(key);
          else scope.set(key, value);
          return Promise.resolve();
        }
      };
    }
  },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  commands: { executeCommand: () => Promise.resolve() },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  }
}));

let DextApplication: new (globalState?: Memento) => DextApplicationType;

function memento(): Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => (values.has(key) ? (values.get(key) as T) : fallback) as T,
    update: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    }
  };
}

describe("completion settings migration", () => {
  beforeEach(async () => {
    store.user.clear();
    store.workspace.clear();
    ({ DextApplication } = await import("../src/application.js"));
  });

  it("moves the values out of the old object and removes it", async () => {
    store.user.set("dext.completion", { api: "anthropic", endpoint: "https://api.anthropic.com/v1", model: "claude-fast", enabled: true });
    const application = new DextApplication(memento());

    expect(await application.migrateCompletionSettings()).toBe(true);
    expect(store.user.get("dext.completion")).toBeUndefined();
    expect(store.user.get("dext.completion.model")).toBe("claude-fast");
    expect(store.user.get("dext.completion.api")).toBe("anthropic");
  });

  it("leaves flat keys alone rather than reading them back as a legacy object", async () => {
    // What the wizard writes. `inspect("completion")` reports these as an
    // object, and acting on that deletes the node they live under, which is why
    // a configured model disappeared as soon as another window opened.
    store.user.set("dext.completion.api", "openai-chat");
    store.user.set("dext.completion.endpoint", "https://models.example/v1");
    store.user.set("dext.completion.model", "deepseek-v4-pro");
    store.user.set("dext.completion.enabled", true);
    const application = new DextApplication(memento());

    expect(await application.migrateCompletionSettings()).toBe(false);
    expect(application.completionSettings().model).toBe("deepseek-v4-pro");
    expect(application.completionSettings().endpoint).toBe("https://models.example/v1");
  });

  it("runs once, so a later window cannot undo a model configured in this one", async () => {
    store.user.set("dext.completion", { model: "old-model" });
    const state = memento();
    expect(await new DextApplication(state).migrateCompletionSettings()).toBe(true);

    store.user.set("dext.completion", { model: "should-not-be-touched" });
    expect(await new DextApplication(state).migrateCompletionSettings()).toBe(false);
    expect(store.user.get("dext.completion")).toEqual({ model: "should-not-be-touched" });
  });

  it("reports the scope a value came from, so an override is visible", async () => {
    store.user.set("dext.completion.model", "user-model");
    store.workspace.set("dext.completion.endpoint", "https://project.example/v1");
    const application = new DextApplication(memento());

    expect(application.completionSettingScope("model")).toBe("user");
    expect(application.completionSettingScope("endpoint")).toBe("workspace");
    expect(application.completionSettingScope("maxTokens")).toBe("default");
  });
});
