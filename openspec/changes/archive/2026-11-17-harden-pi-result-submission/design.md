# Design

## Context

动机见 `proposal.md - Why`，行为契约见 `specs/pi-result-submission/spec.md`。

Pi 回合的提交链路（已核对源码）：

- `src/features/agents/host/piAgentRunner.ts` 通过 `PiRpcTransport` 启动 Pi 子进程，并把扩展需要的配置写进 `PiBridge`：`resultSchema: resultToolParameters(request.contract.outputJsonSchema)`（`harnessResultTool.ts:72`，只删 `$schema`）。注意它不像 `harnessResultTool` 那样检查根 schema 是否为 `object`，所以 `ui` 的 `oneOf` 契约同样会被注册成工具参数。
- `media/pi-extension.mjs` 用 `pi.registerTool({ name: "dext_submit_result", parameters: config.resultSchema, execute })` 注册；`execute` 把参数经 socket 发给宿主。宿主在 `bridgeRequest` 里用 `contract.outputSchema` 校验：通过则 `active.submitted = JSON.stringify(parsed.data)` 并回 `{ status: "accepted" }`，失败回 `{ status: "rejected", diagnostics }`；socket 断开或回合结束回 `unavailable`，abort 回 `cancelled`。
- 回合结束由 Pi 的 `agent_settled` 决定；`execute` 取 `active.submitted ?? active.events.finalText`。如果 settle 之前被 reject，这条取值根本不会执行。
- 扩展内 `result(reply)` 返回 `{ content: [{ type: "text", text: JSON.stringify(reply) }], isError: ["unavailable","rejected"].includes(reply.status) }`，是本次要扩展的唯一结果构造点。

Pi 侧能力与语义（1.4.0 与 1.5.2 一致，已逐份核对 `pi-agent-core/dist/agent-loop.js`、`pi-ai/dist/api/constrained-sampling.js`、`pi-coding-agent/dist/core/agent-session.js` 与 RPC 的 `json-event.js`）：

- `AgentToolResult.terminate` 只把 `hasMoreToolCalls` 置为 `false`（`shouldTerminateToolBatch` 要求该批**每个**最终结果都是 `terminate: true`）。它不改写最后一条 assistant 消息的 `stopReason`，RPC 的 `toJsonEvent` 也不改写 `message_end`。
- `ToolDefinition.constrainedSampling` 由 `resolveJsonSchemaStrictSampling` 解析：`makeStrictJsonSchema` 把可选属性包成 `anyOf: [prop, { type: "null" }]`、把 `required` 补成全部属性、要求 `additionalProperties: false` 且根必须是 `object`；抛 `UnsupportedStrictJsonSchemaError` 时 `strict: "prefer"` 回退，`"require"` 直接抛错。
- 本地参数校验用的是注册时的原始 schema，不是 strict 转换后的副本（转换在 Pi 内部 `structuredClone`，不写回 `parameters`）；strict 引入的「可选属性 null」在 1.4.0 由 `pi-ai` 的 `normalizeOptionalNulls` 删除，1.5.2 由 `pi-schema` 的 `coerce` Pass 1 删除，只覆盖 object `properties` 与数组 `items`。

## Goals / Non-Goals

**Goals:**

- accepted 提交后 Pi 不再发起下一轮模型请求，并且宿主不会把这次提前结束当成失败。
- provider 侧尽量按契约约束参数，且 strict 不可用时不产生任何新的失败路径。
- 回归断言锁住三种 `status` 的结果形状与注册声明，既有断言不改。

**Non-Goals:**

- 不改宿主的结果解析、纯文本退化、`agent_before_settle` 提醒、`.dext/api` 与对外 schema。
- 不注入 provider 原生结构化输出字段，不引入开关、配置项、抽象层或新模块。
- 不处理「模型根本不调用 `dext_submit_result`」的情形（由既有提醒与宿主正文兜底覆盖）。
- 不升级 Pi 版本门禁，也不依赖 1.5.2 才有的能力。

## Decisions

### 决策 1：`terminate` 只在 `accepted` 分支返回

做法：`execute` 保留 `if (reply.status === "accepted") submitted = true`，返回值在 `accepted` 时附加 `terminate: true`，其余状态原样返回 `result(reply)`。

理由：被拒绝的提交必须让模型在同一回合读到契约诊断并重新提交——这正是 tool-based 结构化通道相对「正文 + 解析」的价值（`harnessResultTool.ts` 的注释与 `pi-agent-core` 的「拒绝即普通 tool error」语义都建立在这点上）。若 `rejected` 也终止，模型失去修正机会，回合会以「没有结果」结束，比现在的行为更差。

代价：`unavailable`（bridge 断开、回合已结束）与 `cancelled`（abort）继续按原样返回，不参与提前终止；这些路径本来也没有可继续的回合。

### 决策 2：`constrainedSampling` 必须用 `"prefer"`

理由：`"require"` 在 strict 子集不满足或 provider 不支持 strict 时抛错，而错误的抛出点在**每回合的注册/请求阶段**，会直接打断整个回合。Dext 自身的契约里就有必然不满足 strict 的情形：`ui` 契约根是 `oneOf`（`makeStrictJsonSchema` 以 "root schema must have type object" 拒绝），而 `piAgentRunner` 对所有带契约的回合都注册工具。`"prefer"` 在同样情形下返回 `undefined` 并回退到普通 schema，最坏情况等于本次改动之前。

同时确认这条声明对内置 `agent` 结果契约是有效的：`z.toJSONSchema(agentResultSchema)` 产出的是内联对象（无 `$ref`/`$defs`）、`additionalProperties: false`、根为 `object`，满足 strict 子集，因此 `patch` / `files` / `summary` 这类字段能真正进入 provider 的约束。

### 决策 3：宿主侧加一行「已接受提交优先」的守卫

做法：`piAgentRunner.record` 的 `agent_settled` 分支把 `["toolUse","pending"].includes(...)` 的判定收窄为「本回合还没有 accepted 提交」。

理由：这是计划期发现、原任务边界未列出的第三处改动。`terminate` 的语义是「不再发起下一次请求」，不是「把最后一条消息改成 `stop`」，所以回合会以 `stopReason: "toolUse"` 结算。现有守卫会先 `reject("Pi stopped before producing a final response.")`，`active.submitted` 里的 accepted 结果被丢弃——只加 `terminate` 会让每次成功提交都变成失败。升级 Pi 不改变这一点（1.5.2 实现相同），所以这不是版本问题。

替代方案 A：扩展用 `pi.on("message_end")` 把含 `dext_submit_result` 调用的 assistant 消息改写成 `stopReason: "stop"`。被否决：`message_end` 在工具执行**之前**触发，扩展无法知道提交是否会被接受，只能对 provider 的真实停止原因谎报，并污染会话记录。

替代方案 B：只加 `constrainedSampling`、放弃 `terminate`。被否决：用户看到「已提交又补一段正文」的核心问题不解决。

边界：守卫只在 `active.submitted` 存在时放宽；没有任何 accepted 提交的 `toolUse` / `pending` 仍然按原样判失败，`test/piAgentRunner.test.ts` 里需要一条负向断言锁住。

### 决策 4：测试用现有 mock `registerTool` 与 RPC fixture 断言形状

- 扩展侧：`test/piExtension.test.ts` 已经用真实 `PiBridge` 驱动 `media/pi-extension.mjs`，工具对象存在 `tools` map 里。把测试里 `Tool` 接口补上 `constrainedSampling?: unknown` 与 `execute` 返回值的 `terminate?: boolean`，即可直接断言三种 `status` 下的结果形状与注册声明；不需要新框架、不需要真实 Pi。
- 宿主侧：`test/fixtures/piAgent.mjs` 已经能向 bridge 发 `submit_result`。新增一个 prompt 关键字分支：先提交一个合法结果（接受），再发一条 `stopReason: "toolUse"` 的 assistant 消息并 `agent_settled`；`test/piAgentRunner.test.ts` 用带 `contract` 的请求断言该回合 resolves 为被接受的 JSON。再补一条不提交、只发 `toolUse` 的负向分支，断言仍 rejects。

## Risks / Trade-offs

- [同批并行调用其它工具时 `terminate` 不生效] → 这是 Pi 的批量语义（`shouldTerminateToolBatch` 要求整批都为终止），不是本扩展的缺陷；spec 用一条场景显式记录，不试图消除。
- [strict 改写会让模型对可选字段提交 `null`] → 本地校验仍用原始 `config.resultSchema`；Pi 在 1.4.0 / 1.5.2 都会在本地校验前删除可选属性上的 `null`（`normalizeOptionalNulls` / `pi-schema` `coerce` Pass 1）。残留风险只在不会被遍历到的位置（union 分支内部等），此时提交回 `rejected`，模型可在同轮修正，因为 `rejected` 不终止回合。不通过修改 `config.resultSchema` 来消除这个差异。
- [strict 子集不满足或 provider 不支持 strict] → `"prefer"` 静默回退，行为等同改动之前；不使用 `"require"`。
- [`constrainedSampling` 不影响「模型不调用工具」] → 那种情形仍由既有 `agent_before_settle` 提醒与另一个 change（宿主侧正文兜底）覆盖；本次设计不碰这两处。
- [宿主守卫放宽后可能吞掉真正的「Pi 停在工具轮」故障] → 只在 `active.submitted` 存在时放宽，而 `active.submitted` 只由通过契约校验的提交写入；未提交的 `toolUse` / `pending` 仍判失败，并有负向断言。
- [版本漂移] → 本次依赖的两个能力在 Dext 最低支持的 Pi 1.4.0 已存在（内置工具同样使用 `strict: "prefer"`），不改 `piCommand.ts` 的版本校验；若未来 Pi 改写 `terminate` 的 `stopReason` 语义，宿主守卫会变成无害的兼容分支。

## Migration Plan

无数据迁移、无配置迁移、无版本门禁变化。

部署顺序：扩展改动与宿主守卫必须同批发布——只发扩展会让 accepted 回合被旧守卫判失败。回滚即同时还原 `media/pi-extension.mjs` 的注册/`execute` 与 `piAgentRunner.record` 的守卫，并删除新增断言。

## Open Questions

无。
