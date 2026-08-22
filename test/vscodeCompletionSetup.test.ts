import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCompletionSettings, type CompletionSettings } from "../src/core/completionProvider.js";
import type * as SetupModule from "../src/vscodeCompletionSetup.js";

interface QuickPickItem { label: string; detail?: string; description?: string }
interface InputOptions { prompt?: string; value?: string; password?: boolean; validateInput?: (value: string) => string | undefined }

const state = vi.hoisted(() => ({
  /** Substring of the label to choose, or null to dismiss the picker. */
  picks: [] as (string | null)[],
  /** Text to type, or null to dismiss the box. */
  inputs: [] as (string | null)[],
  offered: [] as string[][],
  boxes: [] as { prompt: string; value: string; password: boolean }[],
  info: [] as string[],
  warnings: [] as string[],
  errors: [] as string[],
  /** Answer to the modal shown when the connection test fails. */
  warningChoice: undefined as string | undefined
}));

vi.mock("vscode", () => ({
  ProgressLocation: { Notification: 15 },
  window: {
    showQuickPick: (items: QuickPickItem[]) => {
      state.offered.push(items.map((item) => item.label));
      const wanted = state.picks.shift();
      if (wanted === undefined) throw new Error(`Unexpected quick pick: ${items.map((i) => i.label).join(", ")}`);
      if (wanted === null) return Promise.resolve(undefined);
      const found = items.find((item) => item.label.includes(wanted));
      if (!found) throw new Error(`No item matching '${wanted}' in ${items.map((i) => i.label).join(", ")}`);
      return Promise.resolve(found);
    },
    showInputBox: (options: InputOptions) => {
      state.boxes.push({
        prompt: options.prompt ?? "",
        value: options.value ?? "",
        password: options.password === true
      });
      const typed = state.inputs.shift();
      if (typed === undefined) throw new Error(`Unexpected input box: ${options.prompt ?? ""}`);
      if (typed === null) return Promise.resolve(undefined);
      const rejection = options.validateInput?.(typed);
      if (rejection) throw new Error(`Validation rejected '${typed}': ${rejection}`);
      return Promise.resolve(typed);
    },
    showInformationMessage: (message: string) => {
      state.info.push(message);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string) => {
      state.warnings.push(message);
      return Promise.resolve(state.warningChoice);
    },
    showErrorMessage: (message: string) => {
      state.errors.push(message);
      return Promise.resolve(undefined);
    },
    withProgress: <T>(_options: unknown, task: () => Promise<T>) => task()
  }
}));

let setup: typeof SetupModule;

function options(overrides: Partial<CompletionSettings> = {}) {
  const written: Partial<CompletionSettings>[] = [];
  const keys: string[] = [];
  // `enabled` only sticks once an endpoint and a model are both present, which
  // is the same gate the wizard writes through.
  let current = normalizeCompletionSettings({ enabled: true, ...overrides });
  let stored: string | undefined = typeof overrides.model === "string" ? "existing-key" : undefined;
  let suspended = false;
  const calls = { verify: 0, refresh: 0, cleared: 0 };
  let failure: string | undefined;
  return {
    written,
    keys,
    calls,
    fail: (message: string) => (failure = message),
    dropKey: () => (stored = undefined),
    suspend: () => (suspended = true),
    value: {
      settings: () => current,
      writeSettings: async (patch: Partial<CompletionSettings>) => {
        written.push(patch);
        current = normalizeCompletionSettings({ ...current, ...patch });
      },
      apiKey: async () => stored,
      setApiKey: async (value: string) => {
        keys.push(value);
        stored = value;
      },
      clearApiKey: async () => {
        calls.cleared += 1;
        stored = undefined;
      },
      verify: async () => {
        calls.verify += 1;
        if (failure) throw new Error(failure);
        return "return a + b";
      },
      suspended: () => suspended,
      toggle: () => (suspended = !suspended),
      refresh: () => (calls.refresh += 1)
    } satisfies SetupModule.CompletionSetupOptions
  };
}

describe("completion model setup wizard", () => {
  beforeAll(async () => {
    setup = await import("../src/vscodeCompletionSetup.js");
  });

  beforeEach(() => {
    state.picks.length = 0;
    state.inputs.length = 0;
    state.offered.length = 0;
    state.boxes.length = 0;
    state.info.length = 0;
    state.warnings.length = 0;
    state.errors.length = 0;
    state.warningChoice = undefined;
  });

  it("collects a format, a URL, a model and a key in one pass", async () => {
    const host = options();
    state.picks.push("OpenAI-compatible", "Test connection and save");
    state.inputs.push("https://models.example/v1", "small-fim", "sk-secret");
    await setup.configureCompletionModel(host.value);

    expect(host.written).toEqual([{
      api: "openai",
      endpoint: "https://models.example/v1",
      model: "small-fim",
      enabled: true
    }]);
    expect(host.keys).toEqual(["sk-secret"]);
    expect(host.calls.verify).toBe(1);
    expect(host.calls.refresh).toBe(1);
    // The key is never echoed back into the editor.
    expect(state.boxes.at(-1)?.password).toBe(true);
    // Every format is on offer, and the two OpenAI ones are told apart by name:
    // picking the FIM endpoint for a chat model is the way this gets misconfigured.
    expect(state.offered[0]).toEqual([
      "OpenAI-compatible FIM",
      "OpenAI Chat Completions",
      "Anthropic Messages",
      "Ollama"
    ]);
  });

  it("skips the key step for Ollama, which has nothing to authenticate against", async () => {
    const host = options();
    state.picks.push("Ollama", "Save without testing");
    state.inputs.push("http://localhost:11434", "qwen2.5-coder");
    await setup.configureCompletionModel(host.value);

    expect(host.written).toEqual([{
      api: "ollama",
      endpoint: "http://localhost:11434",
      model: "qwen2.5-coder",
      enabled: true
    }]);
    expect(host.keys).toEqual([]);
    // Nothing was saved without asking, so no request went out either.
    expect(host.calls.verify).toBe(0);
    expect(state.boxes).toHaveLength(2);
  });

  it("prefills the usual base URL for the chosen format", async () => {
    const host = options();
    state.picks.push("Anthropic", null);
    state.inputs.push("https://api.anthropic.com/v1", "claude-3-5-haiku-latest", "sk-key");
    await setup.configureCompletionModel(host.value);
    expect(state.boxes[0]?.value).toBe("https://api.anthropic.com/v1");
    // Dismissing the save step saves nothing, key included.
    expect(host.written).toEqual([]);
    expect(host.keys).toEqual([]);
  });

  it("rejects a base URL that is not one, before anything is saved", async () => {
    const host = options();
    state.picks.push("OpenAI-compatible");
    state.inputs.push("models.example");
    await expect(setup.configureCompletionModel(host.value)).rejects.toThrow(/including the scheme/);
    expect(host.written).toEqual([]);
  });

  it("keeps the stored key when the key box is left empty", async () => {
    const host = options({ endpoint: "https://models.example/v1", model: "small-fim" });
    state.picks.push("OpenAI-compatible", "Save without testing");
    state.inputs.push("https://models.example/v1", "faster-fim", "");
    await setup.configureCompletionModel(host.value);
    expect(host.keys).toEqual([]);
    expect(host.written.at(0)?.model).toBe("faster-fim");
    expect(state.boxes.at(-1)?.prompt).toContain("keep the key already stored");
  });

  it("abandons the wizard at whichever step is dismissed", async () => {
    for (const [picks, inputs] of [
      [[null], []],
      [["OpenAI-compatible"], [null]],
      [["OpenAI-compatible"], ["https://models.example/v1", null]],
      [["OpenAI-compatible"], ["https://models.example/v1", "small-fim", null]]
    ] as [(string | null)[], (string | null)[]][]) {
      const host = options();
      state.picks.push(...picks);
      state.inputs.push(...inputs);
      await setup.configureCompletionModel(host.value);
      expect(host.written).toEqual([]);
      expect(host.keys).toEqual([]);
      expect(host.calls.refresh).toBe(0);
      state.picks.length = 0;
      state.inputs.length = 0;
    }
  });

  it("reports why a connection test failed and only saves when told to anyway", async () => {
    const rejected = options();
    rejected.fail("The completion model returned HTTP 401. invalid x-api-key");
    state.picks.push("Anthropic", "Test connection and save");
    state.inputs.push("https://api.anthropic.com/v1", "claude-fast", "sk-wrong");
    await setup.configureCompletionModel(rejected.value);
    expect(state.warnings.at(-1)).toContain("invalid x-api-key");
    // Declining leaves both the settings and the stored key untouched.
    expect(rejected.written).toEqual([]);
    expect(rejected.keys).toEqual([]);

    const forced = options();
    forced.fail("The completion model is not reachable.");
    state.warningChoice = "Save anyway";
    state.picks.push("Anthropic", "Test connection and save");
    state.inputs.push("https://api.anthropic.com/v1", "claude-fast", "sk-key");
    await setup.configureCompletionModel(forced.value);
    expect(forced.written.at(0)).toMatchObject({ api: "anthropic", enabled: true });
    expect(forced.keys).toEqual(["sk-key"]);
  });

  it("tests whatever is already configured, and sets up first when nothing is", async () => {
    const configured = options({ endpoint: "https://models.example/v1", model: "small-fim" });
    await setup.testCompletionModel(configured.value);
    expect(configured.calls.verify).toBe(1);
    expect(state.info.at(-1)).toContain("small-fim");

    const broken = options({ endpoint: "https://models.example/v1", model: "small-fim" });
    broken.fail("The completion model is not reachable.");
    await setup.testCompletionModel(broken.value);
    expect(state.errors.at(-1)).toContain("not reachable");

    // Nothing configured means the test turns into the wizard rather than a
    // request that could only fail.
    const empty = options();
    state.picks.push(null);
    await setup.testCompletionModel(empty.value);
    expect(empty.calls.verify).toBe(0);
    expect(state.info.at(-1)).toContain("Set up a completion model first");
  });
});

describe("inline completion diagnosis", () => {
  const base = {
    settings: normalizeCompletionSettings({
      enabled: true,
      endpoint: "https://models.example/v1",
      model: "small-fim"
    }),
    hasKey: true,
    suspended: false,
    inlineSuggestEnabled: true,
    editor: { languageId: "typescript", scheme: "file", path: "src/app.ts" },
    report: {
      invocations: 12,
      outcome: "offered a completion",
      since: "2s ago",
      timing: undefined,
      spacing: 0
    },
    probe: { completion: "return 1;" }
  };

  it("says nothing in Dext ran when the editor never asked", () => {
    const report = setup.diagnosisReport({
      ...base,
      report: { ...base.report, invocations: 0, outcome: "never asked for a completion", since: "-" }
    });
    // The single most useful fact: a count of zero rules out every gate inside
    // the provider. The advice has to stay about what the reader can check,
    // rather than naming a suspect, which is how an earlier version of this
    // text sent an investigation after the wrong editor entirely.
    expect(report).toContain("never called the provider");
    expect(report).toContain("Tab does not ask for a completion");
  });

  it("names the editor setting that silences every provider at once", () => {
    const report = setup.diagnosisReport({ ...base, inlineSuggestEnabled: false });
    expect(report).toContain("editor.inlineSuggest.enabled is false");
  });

  it("reports a failing backend verbatim rather than as a generic problem", () => {
    const report = setup.diagnosisReport({
      ...base,
      probe: { error: "The completion model returned HTTP 401. invalid key" }
    });
    expect(report).toContain("FAILED: The completion model returned HTTP 401. invalid key");
    expect(report).toContain("The backend itself is failing");
  });

  it("points at configuration before anything else when there is none", () => {
    const report = setup.diagnosisReport({
      ...base,
      settings: normalizeCompletionSettings({}),
      hasKey: false,
      probe: undefined
    });
    expect(report).toContain("Dext: Configure Completion Model");
    expect(report).toContain("(not set)");
  });

  it("blames the timeout when the probe succeeds and the real request did not", () => {
    // The probe is allowed at least 10s, so a tighter timeoutMs is the one way
    // for the backend to look healthy while every keystroke comes back empty.
    const report = setup.diagnosisReport({
      ...base,
      settings: normalizeCompletionSettings({
        enabled: true,
        endpoint: "https://models.example/v1",
        model: "small-fim",
        timeoutMs: 3000
      }),
      report: {
        ...base.report,
        invocations: 1,
        outcome: "the request failed: The completion model did not answer within 3000ms.",
        since: "17s ago"
      }
    });
    expect(report).toContain("dext.completion.timeoutMs = 3000ms");
    expect(report).toContain("Raise the setting");
    expect(report).toContain("the difference is timing");
  });

  it("separates waiting for the provider from generating, because only one of them is tunable", () => {
    // Most of the wait was over before a single token arrived, so generating
    // less cannot recover it. Saying otherwise sends someone to turn maxTokens
    // down and conclude that nothing helps.
    const queueing = setup.diagnosisReport({
      ...base,
      report: { ...base.report, timing: { firstTokenMs: 1400, totalMs: 1800 } }
    });
    expect(queueing).toContain("1400ms to the first token");
    expect(queueing).toContain("Lowering maxTokens will not help");

    // The other way round, and the setting is exactly the right lever.
    const generating = setup.diagnosisReport({
      ...base,
      report: { ...base.report, timing: { firstTokenMs: 200, totalMs: 1800 } }
    });
    expect(generating).toContain("1600ms of the 1800ms was spent generating");
    expect(generating).toContain("dext.completion.maxTokens");
    expect(generating).not.toContain("Lowering maxTokens will not help");

    // A quick request is not something to explain at all.
    const quick = setup.diagnosisReport({
      ...base,
      report: { ...base.report, timing: { firstTokenMs: 90, totalMs: 240 } }
    });
    expect(quick).toContain("240ms total");
    expect(quick).not.toContain("Suggestions are slow");
  });

  it("calls out a provider that ignored the stream flag, since that disables the main optimisation", () => {
    // An endpoint answering with one whole body means nothing can be shown
    // until the model has finished, which no Dext setting can undo. It is worth
    // naming, because from the outside it is indistinguishable from a slow model.
    const report = setup.diagnosisReport({
      ...base,
      report: { ...base.report, timing: { firstTokenMs: undefined, totalMs: 1585 } }
    });
    expect(report).toContain("1585ms, without streaming");
    expect(report).toContain("ignored the stream flag");
    expect(report).toContain("openai-chat format is worth trying");

    // A streaming endpoint is not accused of it.
    const streamed = setup.diagnosisReport({
      ...base,
      report: { ...base.report, timing: { firstTokenMs: 300, totalMs: 1585 } }
    });
    expect(streamed).not.toContain("ignored the stream flag");
  });

  it("counts the rate limit spacing as part of the delay being felt", () => {
    const report = setup.diagnosisReport({ ...base, report: { ...base.report, spacing: 600 } });
    expect(report).toContain("holding requests 600ms apart");
    expect(report).toContain("relaxes on");
  });

  it("admits when everything it can see is correct", () => {
    const report = setup.diagnosisReport(base);
    expect(report).toContain("the editor is not rendering it");
    expect(report).toContain("Format:    openai");
  });

  it("calls out a window that was switched off by hand", () => {
    expect(setup.diagnosisReport({ ...base, suspended: true }))
      .toContain("switched off for this window");
  });
});

describe("completion status bar menu", () => {
  beforeEach(() => {
    state.picks.length = 0;
    state.inputs.length = 0;
    state.offered.length = 0;
    state.info.length = 0;
  });

  it("leads with setup while unconfigured and hides the switches that would do nothing", async () => {
    const host = options();
    state.picks.push(null);
    await setup.openCompletionMenu(host.value);
    const items = state.offered.at(-1)!;
    expect(items[0]).toContain("Set up completion model");
    expect(items.some((item) => item.includes("Turn off"))).toBe(false);
    expect(items.some((item) => item.includes("Test connection"))).toBe(false);
    // No key is stored yet, so there is nothing to clear.
    expect(items.some((item) => item.includes("Clear API key"))).toBe(false);
    expect(items.some((item) => item.includes("Set API key"))).toBe(true);
  });

  it("offers the window switch, the test and key management once configured", async () => {
    const host = options({ endpoint: "https://models.example/v1", model: "small-fim" });
    state.picks.push("Turn off for this window");
    await setup.openCompletionMenu(host.value);
    const items = state.offered.at(-1)!;
    expect(items[0]).toContain("Configure completion model");
    expect(items.some((item) => item.includes("Test connection"))).toBe(true);
    expect(items.some((item) => item.includes("Replace API key"))).toBe(true);
    expect(items.some((item) => item.includes("Clear API key"))).toBe(true);
    expect(host.value.suspended()).toBe(true);

    // Once suspended the same entry offers the way back.
    state.picks.push(null);
    await setup.openCompletionMenu(host.value);
    expect(state.offered.at(-1)!.some((item) => item.includes("Turn on for this window"))).toBe(true);
  });

  it("offers the setting rather than the window switch when it was turned off in settings", async () => {
    const host = options({ enabled: false, endpoint: "https://models.example/v1", model: "small-fim" });
    state.picks.push("Enable inline completion");
    await setup.openCompletionMenu(host.value);
    const items = state.offered.at(-1)!;
    // Turning it off for this window would be meaningless when it is off everywhere.
    expect(items.some((item) => item.includes("Turn off for this window"))).toBe(false);
    expect(items.some((item) => item.includes("Disable inline completion"))).toBe(false);
    expect(host.written).toEqual([{ enabled: true }]);
  });

  it("clears the stored key and refreshes so the status bar keeps up", async () => {
    const host = options({ endpoint: "https://models.example/v1", model: "small-fim" });
    state.picks.push("Clear API key");
    await setup.openCompletionMenu(host.value);
    expect(host.calls.cleared).toBe(1);
    expect(host.calls.refresh).toBe(1);
  });

  it("disables the backend outright, which is what puts the status item away", async () => {
    const host = options({ endpoint: "https://models.example/v1", model: "small-fim" });
    state.picks.push("Disable inline completion");
    await setup.openCompletionMenu(host.value);
    expect(host.written).toEqual([{ enabled: false }]);
    expect(host.calls.refresh).toBe(1);
  });
});
