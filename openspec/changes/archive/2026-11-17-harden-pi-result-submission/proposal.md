# Proposal

## Why

Pi 从 1.4.0 起就没有 provider 级的「最终消息 = JSON schema」模式，Dext 因此把 `dext_submit_result` 注册成参数即结果契约的普通工具（`media/pi-extension.mjs`）。但这次注册声明没有用上 Pi 已经提供的两个工具级能力：`terminate` 与 `constrainedSampling`。于是提交被接受后 Pi 仍可能再发起一轮模型请求，用户会看到「已经提交了又补一段正文」，而这段正文又会回到宿主的正文兜底路径；provider 侧也只能靠自然语言描述去猜参数形状。

计划期核对源码还发现第三个缺口：Pi 的 `terminate` 只让当前 tool batch 之后不再发起请求，最后一条 assistant 消息的 `stopReason` 仍然是 `"toolUse"`（1.4.0 与 1.5.2 的实现一致，RPC 也不改写 `message_end`）。Dext 现有守卫在 `agent_settled` 时遇到 `"toolUse"` / `"pending"` 会直接判该回合失败，因此只加 `terminate` 会把已经 accepted 的结果丢掉。补上这个配套是本次「提交成功即结束回合」真正生效的前提。

## What Changes

- `media/pi-extension.mjs` 的 `dext_submit_result` 注册与 `execute`：只有当 `reply.status === "accepted"` 时返回带 `terminate: true` 的工具结果；`rejected` / `unavailable` / `cancelled` 的结果形状保持原样、不带 `terminate`，被拒绝的提交必须让模型在同一回合继续修正。
- 同一处注册增加 `constrainedSampling: { type: "json_schema", strict: "prefer" }`，让支持 strict 模式的 provider 收到约束后的 schema；不支持或 strict 子集不满足时由 Pi 静默回退到普通 schema。
- 计划期发现的必要配套（原始任务边界未列出，见 `design.md` 的决策 3）：`src/features/agents/host/piAgentRunner.ts` 的 `agent_settled` 分支，在 `active.submitted` 已存在时不再因 `stopReason` 为 `toolUse` / `pending` 判「Pi stopped before producing a final response.」。
- `test/piExtension.test.ts` 增加最小断言：accepted 结果带 `terminate: true`；`rejected` 与 `unavailable` 结果不带 `terminate`；注册项的 `constrainedSampling` 为 `{ type: "json_schema", strict: "prefer" }` 且显式断言不等于 `"require"`；既有断言（提交成功置 `submitted`、拒绝后同轮可再提交、工具名与 `parameters` 透传）保持通过。
- 新增 capability `pi-result-submission`，把上述行为写成可验收的需求与场景，并把三项已知边界（批量 terminate 语义、strict 改写 schema 与可选字段 null、`constrainedSampling` 不覆盖「模型不调用工具」）写成显式记录。

## Non-goals

- 不通过 `before_provider_request` 改 payload 注入 provider 原生字段（`response_format` / `text.format` / `output_config.format`）：三套字段各不同；strict 子集常不满足（Dext 结果体含 `patch` / `files`）；与中间工具轮冲突且扩展无法预知哪次是最后一次请求；未覆盖的 provider 会静默失效。
- 不安装第三方插件：`@ipfans/pi-structured-output` 明确拒绝 `--mode json` 与 RPC 模式；`nil4u/pi-structured-output` 绑定 Pi SDK（`createAgentSession`），Dext 是子进程 + RPC，不能直接用。
- 不改 `src/features/workflow/host/runtime.ts` 的结果解析与 `failAgentResult` 分支（属于 `accept-plain-text-when-envelope-invalid`）。
- 不改 `agent_before_settle` 的提醒逻辑，不改 `.dext/api` 契约，不改 Dext 对外 schema 与文档的工作方式。
- 不为了让 strict 生效去改 `config.resultSchema`（它是本地参数校验的唯一依据）。
- 不升级 Pi 版本门禁（`src/features/agents/host/piCommand.ts` 的 Pi ≥ 1.4.0 已满足），也不新增开关、配置项、抽象层或新模块；不带无关格式化。

## Capabilities

### New Capabilities

- `pi-result-submission`: 定义 Pi 扩展里 `dext_submit_result` 的提交语义——只在提交被接受时结束回合、被拒绝时继续同轮修正、注册项声明 provider 侧约束采样，并记录 Pi 的批量终止语义与 strict schema 改写的已知边界。

### Modified Capabilities

（无：`agent-result-boundary` 管的是原始正文到结果的解析与退化，`plan-acceptance` 与本次无关，都不产生 spec 级改动。）

## Impact

- 代码：`media/pi-extension.mjs`（`dext_submit_result` 注册与 `execute`）；`src/features/agents/host/piAgentRunner.ts`（`record` 的 `agent_settled` 分支一行守卫）。
- 测试：`test/piExtension.test.ts`；`test/piAgentRunner.test.ts` 或 `test/piCapabilities.integration.test.ts` 补一条「accepted 提交 + 最后一条 assistant 为 `toolUse` 仍算成功」的宿主断言。
- 行为：Pi 回合在提交被接受后不再多走一轮模型请求，也不会再因 `stopReason: "toolUse"` 被判失败；被拒绝的提交仍会拿到诊断并可在同轮重新提交；支持 strict 的 provider 会收到全属性必填、可选属性可空后的 schema。
- 不变项：宿主的结果解析、纯文本退化、`agent_before_settle` 提醒、`.dext/api` 契约、Dext 对外 schema 与文档均不改；Pi 版本要求不变。
- 风险面：`terminate` 只在整批工具结果都带 `terminate` 时生效（同批并行调用其它工具时本工具单独带 `terminate` 不会提前结束）；strict 改写会让模型可能对可选字段提交 `null`；`constrainedSampling` 不影响「模型根本不调用本工具」的情形。
