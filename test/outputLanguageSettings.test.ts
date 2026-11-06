import { beforeEach, describe, expect, it, vi } from "vitest";
// Load the application during collection: its dependency graph is slower than a
// hook's timeout while the whole suite runs in parallel.
import { DextApplication } from "../src/app/application.js";

const store = vi.hoisted(() => ({
  user: new Map<string, unknown>(),
  language: "en"
}));

vi.mock("vscode", () => ({
  env: {
    get language() {
      return store.language;
    }
  },
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

/** `applyOutputLanguageSettings` touches only the runtime, so the instance is
 * built from the prototype and the runtime is stubbed. */
function applicationWithStubs() {
  const application = Object.create(DextApplication.prototype) as DextApplication;
  const setOutputLanguage = vi.fn<(language: string | undefined) => void>();
  Object.assign(application as unknown as Record<string, unknown>, {
    runtime: { setOutputLanguage }
  });
  return { application, setOutputLanguage };
}

describe("output language settings", () => {
  beforeEach(() => {
    store.user.clear();
    store.language = "en";
  });

  it("resolves the missing setting as auto from the display language", () => {
    store.language = "zh-cn";
    const { application, setOutputLanguage } = applicationWithStubs();

    application.applyOutputLanguageSettings();

    expect(setOutputLanguage).toHaveBeenCalledWith("zh-CN");
  });

  it("honors an explicit language over the display language", () => {
    store.user.set("dext.outputLanguage", "zh-TW");
    const { application, setOutputLanguage } = applicationWithStubs();

    application.applyOutputLanguageSettings();

    expect(setOutputLanguage).toHaveBeenCalledWith("zh-TW");
  });

  it("treats an invalid configured value as auto", () => {
    store.user.set("dext.outputLanguage", "fr");
    store.language = "zh-cn";
    const { application, setOutputLanguage } = applicationWithStubs();

    application.applyOutputLanguageSettings();

    expect(setOutputLanguage).toHaveBeenCalledWith("zh-CN");
  });

  it("maps auto from English and leaves unsupported display languages uninstructed", () => {
    const { application, setOutputLanguage } = applicationWithStubs();
    store.user.set("dext.outputLanguage", "auto");

    store.language = "en";
    application.applyOutputLanguageSettings();
    store.language = "fr";
    application.applyOutputLanguageSettings();

    expect(setOutputLanguage).toHaveBeenNthCalledWith(1, "en");
    expect(setOutputLanguage).toHaveBeenNthCalledWith(2, undefined);
  });

  it("keeps applying consecutive changes without recreating the runtime", () => {
    const { application, setOutputLanguage } = applicationWithStubs();

    store.user.set("dext.outputLanguage", "zh-CN");
    application.applyOutputLanguageSettings();
    store.user.set("dext.outputLanguage", "en");
    store.language = "zh-cn";
    application.applyOutputLanguageSettings();
    store.user.set("dext.outputLanguage", "auto");
    store.language = "ja-jp";
    application.applyOutputLanguageSettings();

    expect(setOutputLanguage.mock.calls.map(([language]) => language)).toEqual(["zh-CN", "en", "ja"]);
  });
});
