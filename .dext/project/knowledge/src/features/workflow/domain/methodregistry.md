## Responsibility

- **Names**: Dext API → `MethodRegistry`（`src/features/workflow/domain/registry.ts`）
- 它拥有“此刻到底存在哪些可调用方法”这一份唯一清单：以 `CallableDefinition.id` 为键存放定义，并把来源 `MethodSource`（`builtin` / `global` / `project`）贴在条目上，交出 `RegisteredCallable`。运行时按 id 解析一次调用、APIs 页按 id 列出方法、生成的 `dext` 声明按 id 取标题与描述，读的都是它。
- 它同时拥有条目的生命周期入口：`register`、`registerMany`、`get`、`list`、`clearExternal`，以及单调递增的 `revision`（经 `version` getter 暴露）。除此之外它什么也不做——不认 manifest、不读 TOML 与 Skill 目录、不执行 handler。
- 形状如此，是因为生产者有三个（内建契约表、MCP manifest、运行期按 profile 重算的 CLI 字段），而“这个 id 是否存在、它的契约长什么样”只允许有一个答案；把冲突裁决收进一个类，调用方就不必各自记得谁能覆盖谁。

## Design

- 覆盖规则是一张数据表 `SOURCE_PRIORITY`（`builtin: 0`、`global: 1`、`project: 2`），而不是散落的 if：`register` 先做一条显式判断——已有条目是 `builtin` 而新来源不是，直接丢弃；再比较优先级，已有条目严格更高也丢弃。因此同优先级由后注册者覆盖，而内建契约永远不被外部来源改写（`test/registry.test.ts` 断言 `ask` 标题仍是 `Ask`、`chat` 不会被凭空登记）。
- `builtin` 对自己仍可再注册，这是刻意的：`DextRuntime.setAgentProfiles` 会在 profile 变化时用 `builtinCliFields(profiles)` 重写 `cli` / `model` 字段，让四个模型调用的可选参数跟着当前 Agent 目录走，而不需要在注册表里存一份 profile。
- `revision` 是变更计数，只有真正写入或删除才 `+1`，被拒绝的注册不动计数；目前 `src` 内还没有读取它的调用点，它只是给“清单是否变了”这类失效判断留的入口，不应被当成已使用的能力来引用。
- `list()` 返回新数组并按 `id.localeCompare` 排序：调用方拿不到内部 `Map`、也无法改动它；投影到 Webview 与 API 页面时顺序稳定，不随注册先后抖动。`Map` 的插入顺序在这里不承载语义，只用于按 id 去重。
- `clearExternal()` 只删 `source !== "builtin"` 的条目，并与重载路径成对出现：`DextApplication.reload()` 先清空外部来源，再把本次解析出的 manifest 方法重新登记，且只登记“服务器确实连上”的工具；被删掉的 manifest 或断连的工具不会残留，未知 id 的报错话术由 `DextRuntime.missingMethodMessage` 区分“未连接”和“根本没有”。因此重载既不需要重新注入内建定义，也不会丢掉内建定义。
- 装配是单向的：`src/app/application.ts` 构造并持有注册表，构造期以 `builtin` 登记 `BUILTIN_METHODS`，重载期以 `project` 登记 manifest 方法；`DextRuntime` 只经 `get` / `register` 使用它；`src/extension.ts` 用 `application.registry.list()` 生成 APIs 页的数据源。注册表本身不导入任何一个生产者。

## Boundary

- Allowed: 仅依赖 `src/shared/contracts/types.ts` 的纯类型（`CallableDefinition`、`MethodSource`、`RegisteredCallable`）；被 `src/app/application.ts` 持有与登记，被 `src/features/workflow/host/runtime.ts` 读取与局部重注册，被 `src/extension.ts` 以 `list()` 投影到资源页。
- Allowed: 新增或调整来源优先级、返回顺序与清空语义，只要覆盖规则仍以 `SOURCE_PRIORITY` 一处为准。
- Forbidden: 不读文件、工作区、VS Code 配置或环境变量（manifest、TOML、Skill 目录都由 host 侧加载后再交给它）；不判断 MCP 服务器是否连通；不校验输入、不解析调用、不执行 handler；不提供跨来源冲突诊断（被丢弃的注册静默返回，报错话术归 `runtime` / `dextHost`）；不依赖 `vscode`、Node 内置模块或任何 `host/`、`browser/` 实现（它属于无环境的 `domain/` 纯层）。