# Development and releases

English | [简体中文](development.zh-CN.md)

[Back to README](../README.md)

Run Dext from source, validate changes, and build a VSIX installer.

[Development](#development) · [Packaging and releases](#packaging-and-releases) · [Architecture](#architecture)

## Development

Use the Node.js version pinned in `package.json` under `volta` (currently **22.23.2**) and VS Code 1.105 or newer.

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

To publish a version on GitHub:

1. Update the version in `package.json` and `package-lock.json`, and add the release notes to [CHANGELOG.md](../CHANGELOG.md).
2. Run `npm run package`, install the generated VSIX, and check the main user flows.
3. Commit the source changes and create a matching Git tag, such as `v0.1.1`.
4. Push the commit and tag, create a GitHub Release for that tag, and upload the VSIX from `release/` as an attachment.

Keep published installers with their corresponding Releases so that older versions remain easy to find. `npm run package` only creates a local package; it does not upload or publish it.

To update the VS Code Marketplace listing, use a version higher than the published version, run `npm run package`, and upload the generated VSIX through the existing extension's update action in [Manage Publishers & Extensions](https://marketplace.visualstudio.com/manage). Each release gets a new CHANGELOG section; retain earlier release entries. Publishing a GitHub Release does not update the Marketplace listing.

## Architecture

MCP initialization reads the client name and version from `package.json`. Protocol versions are maintained separately under `dext.mcpProtocolVersions.stdio` and `dext.mcpProtocolVersions.http`; the HTTP request header uses the same HTTP value. These values are bundled at build time. Change protocol versions only when the corresponding transport supports that revision, then rebuild; they are not end-user settings.

- `src/core/workflow.ts`: Lezer Python parser traversal, restricted AST, semantic types, and exact diagnostics.
- `src/core/workflowRuntime.ts`: sequential result composition and branch/step state.
- `src/core/languageService.ts`: Dext completions, hover, signatures, and diagnostics.
- `src/core/contextResolver.ts`: immutable context snapshots.
- `src/core/axAdapter.ts`: Ax/Zod/JSON Schema contract boundary.
- `src/core/runtime.ts`: deterministic executor allowlist.
- `src/core/customApi.ts`: `.dext/api` loader, imports, signatures, and custom plans.
- `src/core/agentRunner.ts`: structured Codex/Claude CLI adapter boundary.
- `src/core/completionProvider.ts`: fill-in-the-middle backend, cache, and secret-stored key.
- `src/core/workflowRecorder.ts`: History conversation to `.dx` skeleton.
- `src/webview/codeEditor.ts`: CodeMirror Python language integration.
