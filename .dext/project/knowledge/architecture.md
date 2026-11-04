## Responsibility

这一层定义并强制 Dext 的分层词汇与模块边界。`src/app/` 是组合根：`conversationSetup.ts` 接收一组窄函数依赖（`ConversationSetupDependencies`）并装配 `ConversationController`、`TurnExecutionCoordinator`、`AgentEventStream`、`PlanController`、`InteractionController`；`projectSetup.ts` 同法装配 Project 侧服务。`src/features/<slice>/` 拥有产品行为，当前切片为 `agents`、`conversations`、`mcp`、`project`、`resources`、`workflow`、`workspace`，每个切片再按环境分区：`contracts/`、`domain/`、`knowledge/`、`presentation/` 与环境无关，`host/` 面向 Node 与 VS Code，`browser/` 面向 DOM。它同时规定 `platform/`（仅环境适配器）、`shared/`（跨 feature 内核）、`runner/`（Node 工作流内核）与 `webview/`（浏览器入口）各自可依赖的方向。

## Design

- **依赖指向内层**。`contracts/` 是最内层（如 `agents/contracts/agent.ts` 的 `AgentProvider`、`project/contracts/projectModel.ts` 的节点与关系 schema），`domain/` 依赖契约实现纯逻辑（超时、Todo 跟踪、计划流、截断、排序），`host/` 与 `browser/` 依赖两者并各自绑定一种环境。组合根依赖具体实现，反向依赖只以窄函数端口注入。
- **feature 之间只经契约协作**。跨 feature 只允许走 `contracts/` 与 `domain/`；host 到 host 的耦合必须显式登记在 `crossFeatureHostCouplings`（现存条目如 `workflow/host/runtime.ts` → `agents/host/agentRouter.ts`），未登记的耦合直接构建失败。
- **契约按文件导入**。每个 feature 的契约是一个目录加主题文件，`contracts.ts` 与 `contracts/index.ts` 桶文件被拒绝，调用方导入具体文件。
- **回合所有权在 host 内闭合**。一个会话回合的输入代理、事件流、计划控制、交互请求与执行协调由 `conversations/host/` 的组件持有，`conversations/browser/` 只做 DOM 呈现与交互表单，`presentation/` 提供与环境无关的呈现投影。
- **Project 持久化不变式**。模型由带 revision 的节点与关系构成（`projectModelSchema`），并发写入按版本拒绝而非合并；模块边界取目录，AI 只能命名职责、只能合并整体候选，拆分同一目录的提案被拒绝；确认后的结构变化会把节点重新打开为 `draft`，但不会覆盖已审阅正文。
- **传输与协议适配器不外溢**。CLI 桥接（`piBridge`、`piRpcTransport`、`codexConversationRunner`、`harnessBridge`）、MCP 配置与密钥、归档下载都留在 `host/`；纯层只持有类型与规则。

## Boundary

- Allowed: 纯层导入 `contracts/`、`domain/` 与内核契约；`host/` 使用平台适配器、Node 内置模块与 VS Code API；`browser/` 使用 DOM 与平台浏览器适配器；`app/` 导入任意实现并向 feature 注入窄端口；`webview/` 入口使用 feature 的 `browser`/`contracts`/`domain`/`knowledge`/`presentation`。
- Forbidden: 纯层运行时依赖 `host/`、`browser/`、`app/` 或 `webview/`；`host/` 依赖 `app/` 或 `webview/`；`browser/` 依赖 `host/` 或非浏览器平台实现；未登记跨 feature host 耦合；`contracts.ts` 与 `contracts/index.ts` 桶；恢复已解散的 `core/`、`modules/`、`utils/`、`common/`、`base/` 根目录；把生成而未确认的正文写入 Project 存储或让生成覆盖已审阅正文。