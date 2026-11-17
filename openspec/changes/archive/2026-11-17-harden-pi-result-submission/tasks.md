# Tasks

## 1. 扩展的提交语义与约束采样声明

- [x] 1.1 在 `media/pi-extension.mjs` 的 `dext_submit_result` 注册里，让 `execute` 只在本回合提交被接受时提前结束：保留 `if (reply.status === "accepted") submitted = true`，并在 `accepted` 时返回带 `terminate: true` 的结果；`rejected`、`unavailable`、`cancelled` 仍返回 `result(reply)` 的原始形状（不带 `terminate`）。verify: `npm test -- test/piExtension.test.ts`
- [x] 1.2 在同一注册项上加 `constrainedSampling: { type: "json_schema", strict: "prefer" }`，不使用 `"require"`；`parameters` 仍直接是 `config.resultSchema`（不删字段、不做 strict 改写）。verify: `npm test -- test/piExtension.test.ts`
- [x] 1.3 扩展 `test/piExtension.test.ts` 顶部 `Tool` 接口以承载新字段（`constrainedSampling?: unknown`，`execute` 返回值加 `terminate?: boolean`），并在现有「registers the real schema…」用例里补断言：accepted 的 `execute` 结果 `terminate === true`；`rejected` 与 `unavailable` 的结果不带 `terminate`；注册项 `constrainedSampling` 深等于 `{ type: "json_schema", strict: "prefer" }` 且显式断言 `!== "require"`。verify: `npm run typecheck`
- [x] 1.4 复核同一用例里既有断言仍成立且不改写：提交成功置 `submitted`、被拒绝后同轮可再提交、`parameters` 与传入 `resultSchema` 深相等、工具名列在 `tools` 里。verify: `npm test -- test/piExtension.test.ts`

## 2. 宿主对已接受提交的 settle 容忍

- [x] 2.1 在 `src/features/agents/host/piAgentRunner.ts` 的 `record` 里收窄 `agent_settled` 守卫：只有在本回合还没有 `active.submitted` 时，才因 `["toolUse","pending"].includes(active.events.stopReason)` 判 `Pi stopped before producing a final response.`；`submitted` 的取值与 `execute` 末尾的 `active.submitted ?? active.events.finalText` 保持不变。verify: `npm run typecheck`
- [x] 2.2 在 `test/fixtures/piAgent.mjs` 的 `prompt` 分支里增加一个最小场景（新的 prompt 关键字，放在既有 `else if (config?.resultSchema)` 之前）：先 `await call("submit_result", { args: example(config.resultSchema) })` 拿到接受，再发一条 `stopReason: "toolUse"` 的 assistant 消息，随后 `agent_settled`。verify: `node --check test/fixtures/piAgent.mjs`
- [x] 2.3 在 `test/piAgentRunner.test.ts` 增加正向用例：带 `contract`（`outputSchema` + `outputJsonSchema`）的请求走上述 fixture 场景时 resolves，且返回值是被接受的 JSON；并在同一用例里断言 `runConversation` 不会抛「Pi stopped before producing a final response.」。verify: `npm test -- test/piAgentRunner.test.ts`
- [x] 2.4 在同一文件增加负向用例：没有提交、只以 `stopReason: "toolUse"` 结束的回合仍然 rejects，错误信息含 `Pi stopped before producing a final response.`，证明守卫只对 accepted 提交放宽。verify: `npm test -- test/piAgentRunner.test.ts`

## 3. 集成门禁

- [x] 3.1 一起运行与 Pi 提交链相关的套件并修掉失败，不弱化断言（`test/piExtension.test.ts`、`test/piAgentRunner.test.ts`、`test/piEvents.test.ts`、`test/piCapabilities.integration.test.ts`）。verify: `npm test -- test/piExtension.test.ts test/piAgentRunner.test.ts test/piEvents.test.ts test/piCapabilities.integration.test.ts`
- [x] 3.2 运行仓库完整门禁。verify: `npm run check`
- [x] 3.3 交付汇报分两段：已由自动检查验证的部分（扩展结果形状、注册声明、宿主 settle 容忍、门禁），以及仍需用户自行验收的部分（用真实 Pi 客户端观察「提交成功后不再补正文」与 strict 下可选字段的实际表现）。

## Workflow follow-up

- 评审通过后归档该 change。
- 归档后确认 `openspec/specs/pi-result-submission/spec.md` 的 `## Purpose` 已由本次 delta 带入。
