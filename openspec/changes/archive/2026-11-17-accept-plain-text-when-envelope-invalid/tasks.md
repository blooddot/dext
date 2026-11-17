# Tasks

## 1. 结果边界的退化分支

- [x] 1.1 在 `src/features/workflow/host/runtime.ts` 的 `resolveAgentResult` 中记录「解析不到对象」那一支是否已经尝试过 `plainTextAgentResult`，让「解析到对象但校验失败」这一支在结构化修复之后、`failAgentResult` 之前再尝试一次 `plainTextAgentResult(context.kind, context.raw, context.allowWorkspaceWrite, context.includePatch)`；成功则经 `this.ax.inspectOutput(context.contract, wrapped)` 校验后返回，失败则跳过，避免同一回合重复退化。verify: `npm run typecheck`
- [x] 1.2 在同一处为这条新退化路径发出独立状态事件：标题以 `Agent result fell back to plain-text wrapping` 开头，说明 Agent 返回的 JSON 对象不匹配结果信封、整段消息已作为结果文本（与「没有返回任何 JSON 信封」的旧文案区分），并只在退化成功返回时发出。verify: `npm run typecheck`
- [x] 1.3 保持失败路径的诊断完整：退化未尝试或退化校验失败时，把 `Plain-text wrapping failed validation: <diagnostics>` 追加到原有信封诊断之后，仍由 `failAgentResult` 抛出包含原文前 200 字符的错误；不改 `normalizeAgentResult`、`plainTextAgentResult`、`canAttemptRepair`、`resultRepair` 调用参数与顺序以外的任何逻辑。verify: `npm run typecheck`

## 2. 回归断言

- [x] 2.1 在 `test/runtime.test.ts` 新增「真实日志形态」用例：`agent` 预演回合（`agentCall(false)`）的原始输出是「一句中文说明 + 一个含 `name`、`targetPath`、`nodes` 的 JSON 代码块」，断言执行成功、`result.text` 等于整段原文（含代码块）、且事件里出现新的退化状态文案；该用例同时锁住 spec 的「信封形状的 JSON 校验失败时退化为整段原文」。verify: `npm test -- test/runtime.test.ts`
- [x] 2.2 在同一文件补「无意义对象仍失败」用例：原始输出为 `{}`，断言该回合 rejects 且错误含契约校验诊断（例如 `text`）与 `Raw output (first 200 characters)`；同一套 `setResultRepair` 下再补「修复成功优先」用例，断言修复返回的信封胜出、`result.text` 不是整段原文、且不出现退化状态事件。verify: `npm test -- test/runtime.test.ts`
- [x] 2.3 复核既有断言仍然成立并保留原样：合法信封按字段解析且不报退化、纯 Markdown 无 JSON 仍走旧 plain-text 回退、写工作区且未声明 `patch: false` 时仍 rejects、写工作区且 `patch: false` 时仍可退化、非 `agent` 类别仍走诊断 + 修复失败路径。verify: `npm test -- test/runtime.test.ts test/resultBoundary.test.ts`
- [x] 2.4 确认这次改动没有把判定下沉进 `src/shared/protocol/resultBoundary.ts`（候选扫描策略保持不变），因此该文件的既有单测无需新增框架或改写；若实现过程中发现必须改动该文件，则在同一文件补一条 `parseAgentResult` 层面的断言而不是改结论。verify: `npm test -- test/resultBoundary.test.ts`

## 3. 集成门禁

- [x] 3.1 一起运行与结果接受相关的主机级套件并修掉失败，不弱化断言（`test/runtime.test.ts`、`test/resultBoundary.test.ts`、`test/harnessPlainTextResult.test.ts`、`test/agentRunner.test.ts`）。verify: `npm test -- test/runtime.test.ts test/resultBoundary.test.ts test/harnessPlainTextResult.test.ts test/agentRunner.test.ts`
- [x] 3.2 运行仓库完整门禁。verify: `npm run check`
- [x] 3.3 交付汇报分两段：已由自动检查验证的解析结果（真实日志形态成功、三类回归、门禁），以及仍需用户在自己环境里验收的部分（用真实 Pi 客户端重放一次该回合）。

## Workflow follow-up

- 评审通过后归档该 change。
- 归档后确认 `openspec/specs/agent-result-boundary/spec.md` 的 `## Purpose` 已由本次 delta 带入。
