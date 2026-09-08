# 开发与发布

[English](development.md) | 简体中文

[返回 README](../README.zh-CN.md)

从源码运行 Dext、执行检查并生成 VSIX 安装包。

[开发](#开发) · [打包与发布](#打包与发布) · [架构](#架构)

## 开发

使用 `package.json` 中 `volta` 固定的 Node.js 版本（目前为 **22.23.2**）以及 VS Code 1.105 或更新版本。

```bash
git clone https://github.com/blooddot/dext.git
cd dext
npm ci
npm run check
```

执行 `npm run test:host` 运行 VS Code 扩展激活和侧栏冒烟测试。VS Code 安装路径非标准时，可设置 `VSCODE_EXECUTABLE_PATH`；设置 `DEXT_TEST_DOWNLOAD=1` 则使用单独下载的测试版本。

在 VS Code 中按 **F5**，选择 **Run Dext Extension**，即可启动扩展开发宿主。修改打包代码时，可以运行 `npm run watch` 持续构建。

## 打包与发布

```bash
npm run package
```

此命令先执行 lint、类型检查、单元测试、构建和 Webview 资源检查，再生成 `release/dext-<版本号>.vsix`。版本号来自 `package.json`。

`release/` 会自动创建，已被 Git 忽略，也不会包含在 VSIX 中。不同版本的安装包会保留；重新打包同一版本会覆盖对应文件。例如 `0.1.1` 的输出为 `release/dext-0.1.1.vsix`。

发布到 GitHub 的步骤：

1. 更新 `package.json`、`package-lock.json` 中的版本，并在 [CHANGELOG.md](../CHANGELOG.md) 中填写版本说明。
2. 运行 `npm run package`，安装生成的 VSIX，检查主要使用流程。
3. 提交源码修改，创建与版本对应的 Git 标签，例如 `v0.1.1`。
4. 推送提交和标签，为该标签创建 GitHub Release，并上传 `release/` 中对应的 VSIX 作为附件。

每个已发布安装包保存在对应的 Release 中，方便查找历史版本。`npm run package` 只生成本地安装包，不会自动上传或发布。

更新 VS Code 插件商店时，使用高于已发布版本的版本号，运行 `npm run package`，然后在[发布者管理页面](https://marketplace.visualstudio.com/manage)通过现有扩展的更新入口上传生成的 VSIX。每个版本在 CHANGELOG 中新增一节，保留历史版本记录。发布 GitHub Release 不会更新商店页面。

## 架构

MCP 初始化从 `package.json` 读取客户端名称和版本。协议版本分别维护在 `dext.mcpProtocolVersions.stdio` 和 `dext.mcpProtocolVersions.http`，HTTP 请求头复用 HTTP 协议版本。这些值会在构建时打包进扩展。只有对应传输实现支持该协议修订版时才应修改日期，并重新构建；它们不是面向用户的设置项。

- `src/core/workflow.ts`：遍历 Lezer Python 语法树，限制语法、检查类型并生成诊断。
- `src/core/workflowRuntime.ts`：顺序执行、结果组合和分支状态管理。
- `src/core/languageService.ts`：Dext 补全、悬停、参数提示和诊断。
- `src/core/contextResolver.ts`：不可变上下文快照。
- `src/core/axAdapter.ts`：Ax / Zod / JSON Schema 契约适配。
- `src/core/runtime.ts`：确定性执行器白名单。
- `src/core/customApi.ts`：`.dx` API 加载、导入、签名和自定义计划。
- `src/core/agentRunner.ts`：Codex / Claude CLI 的结构化执行适配。
- `src/core/completionProvider.ts`：FIM 补全后端、缓存和密钥管理。
- `src/core/workflowRecorder.ts`：从对话生成 `.dx` 工作流骨架。
- `src/webview/codeEditor.ts`：基于 CodeMirror 的 Python 语法编辑器。
