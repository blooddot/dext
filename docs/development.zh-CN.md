# 开发与发布

[English](development.md) | 简体中文

[返回 README](../README.zh-CN.md)

从源码运行 Dext、执行检查并生成 VSIX 安装包。

[开发](#开发) · [打包与发布](#打包与发布) · [架构](#架构)

## 开发

使用 `mise.toml` 固定的 Node.js、DeepSeek Harness 桌面版（Harness 轮次），以及 VS Code 1.105 或更新版本。

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

### 包体为什么这么大

VSIX 压缩后约 **5 MB**（解压约 20 MB），几乎全部来自 Webview：

| 资源 | 原始 | 压缩后 | 原因 |
|---|---|---|---|
| `dist/webview/main.js` | ~7.7 MB | ~2.1 MB | Monaco、mermaid、markdown-it 与 Webview 代码 |
| `dist/webview/ts.worker.js` | ~6.7 MB | ~1.5 MB | Monaco 的 TypeScript worker，内嵌整个 TypeScript 编译器 |
| `dist/extension.js` | ~2.7 MB | ~0.7 MB | 扩展宿主 bundle、kernel host 与 Agent CLI 适配 |

这个 TypeScript worker 是**有意为之**：composer 的补全、悬停、F12 与诊断由 Monaco 自带的 TypeScript 服务提供，而 Webview 无法使用 VS Code 为工作区文件运行的 TypeScript 服务。把该入口从 `esbuild.mjs` 去掉可省约 1.5 MB（压缩后），代价是 composer 只剩语法高亮，而 `.dext/api/*.ts` 仍由 VS Code 提供完整语言支持。`dist/extensionHostTest.js`、source map、`node_modules/**` 与 devDependency `typescript` 已被 `.vscodeignore` 排除；`npm run check` 的资源检查会证明进入 VSIX 的新增运行时资源只有 kernel 的 `.mjs` 与随包发布的 `dist/dext.d.ts`。

输入区的配色不来自这个 worker：Monaco 用 `src/webview/monacoTheme.ts` 里定义的 `dext` 主题着色，它**继承** Monaco 自带主题（按 Webview 的主题 class 选 `vs`/`vs-dark`/`hc-*`），再用 `src/vscodeTheme.ts` 读到的当前 VS Code 主题覆盖。这层桥接不是重复劳动：VS Code 主题是按 TextMate scope（`tokenColors`）写的，而 Monaco 的 Monarch 语法产出的是 Monaco token 类型（`identifier`、`delimiter.bracket`、`type.identifier`…），并且没有任何 VS Code API 能给出"解析后的 token 颜色"——只有主题*文件*里有，所以只能解析文件并按 TextMate 的 specificity 归纳成 14 个槽位。`src/webview/monacoThemeRules.ts` 再把这些槽位映射到 Monaco TypeScript 语法能产出的每一个 token 类型（含 `fontStyle`）；某个槽位没有规则时才会落回 Monaco 自己的颜色——这正是之前"名字和标点没跟着主题走"的原因。另一条路是打包 `vscode-textmate` 与 Oniguruma wasm，用真正的 TextMate 语法着色，代价是几 MB 体积和更慢的编辑器，而语言能力并不会变多。

发布到 GitHub 的步骤：

1. 更新 `package.json`、`package-lock.json` 中的版本，并在 [CHANGELOG.md](../CHANGELOG.md) 中填写版本说明。
2. 运行 `npm run package`，安装生成的 VSIX，检查主要使用流程。
3. 提交源码修改，创建与版本对应的 Git 标签，例如 `v0.1.1`。
4. 推送提交和标签，为该标签创建 GitHub Release，并上传 `release/` 中对应的 VSIX 作为附件。

每个已发布安装包保存在对应的 Release 中，方便查找历史版本。`npm run package` 只生成本地安装包，不会自动上传或发布。

更新 VS Code 插件商店时，使用高于已发布版本的版本号，运行 `npm run package`，然后在[发布者管理页面](https://marketplace.visualstudio.com/manage)通过现有扩展的更新入口上传生成的 VSIX。每个版本在 CHANGELOG 中新增一节，保留历史版本记录。发布 GitHub Release 不会更新商店页面。

## 架构

MCP 初始化从 `package.json` 读取客户端名称和版本。协议版本分别维护在 `dext.mcpProtocolVersions.stdio` 和 `dext.mcpProtocolVersions.http`，HTTP 请求头复用 HTTP 协议版本。这些值会在构建时打包进扩展。只有对应传输实现支持该协议修订版时才应修改日期，并重新构建；它们不是面向用户的设置项。

- `src/features/workflow/host/contextResolver.ts` 与 `src/shared/contracts/context.ts`：不可变上下文快照及其宿主端口。
- `src/features/agents/domain/axAdapter.ts`：Ax / Zod / JSON Schema 契约适配。
- `src/features/workflow/host/runtime.ts`：确定性执行器白名单。
- `src/features/workflow/domain/dextApiTypes.ts`：由注册表推导的 `dext` 声明与 `.dext/tsconfig.json` 工程。
- `src/features/agents/host/agentRunner.ts`：Codex / Claude CLI 的结构化执行适配。
- `src/features/workflow/domain/workflowRecorder.ts`：从对话生成 TypeScript API 骨架。
- `src/shared/` 是跨 feature 的公共内核（`contracts/`、`protocol/`、`lib/`）；`src/platform/` 是按环境分区的适配层（`vscode/`、`node/`、`browser/`、`editor-tabs/`、`webviewProtocol.ts`）。`src/core/` 已不存在。
- `src/webview/codeEditor.ts`：Code 编辑器（Monaco、引用投影与文件拖放）。

### 层级词表

- `src/app/` 是组合根（`application.ts`、`sidebarProvider.ts` 与两个 setup 模块），除浏览器入口外可以依赖其余层。
- `src/features/<slice>/` 拥有产品职责，并按环境分区：`contracts/`、`domain/`、`knowledge/`、`presentation/` 不依赖环境；`host/` 面向 Node/VS Code；`browser/` 面向 DOM。feature 之间只通过 `contracts`/`domain` 协作，跨 feature 的 host 耦合必须登记在 `crossFeatureHostCouplings`。
- `src/platform/` 只放环境适配器：`vscode/`、`node/`、`browser/`、`editor-tabs/` 与线协议聚合 `webviewProtocol.ts`。它不是“所有共享代码”的同义词。
- `src/shared/` 是跨 feature 的公共内核，只允许 `contracts/`、`protocol/`、`lib/`。本仓库不设 `core`、`common`、`base`、`modules`、`utils` 根目录：`core` 是已解散的旧目录，`common`/`base` 会与 `shared`、`platform` 重叠，`utils` 容易变成无结构堆放。
- 每个 feature 契约都是目录内的主题文件（`agents/contracts/agent.ts`、`workspace/contracts/fileSearch.ts`、`workflow/contracts/runtime.ts`、`mcp/contracts/mcp.ts`）。禁止 `contracts.ts` 与 `contracts/index.ts`；消费者显式导入具体文件。

`src/runner/` 是 Node 工作流内核，只依赖 `shared/`、Node 内置模块和自身模块。`src/app/application.ts` 负责构造内核宿主；依赖是单向的，内核不会反向导入上层。

### TypeScript kernel

`.dext/api/**/*.ts` 与 composer 的 Code 模式不再由扩展宿主里的解释器执行，而是在一个常驻 Node 子进程（kernel）里当作普通 TypeScript 运行：

- `src/runner/dextHost.ts` 负责子进程：启动、握手、派发队列（`dext.workflow.maxConcurrency`）、崩溃重启与取消（取消即 kill），以及报告是否有 run 在跑的 `busy()`。它还把输入区的缓冲区落盘——内核 import 的是真实文件：扩展把它指向自己的存储（`runs/<工作区>/`），因此跑 Code 不会在仓库里留下任何文件，且只保留最新 20 个缓冲区。一个 host 绑定一个工作区，所以切换文件夹时扩展会替换缓存的那个——但只在 `busy()` 为 false 时，因为 reload 绝不能杀掉正在跑的 run。
- `src/runner/dextKernel.mjs` 是子进程本身：每次 run 都以新的 generation 重新注册 loader，导入入口模块（导出了 `main` 就 await 它），并把 `console.log` / `console.error` 记为进程输出步骤——对象参数会在 Node 自己拼接之前按缩进 JSON 渲染，所以打印出来的载荷会完整到达 Output，而不是 `util.inspect` 那种限深的 `[Object]`。
- `src/runner/dextLoader.mjs` 把 `dext` 映射到运行时模块、把 `dext/api/<id>` 映射到 `<workspace>/.dext/api/<id>.ts`，解析工作区内省略扩展名的 `.ts` 导入，并擦除 TypeScript 类型。
- `src/runner/dextRuntime.mjs` 就是 `dext` 模块：每次调用记录一个步骤，并请求扩展宿主通过原有 runtime 执行。
- `src/runner/dextSerialization.mjs` 定义跨进程值的规则。
- `src/runner/dextResumeCache.ts` 记录 run 期间的 API 调用，并在用户继续失败 run 时重放。

以下运行时事实在本仓库（2026-09）由 `test/dextHost.test.ts`、`scripts/dextSmoke.mjs` 与直接探测确认。本机开发使用 Node 22.23.2；`.vscode-test` 中的 VS Code 归档为 1.132.0 与 1.138.0。

| 问题 | 实测结果 |
|---|---|
| `process.execPath` 能否当 Node 用？ | 可以。在扩展宿主里它是 VS Code 的 Electron 二进制，需要 `ELECTRON_RUN_AS_NODE=1`；1.138.0 归档下报 Node 24.18.1（Electron 42.10.0）。 |
| `--import` + `module.register()` 可用吗？ | 可用，Node 22.23.2 与 Electron 二进制的 Node 24.18.1 都支持。 |
| 有 TypeScript 支持吗？ | 有：两者都是 `process.features.typescript === "strip"`，且存在 `module.stripTypeScriptTypes()`。`enum` 会被拒绝并给出 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（"TypeScript enum is not supported in strip-only mode"），这也是生成的 `.dext/tsconfig.json` 设置 `erasableSyntaxOnly` 的原因。 |
| 需要 `--experimental-strip-types` 吗？ | 不需要。loader 自己擦除类型，既不传该参数也不依赖它；`--experimental-transform-types` 可用但未采用。 |
| Electron 二进制能直接跑 `.ts` **入口**吗？ | 不能，会在 CJS 加载器里报 `Cannot find module`。因此入口是 `dextKernel.mjs`，用户 `.ts` 文件由它导入。 |
| 相对 `.ts` 导入（带扩展名）？ | 原生可用。 |
| 省略扩展名的相对导入？ | Node 不解析；`dextLoader.mjs` 为工作区内文件解析 `.ts`、`.mts` 与 `/index.ts`。 |
| `--import <Windows 绝对路径>`？ | 报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`；宿主传 `file://` URL。 |
| 同一个 kernel 能连跑两次同一文件吗？ | 能：kernel 以新的 generation 重新注册 loader，工作区 URL 会带上 `?dextRun=`，因此所有工作区模块都会重新求值，模块级状态不会跨 run 泄漏。 |
| 类型擦除会有警告吗？ | 会，每个线程一次（`ExperimentalWarning`）。`src/runner/dextWarnings.mjs` 在 kernel 与 loader 线程里丢弃该警告，避免 Dext 自己的工具链出现在步骤里。 |

类型擦除是原生能力，不需要额外依赖。只有当宿主运行时自身完全不支持 TypeScript 时，`dextLoader.mjs` 才会回退到 esbuild 转换；正因为这种回退很少见，esbuild 仍留在 devDependencies。


### 项目知识、对话运行与编辑器 Tab

长期项目知识与单次运行记录分别存放，互不混用：

- `src/features/project/host/persistence/projectStore.ts` 负责 `.dext/project.json`、AI 生成的 intent/diagram 文件、已接受的 `.dext/objects/<id>.json` 以及 `.dext/architecture.json`；它负责持久化已接受对象。并发写入按版本拒绝（`conflict`），不做合并。
- `src/features/project/contracts/projectKnowledge.ts` 负责命名、稳定 ID，以及来源／确认／有效性／归属四个相互独立的维度。旧的 `status` 字段在读取时迁移；代码发生变化时，已接受对象保持已接受，同时标记为 `needs_verification`。
- `src/app/sidebarProvider.ts` 只保留 Webview 生命周期与本轮范围外的功能。会话状态位于 `src/features/conversations/host/`（`conversationController.ts`、`turnExecutionCoordinator.ts`、`agentEventStream.ts`、`planController.ts`、`patchReviewController.ts`、`interactionController.ts`），由 `src/app/conversationSetup.ts` 统一装配一次。Plan 完成判定保留独立的自动验证轮次。参见 [conversation-development.zh-CN.md](conversation-development.zh-CN.md)。
- 项目架构扫描为 TypeScript、Python、Rust 提供同一套模型。各解析器把无法解析或存在歧义的结构记录为 `unsupported` 并给出原因，而不是猜测；`cargo metadata` 不可用时，Rust 元数据降级并显式说明覆盖范围。
- `src/platform/editor-tabs/editorTabManager.ts` 统一管理所有编辑器 Tab 的创建、复用、销毁和消息路由。`editorTabSerializer.ts` 对恢复去重，避免 serializer 回调与主动恢复重复打开同一页面；`src/features/project/host/projectEditorProvider.ts` 复用同一个稳定键。
- Resources 使用只读取文件的数据源：`src/features/resources/host/resourceEditorProvider.ts` 枚举与读取资源但不执行，`src/features/resources/presentation/resourceDocuments.ts` 负责渲染。API 列表也会通过 `src/features/workflow/host/apiSource.ts` 静态提取源码信息，复用 `src/platform/node/syntaxParser.ts` 的 Tree-sitter 加载器。Resources 与 APIs 共用签名、参数、返回类型和源码预览组件。类型来自显式标注或简单参数默认值；无法确定的类型显示为 `unknown`，不执行模块，也不运行 TypeScript 编译器。APIs 页面单独组合可调用契约、Node/JavaScript 参考和文件 API。Resources 不再读取运行时注册表或侧栏资源缓存；注册表继续负责执行分发和参数契约。

导入直接指向符号所属的契约或实现。第一轮和第二轮遗留的转发文件、`src/core/`、根目录 `application.ts`/`sidebarProvider.ts` 都已删除；一旦被恢复或被引用（包括测试、脚本、注释和内嵌构建入口字符串），`scripts/checkModuleBoundaries.mjs` 会直接失败。
