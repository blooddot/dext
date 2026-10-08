# Development and releases

English | [简体中文](development.zh-CN.md)

[Back to README](../README.md)

Run Dext from source, validate changes, and build a VSIX installer.

[Development](#development) · [Packaging and releases](#packaging-and-releases) · [Architecture](#architecture)

## Development

Use the Node.js and DeepSeek Harness versions pinned in `mise.toml` and VS Code 1.105 or newer.

```bash
git clone https://github.com/blooddot/dext.git
cd dext
npm ci
npm run check
```

Run `npm run test:host` for the VS Code activation/sidebar smoke test. Set `VSCODE_EXECUTABLE_PATH` for a nonstandard VS Code installation or `DEXT_TEST_DOWNLOAD=1` for an isolated downloaded build.

Press **F5** in VS Code and choose **Run Dext Extension** to launch an Extension Development Host. Use `npm run watch` when iterating on the bundled code.

## Packaging and releases

```bash
npm run package
```

This runs lint, type checking, unit tests, the build, and webview asset checks before creating `release/dext-<version>.vsix`. The version comes from `package.json`.

The `release/` directory is created automatically, ignored by Git, and excluded from the VSIX contents. Packages for different versions are kept; packaging the same version replaces its existing file. For example, version `0.1.1` produces `release/dext-0.1.1.vsix`.

### What makes the package big

The VSIX is about **5 MB compressed** (≈20 MB unpacked), and almost all of it is the Webview:

| Asset | Raw | Compressed | Why |
|---|---|---|---|
| `dist/webview/main.js` | ~7.7 MB | ~2.1 MB | Monaco, mermaid, markdown-it and the Webview code |
| `dist/webview/ts.worker.js` | ~6.7 MB | ~1.5 MB | Monaco's TypeScript worker, which embeds the whole TypeScript compiler |
| `dist/extension.js` | ~2.7 MB | ~0.7 MB | The extension host bundle, the kernel host, and the Agent CLI adapters |

The TypeScript worker is deliberate: the composer's completion, hover, F12 and diagnostics come from Monaco's own TypeScript service, and a Webview cannot reach the TypeScript service VS Code runs for workspace files. Removing the worker entry from `esbuild.mjs` would save ~1.5 MB compressed and leave the composer with syntax highlighting only, while `.dext/api/*.ts` would keep full language support from VS Code. `dist/extensionHostTest.js`, source maps, `node_modules/**` and the `typescript` dev dependency are already excluded by `.vscodeignore`; `npm run check`'s asset check proves the kernel `.mjs` files and the build-time `dist/dext.d.ts` snapshot are the only runtime assets that reach the VSIX.

The composer's colors do not come from the worker: Monaco paints with the `dext` theme built in `src/webview/monacoTheme.ts`, which *inherits* one of Monaco's own themes (`vs`/`vs-dark`/`hc-*`, chosen from the Webview's theme class) and then overrides it with the active VS Code theme read by `src/vscodeTheme.ts`. That bridge is unavoidable rather than duplication: a VS Code theme is authored as TextMate scopes (`tokenColors`), while Monaco tokenizes with Monarch grammars that emit Monaco token types (`identifier`, `delimiter.bracket`, `type.identifier`, …), and no VS Code API reports resolved token colors — only the theme *file* does, so it is parsed and each of the 14 slots is resolved by TextMate specificity. `src/webview/monacoThemeRules.ts` maps those slots onto every token type Monaco's TypeScript grammar can emit, `fontStyle` included; a slot with no rule falls back to Monaco's own color, which is exactly what left names and punctuation unthemed before. The alternative — bundling `vscode-textmate` and an Oniguruma wasm to tokenize with real TextMate grammars — would cost megabytes and a slower editor for no language-feature gain.

To publish a version on GitHub:

1. Update the version in `package.json` and `package-lock.json`, and add the release notes to [CHANGELOG.md](../CHANGELOG.md).
2. Run `npm run package`, install the generated VSIX, and check the main user flows.
3. Commit the source changes and create a matching Git tag, such as `v0.1.1`.
4. Push the commit and tag, create a GitHub Release for that tag, and upload the VSIX from `release/` as an attachment.

Keep published installers with their corresponding Releases so that older versions remain easy to find. `npm run package` only creates a local package; it does not upload or publish it.

To update the VS Code Marketplace listing, use a version higher than the published version, run `npm run package`, and upload the generated VSIX through the existing extension's update action in [Manage Publishers & Extensions](https://marketplace.visualstudio.com/manage). Each release gets a new CHANGELOG section; retain earlier release entries. Publishing a GitHub Release does not update the Marketplace listing.

## Architecture

MCP initialization reads the client name and version from `package.json`. Protocol versions are maintained separately under `dext.mcpProtocolVersions.stdio` and `dext.mcpProtocolVersions.http`; the HTTP request header uses the same HTTP value. These values are bundled at build time. Change protocol versions only when the corresponding transport supports that revision, then rebuild; they are not end-user settings.

- `src/core/contextResolver.ts`: immutable context snapshots.
- `src/core/axAdapter.ts`: Ax/Zod/JSON Schema contract boundary.
- `src/core/runtime.ts`: deterministic executor allowlist.
- `src/core/dextApiTypes.ts`: the generated `dext` declaration and the `.dext/tsconfig.json` project, both derived from the registry.
- `src/core/agentRunner.ts`: structured Codex/Claude CLI adapter boundary.
- `src/core/completionProvider.ts`: fill-in-the-middle backend, cache, and secret-stored key.
- `src/core/workflowRecorder.ts`: History conversation to a TypeScript API skeleton.
- `src/webview/codeEditor.ts`: the Code editor (Monaco, the reference projections, and file drops).

### The TypeScript kernel

`.dext/api/**/*.ts` and the composer's Code mode run as ordinary TypeScript in a long-lived Node child process — the kernel — instead of an interpreter in the extension host:

- `src/runner/dextHost.ts` owns the child: spawn, handshake, the dispatch queue (`dext.workflow.maxConcurrency`), crash recovery and cancellation (which kills the kernel), and `busy()`, which reports whether a run is in flight. It also writes the composer's buffer to disk, because the kernel imports a real file: the extension points that at its own storage (`runs/<workspace>/`), so a Code run leaves nothing in the repository, and the newest 20 buffers are kept. A host is built around one workspace, so the extension replaces the cached one when the folder changes — but only while `busy()` is false, because a reload must never kill a run.
- `src/runner/dextKernel.mjs` is the child: it re-registers the loader with a fresh generation for every run, imports the entry module (awaiting its `main` when it exports one) and reports `console.log` / `console.error` as process-output steps — an object argument is rendered as indented JSON before Node's formatter joins the line, so a logged payload reaches Output whole instead of as `util.inspect`'s depth-limited `[Object]`. A call the run left in flight is awaited before the run is reported, and a floating call that failed fails the run.
- `src/runner/dextLoader.mjs` maps `dext` to the runtime module and `dext/api/<id>` to `<workspace>/.dext/api/<id>.ts`, resolves extensionless `.ts` imports in the workspace, and erases TypeScript types.
- `src/runner/dextRuntime.mjs` is the `dext` module: each call records a step and asks the extension host to execute it through the ordinary runtime.
- `src/runner/dextSerialization.mjs` is the value rule for everything that crosses the process boundary.
- `src/runner/dextResumeCache.ts` records the API calls a run makes and replays them when the user continues a failed run.

Resume is call-level, not statement-level. A run records `(index, method, argument fingerprint, response)` for every API call; Continue sends those recordings to a fresh kernel, and a call that still matches returns the recorded response without running again. Stream steps do not consume an entry. Replay is only valid while the calls line up, so the first mismatch is a hard error (`CHANGED_SINCE_STOPPED` semantics) rather than a response attached to the wrong call — a value the recording cannot see (`Date.now()`, `Math.random()`, a direct `fs` read) is exactly what breaks replay, and that is reported instead of being patched around. Statement-level resume, the `skipped` state and the old `.dx` checkpoints are gone without a compatibility path. Module-level state in a reused kernel is bounded by the per-run loader generation described above, not by the resume cache.

Runtime facts measured on this checkout (2026-09) with `test/dextHost.test.ts`, `scripts/dextSmoke.mjs` and direct probes. Local development uses Node 22.23.2; the VS Code archives in `.vscode-test` are 1.132.0 and 1.138.0.

| Question | Measurement |
|---|---|
| Can `process.execPath` act as Node? | Yes. In the extension host it is VS Code's Electron binary and needs `ELECTRON_RUN_AS_NODE=1`; the 1.138.0 archive then reports Node 24.18.1 (Electron 42.10.0). |
| Is `--import` + `module.register()` available? | Yes, on Node 22.23.2 and on the Electron binary's Node 24.18.1. |
| Is TypeScript support available? | Yes: `process.features.typescript === "strip"` and `module.stripTypeScriptTypes()` exist in both. `enum` is refused with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` ("TypeScript enum is not supported in strip-only mode"), which is why the generated `.dext/tsconfig.json` sets `erasableSyntaxOnly`. |
| Is `--experimental-strip-types` needed? | No. The loader strips TypeScript itself, so the flag is neither passed nor required. `--experimental-transform-types` works too, but is not used. |
| Does a `.ts` **entry** file run on the Electron binary? | No — it fails in the CJS loader with `Cannot find module`. The kernel entry is therefore `dextKernel.mjs`, and user `.ts` files are imported from it. |
| Relative `.ts` imports with an extension? | Work natively. |
| Extensionless relative imports? | Not resolved by Node; `dextLoader.mjs` resolves `.ts`, `.mts` and `/index.ts` for files inside the workspace. |
| `--import <absolute Windows path>`? | Rejected with `ERR_UNSUPPORTED_ESM_URL_SCHEME`; the host passes a `file://` URL. |
| Can one kernel run the same file twice? | Yes: the kernel re-registers the loader with a new generation and workspace URLs carry it as `?dextRun=`, so every workspace module is evaluated again and module-level state cannot leak between runs. |
| Does type stripping warn? | Yes, once per thread (`ExperimentalWarning`). `src/runner/dextWarnings.mjs` drops that warning in the kernel and the loader thread so Dext's own tooling never appears as a step. |

Type stripping is native and needs no extra dependency. `dextLoader.mjs` falls back to an esbuild transform only when the host runtime has no TypeScript support of its own; esbuild stays a development dependency because of that fallback's rarity.


### Project knowledge, runs, and editor tabs

Long-term project knowledge and single-run records are deliberately separate stores:

- `src/projectStore.ts` owns `.dext/project.json`, generated intent/diagram files, accepted `.dext/objects/<id>.json` objects, and `.dext/architecture.json`. It is the only writer of accepted objects, and it caches the last definition so a send can read the preset synchronously. Concurrent writes are rejected by version (`conflict`), never merged.
- `src/turnReviewStore.ts` keys run attachments by `sessionId:turnId:runId` with oldest-first eviction. `deleteSession` and `clear` never touch project files, and clearing a conversation cannot remove accepted knowledge.
- `src/core/projectKnowledge.ts` keeps naming, stable ids, and the independent source/confirmation/validity/ownership dimensions. A legacy `status` field is migrated on read; an accepted object whose code changed stays accepted and additionally becomes `needs_verification`.
- `src/core/turnReview.ts` and `src/core/planReview.ts` own the run contracts. A Plan review adds a plan content version and a Build run id on top of the run id, so a later Build cannot reuse an older acceptance.
- `src/sidebarProvider.ts` freezes the Review preset at send time, builds one review per run from the patch changes the run reported, and accumulates Plan rounds into one Build review. A plan-authoring turn produces no review.
- `src/turnReviewController.ts` submits feedback, lists diff targets, and is the adoption bridge. `submitFeedback` only touches the run store; `adoptKnowledgeSuggestion` is the only path that writes a project object, and it navigates to it. Accepting code never adopts knowledge.
- `src/core/projectArchitecture*.ts` is one scan model shared by TypeScript, Python, and Rust. Each parser reports unresolved and ambiguous structures as `unsupported` with a reason instead of guessing, and Rust metadata degrades with an explicit coverage note when `cargo metadata` is unavailable.
- `src/editorTabManager.ts` owns panel creation, reuse, disposal, and message routing for every editor tab. `src/editorTabSerializer.ts` deduplicates restores so a serializer callback and a proactive restore cannot open the same page twice, and `src/projectEditorProvider.ts` reuses the same stable key.
- `src/resourceDocuments.ts` builds the API and Global Resources pages from the sidebar state, so search, grouping, detail, reference insertion, and source jumps survive the move out of the sidebar dialogs.
