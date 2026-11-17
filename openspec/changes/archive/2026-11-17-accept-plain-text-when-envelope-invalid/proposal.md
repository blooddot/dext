# Proposal

## Why

Pi 等没有原生结构化输出、也没有 `dext_submit_result` 二次挽救通道的 provider，经常把「一句中文叙述 + 一段业务 JSON」当作最终正文返回。当前结果边界 `parseAgentResult` 能从正文里抓到那个 JSON 对象，于是把它当 `AgentResult` 信封去校验；校验失败（日志里的 `text: Invalid input: expected string, received undefined`、`Unrecognized key: "name"`）后直接走 `failAgentResult`，整个回合硬失败。只有「一个 JSON 都抓不到」时才会退化成 `plainTextAgentResult`，因此「抓到 JSON 但不是信封」这一分支是缺口：一次本可成功的回答被丢弃，而 Pi 又拿不到 codex/claude 才有的 `setResultRepair` 一次修复机会。

## What Changes

- 在 `resolveAgentResult` 的「已解析出 JSON 对象但信封校验（或 kind 归一化）失败」分支里，先尝试一次既有的 `plainTextAgentResult`：把整条原始消息当作 `text`，结果固定为 `apply = false`、`patch = false`，并继续走同一个 `inspectOutput` 契约校验。成功即返回该结果，不再失败。
- 该兜底沿用现有 `plainTextAgentResult` 的既有边界，不新增旁路：只对 `kind === "agent"` 生效，只接受非空字符串原文，写工作区且要求 `patch` 的回合仍然不允许退化成纯文本。
- 兜底成功时复用既有的 status 事件文案，把「结果退化为纯文本包裹」这件事仍然显式告诉用户；同时保留原始 diagnostics，避免掩盖信封失败的原因。
- 不新增开关、配置项、抽象层或新模块；不把正文里的业务 JSON（如 `name` / `targetPath` / `nodes`）猜测映射成 `AgentResult` 字段。
- 非法且不像正文的情况保留原有失败路径：`kind` 不是 `agent`、原文为空、写工作区且要求 `patch`、以及纯文本包裹本身也过不了契约（如 `{}`）时，仍然 `failAgentResult`。
- 结构化修复通道保持优先：codex / claude 的 submitted 路径与 repair 路径照旧先跑，修复成功的结果仍然胜出；整段原文退化只发生在修复不可用（如 Pi）或修复未产出可用结果之后。
- 新增一组最小自检断言，覆盖「非法信封退回纯文本成功」「合法信封仍按字段解析」「纯文本无 JSON 仍走 plainText」「无意义对象（`{}`）仍失败」四类，不引入新的测试框架依赖。

## Capabilities

### New Capabilities

- `agent-result-boundary`: 定义 Agent 原始正文到 Dext 结果的接受边界：合法信封必须按字段解析、无信封的正文可退化为整段 `text`、看起来像信封但校验不过的正文同样可以退化为整段 `text`，而无意义的 JSON 对象必须仍然判失败。

### Modified Capabilities

（无：`plan-acceptance` 与本次行为无关，不产生 spec 级改动。）

## Impact

- 代码：`src/features/workflow/host/runtime.ts` 的 `resolveAgentResult`（信封校验失败分支）；`src/shared/protocol/resultBoundary.ts` 与 `application.ts` 的 `setResultRepair` 配置不改。
- 测试：`test/runtime.test.ts` 或新增一个小断言文件，覆盖上述四类回归；不新增测试框架依赖。
- 行为：Pi（及任何没有 repair 通道的 provider）在「正文 + 内嵌业务 JSON」场景下从硬失败变为成功的纯文本结果；codex/claude 的已有 submitted / repair 路径不变。
- 不变项：Pi 扩展的 `agent_before_settle` 提醒逻辑、`.dext/api` 契约、Dext 对外 schema 与文档的工作方式均不改；`AgentResult.patch` 仍然只来自结构化信封。
- 风险面：写工作区且要求 `patch` 的回合仍不接受纯文本退化，因此不会让「本该审计的结构化 patch」被一段文字替代。
