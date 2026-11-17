# Design

## Context

动机见 `proposal.md - Why`，行为契约见 `specs/agent-result-boundary/spec.md`。

- 结果边界分两层：`src/shared/protocol/resultBoundary.ts` 的 `parseAgentResult` 只负责从原始正文里找出候选 JSON 对象（整段 / 代码块 / 每个平衡对象），不做 schema 校验；校验由 `runtime.ts` 的 `resolveAgentResult` 用 `ax.inspectOutput` 完成。
- `src/app/application.ts` 为所有 provider 都调了 `runtime.setResultRepair({ parse, repair })`。`repair` 内部对非 `codex` / `claude` 的 profile 直接返回 `{ diagnostics: "Result repair is not available for '<label>'." }`，不发起模型调用。因此「有没有修复能力」在运行时只能从修复结果看出来，没有预先可读的可用性标志。
- `resolveAgentResult` 现在有两支：解析不到对象时尝试 `plainTextAgentResult`（仅 `kind === "agent"`、原文非空、且不是「写工作区 + 要求 patch」的回合），解析到对象时只做 `normalizeAgentResult` + 校验。第二支没有纯文本兜底，这正是 Pi「正文 + 内嵌业务 JSON」硬失败的位置。
- 回归测试集中在 `test/runtime.test.ts`（已有 plain-text wrapping 断言，判断依据是状态事件标题包含 `fell back to plain-text wrapping`），边界单测在 `test/resultBoundary.test.ts`。

## Goals / Non-Goals

**Goals:**

- 让「抓到 JSON 但不是信封」的 `agent` 正文走上与「完全没抓到 JSON」相同的接受路径，且退化结果照样过同一条契约校验。
- 保持 codex / claude 已成功的 submitted 与 repair 结果优先级不变，并把差异限制在「修复已经失败之后」。
- 退化对用户可见，失败时仍保留原始信封诊断。

**Non-Goals:**

- 不把正文里的业务 JSON（`name` / `targetPath` / `nodes` 等）映射成 `AgentResult` 字段。
- 不新增配置项、开关、抽象层或模块；不改 `RuntimeResultRepair` 的形状。
- 不改 Pi 扩展的 `agent_before_settle` 提醒逻辑、`.dext/api` 契约、对外 schema 与文档。
- 不改 `parseAgentResult` 的候选扫描策略（多对象、最后者胜等）。

## Decisions

### 决策 1：退化放在「校验失败之后、最终失败之前」，并且只在解析到对象的那一支生效

`resolveAgentResult` 新增的顺序是：解析 → 校验 → （解析到对象但校验失败时）结构化修复 → 整段原文退化 → `failAgentResult`。解析不到对象那一支原本已经试过整段原文退化，用分支内已有的布尔状态跳过第二次尝试，避免对同一回合重复退化、重复发状态事件。

替代方案：在判定 `parsed !== undefined` 后立刻退化。被否决，因为那会让 codex / claude 上一段本可以被 repair 修正的答案提前变成纯文本，直接违反「repair 路径优先」。

### 决策 2：不引入「provider 是否支持修复」的探测

修复可用性目前只体现为 `repair()` 的返回值。要提前判断就得新增可用性标志或按 provider 标签分支，两者都属于新增配置/耦合，被任务边界排除。代价是 Pi 会先跑一次立即返回的 `repair()`（无模型调用、无线程），随后才退化。

替代方案：给 `RuntimeResultRepair` 加 `canRepair` 谓词。被否决：改配置形状超出「只动结果解析这一处」。

### 决策 3：退化的可用条件完全复用 `plainTextAgentResult`

不新增判定逻辑：`kind === "agent"`、原文为非空字符串、非「写工作区 + 要求 patch」。这样 spec 里「退化不得替代必需的结构化载荷」由既有函数保证，契约要求 `patch` / `files` 时退化对象自然过不了 `inspectOutput`。

### 决策 4：退化使用独立的状态事件文案

现有文案说的是「Agent 没有返回 JSON 信封」，在本分支不成立（确实返回了 JSON，只是不是信封）。新增一条同样以 `fell back to plain-text wrapping` 开头、但说明「JSON 对象不匹配结果信封」的状态事件，既让既有测试前缀断言继续有效，也不对用户说假话。

### 决策 5：诊断信息在退化成功时丢弃，失败时累加

退化成功即返回结果，不再需要把信封诊断塞进结果（结果里没有承载诊断的字段）。退化失败时把 `Plain-text wrapping failed validation: <diagnostics>` 追加到原诊断之后，与「解析不到对象」分支的写法保持一致，便于排查。

## Risks / Trade-offs

- [codex / claude 在「修复失败」时不再必然硬失败，而可能得到纯文本结果] → 这是决策 1 的已知副作用；修复成功仍优先，且退化条件被 `plainTextAgentResult` 收窄（仅 `agent`、非写工作区 + patch），因此不会让结构化 patch 被文字替代。若评审认为必须严格不变，替代实现是给 `RuntimeResultRepair` 增加可用性谓词（本设计明确排除）。
- [退化可能掩盖模型确实该产出结构化结果的错误] → 只在结果契约能被一段文本满足时才会成功；契约要求 `patch` / `files` 或回合写了工作区且要 patch 时仍然失败，spec 里各有一条场景锁住。
- [同一回合重复发出退化状态事件] → 用解析分支已有状态保证「抓不到对象」的分支不重复尝试。
- [回归测试与既有断言冲突] → 既有断言只检查事件标题包含 `fell back to plain-text wrapping`，新文案保留该前缀；`test/runtime.test.ts` 里「合法信封不报退化」的用例仍是有效护栏。

## Migration Plan

无数据迁移、无配置迁移。改动只影响下一次 Agent 回合的结果接受；回滚即还原 `resolveAgentResult` 的两处改动与对应断言。

## Open Questions

无。
