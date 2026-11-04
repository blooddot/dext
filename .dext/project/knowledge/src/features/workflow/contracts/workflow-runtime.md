## Responsibility

- **Names**: WorkflowRuntime → src/features/workflow/contracts/runtime.ts
- 拥有工作流执行面的“能力声明”：`WorkflowRuntime.executeConversation(mode, input, metadata)` 承担 `agent` / `ask` / `plan` 轮次的执行，`executeStructuredJson(input, outputSchema, metadata)` 承担带 schema 的结构化输出，返回 `{ text, model? }` 而非解析后的检测结果。
- 拥有端口注入契约 `ProjectAwareRuntime.setProjectPlanPort(port | undefined)`：runtime 需要 Project 的读取端口来给 Plan 轮次加接地信息，但 Project 的具体持久化格式不由这里决定。
- 拥有内建处理器的形状 `DeterministicHandler = (invocation: ResolvedInvocation) => DextResult | Promise<DextResult>`：由 provider 之外的处理函数承接的确定性调用（`terminal`、`apply`）。
- 已确认的消费者：`DextRuntime`（src/features/workflow/host/runtime.ts）实现这两个接口；`ProjectAiBridge`（src/features/project/host/generation/projectAiProvider.ts）只通过 `runtime: WorkflowRuntime` 注入依赖；`terminalRunHandler`（src/platform/vscode/terminalHost.ts）与 `applyPatchHandler`（src/platform/vscode/patchHost.ts）实现 `DeterministicHandler`。

## Design

- 接口被刻意拆成三段，而不是一个类：`WorkflowRuntime` 只给出调用方需要的两个入口，`DextRuntime` 的注册表、`ContextResolver`、内核句柄、结果修复器、MCP 声明集都不出现在契约上，因此换实现不必改调用方。
- 注入能力单独放在 `ProjectAwareRuntime`：只有组合根（src/app/application.ts 的 `setProjectPlanPort`，由 src/extension.ts 传入 `ProjectPlanService`）调用它，普通消费者引用 runtime 时不会被牵连到 Project 的存在。
- `DeterministicHandler` 让平台层按名字注册内建调用，runtime 只在分销时查表；`terminalHost` / `patchHost` 因此只 `import type` 契约，不必反向依赖 runtime 实现，平台层与 workflow 实现之间没有运行时边。
- 全部导入都是 `import type`（`shared/contracts/types.js`、`project/contracts/projectPlan.js`），文件属于 `features/workflow/contracts/` 纯层；边界检查允许跨 feature 通过契约协作，于是 `project/host` 可以只依赖 `workflow/contracts` 而不依赖 `workflow/host`，避免 workflow 与 project 之间形成 host 环。
- `metadata` 固定为 `Readonly<ExecutionMetadata>`：取消信号、进度事件、模型与 CLI 覆盖都走元数据，方法签名不随供应商能力膨胀；`executeStructuredJson` 只承诺返回文本，把“这份文本是否满足调用方的领域契约”留给调用方（ProjectAiBridge 保留自己的校验与修复循环）。
- **索引修正**：索引把该模块记为“当前没有已知消费者”，与源码不符；实际有 `DextRuntime` 的实现与 `ProjectAiBridge` 的依赖，两点已在上面列出。

## Boundary

- Allowed:
  - `DextRuntime` 与任何其他 host 实现实现 `WorkflowRuntime` / `ProjectAwareRuntime`。
  - 其他 feature 的 host 以 `import type` 方式依赖本契约取得执行入口（如 `projectAiProvider.ts` 的 `ProjectAiDependencies.runtime`）。
  - 平台层（`src/platform/vscode/terminalHost.ts`、`patchHost.ts`）实现 `DeterministicHandler` 并由组合根注入。
  - 组合根注入 `ProjectPlanPort`，以及复用 `ExecutionMetadata`、`RuntimeResponse`、`DextResult` 等 shared 契约。
- Forbidden:
  - 在本文件写入执行逻辑、注册表、CLI 分支、MCP 交互或任何 VS Code / Node 环境依赖。
  - 依赖 `workflow/host`、agents host、内核或 provider 适配器（契约只能被实现，不能引用实现）。
  - 让消费者直接依赖 `src/features/workflow/host/runtime.ts`（该类不属于能力面），或把 Project 的端口与持久化细节写进 `WorkflowRuntime`。
  - 让 `DeterministicHandler` 承担需要 provider、schema 或流式事件的调用；它不是第二条 Agent 通道。