## Responsibility

- **Names**: Built-in API → `BUILTIN_METHODS`（`src/features/workflow/domain/builtins.ts`，同文件导出 `uiOutputFields`）
- 它只拥有一件事：为每个内建 `dext` 调用声明**唯一一份契约**——`id`、`title`、`description`、`kind`、`version`、`input` 字段列表、`output` 形状（含 `ui.*` 的 `resultType` 与结果字段）、可读的 `context`，以及 `executor.handler` 的处理器名。它不执行任何调用，也不读工作区、模型、配置或 provider。
- 之所以把它收成一张表：消费者固定为四处，改一处即同时改四处——`src/app/application.ts` 以 `builtin` 来源把整张表注册进 `MethodRegistry`；`src/features/workflow/domain/dextApiTypes.ts` 据此生成 `dext` 模块声明（含 `ui` 组与结果类型）；`src/features/workflow/domain/builtinTypeDefinitions.ts` 据此生成结果类型目录；`src/features/workflow/host/runtime.ts` 按 `method.executor.handler` 找到执行器。测试直接引用该表断言语义契约。若契约散落在运行时或声明生成里，四份描述必然漂移。
- 标题取代码名；文档把这一族调用写作 `Built-in API`（`docs/workflows.md`），代码里没有同名模块，两者指同一职责。

## Design

- **表项形状统一**：每一项都是 `CallableDefinition`，`id` 就是用户在 `dext` 模块里调用的名字（`ask`、`plan`、`agent`、`template`、`apply`、`terminal`、`ui.*`、`skill`）。`version` 固定为 `"1.0.0"`，`kind` 只有 `command` 与 `skill` 两种，`skill` 是唯一非 `command` 的项。
- **上下文按需声明**：需要读代码上下文的四个模型调用（`ask`、`plan`、`agent`、`template`）共享 `CONTEXTS = [selection, activeFile, file, symbol]`；`apply`、`terminal`、`ui.*`、`skill` 不声明 `context`，因为它们接受的是结果或直接输入，不解析 `@path` 引用。
- **`internal` 是给转发层看的标记**：`skills` 与 `rules` 被标为 `internal`，因为调用方确实会写它们，所以仍必须出现在生成的声明里；但运行时不把它们当成 provider 的控制字段直接转发。没有这个标记，声明会缺字段，运行时又会把内部选项透给 provider。
- **provider 字段不手写**：`BUILTIN_METHODS` 在导出前做一次映射，只有 `CLI_BUILTIN_IDS` 命中的方法才追加 `builtinCliFields()` 带来的 `cli` 与 `model`，从而把 Codex / Claude / Harness / Pi 的模型选项交给 `src/features/agents/domain/builtinCli.ts` 一处维护，其余方法不会凭空多出 `cli`。该集合是本表的超集（还包含本表没有定义的 `create`），所以只有表里真实存在的 id 会命中。
- **`ui.*` 由一个工厂展开**：七个动作从同一个字面量元组经 `uiDefinition(action)` 生成，`input`、`handler`（`uiSelect`…）与 `resultType`（`UiSelectResult`…）都用同一种首字母大写写法推导，七个变体在命名与结构上不会互相不一致。`presentation` 的默认值按动作区分：`form` 默认 `inline`，其余默认 `dialog`。
- **嵌套结构用 `FieldDefinition` 描述**：`uiFieldDefinition()` 用 `discriminator` 按 `type` 分出 `select`/`radio`/`checkbox`/`input` 四种变体，`uiActionDefinition()` 与 `uiOptionDefinition()` 描述动作按钮与选项对象，让生成类型、参数校验与 Agent 的 JSON Schema 读同一棵树，而不是各自手抄一份字段清单。
- **必填/可选划分集中一处**：`uiOutputFields(action)` 说明交互结果的必填与可选字段——`kind`/`type` 判别字段和该动作的实际载荷必填，只有「没有产生文本」时才缺省的 `custom`/`value` 可选，这正对应运行时省略它们的行为；`builtinTypeDefinitions.ts` 直接取 `ui.form` 的 `answers.properties` 生成 `UiFieldAnswer`，不再复制一份。
- **描述文本本身就是契约**：它出现在 hover、API 页面与声明注释里，所以 `apply` 的说明写明无 patch 的 `AgentResult` 返回 `unchanged` 而畸形 patch 仍抛错，`terminal` 的说明写明它无确认提示、由工作流自行判断安全性。这里声明的是行为约束，不是执行实现。

## Boundary

- Allowed: 引入 `src/shared/contracts/types.ts` 的 `CallableDefinition` / `FieldDefinition` 等契约类型；引入同层领域模块 `src/features/agents/domain/builtinCli.ts`；被 `src/app/application.ts`、本特性的 `domain/` 与 `host/` 以及 `test/` 引用。
- Allowed: 新增或修改内建调用的契约数据（字段、描述、枚举、默认值、`context`、`executor.handler` 名字），只要对应执行器在 `src/features/workflow/host/runtime.ts` 的处理器表里存在。
- Forbidden: 依赖 `vscode`、Node 内置模块或任何 DOM 全局——它属于无环境的纯层（`domain/`），`scripts/checkModuleBoundaries.mjs` 会拒绝；同样不得依赖 `src/app/`、`src/webview/`、`src/runner/` 或任何特性的 `host/`、`browser/` 实现。
- Forbidden: 在此执行调用、读写文件、启动进程或访问模型；也在此做 provider 特化（除 `CLI_BUILTIN_IDS` 那一处映射外）、参数解析、默认值补全或结果校验——那属于 `builtinCli.ts`、`runtime.ts` 与 `axAdapter.ts`，本文件只描述契约。
- Forbidden: 把 manifest 派生的 MCP 工具、项目 API 或 Skill 目录内容写死在表里；它们由 `MethodRegistry` 与装配层按来源另行登记，这张表只放不随工作区变化的内建项。