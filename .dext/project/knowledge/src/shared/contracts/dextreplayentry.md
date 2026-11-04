## Responsibility

- **Names**: DextReplayEntry → `src/shared/contracts/replay.ts`（唯一导出 `DextReplayEntry`，三个字段 `method` / `arguments` / `response`）。这一族能力没有界面名，也没有第二份同名实现。
- 它只拥有一个形状：Code 运行期间**一次已记录 API 调用**的可重放描述——调了哪个方法、用什么参数、拿到了什么响应。整个文件只有一条 `interface`，没有函数、常量或运行时校验，所以它既不是记录缓存，也不是重放策略。
- 它拥有这份数据能跨越的边界：一条记录经 `DextHostMessage.run.replay`（`src/runner/dextProtocol.ts`）从扩展宿主送进 kernel，在 `DextResumeCache`（`src/runner/dextResumeCache.ts`）里累积，并在 `replay()`（`src/runner/dextRuntime.mjs`）里比对；因此形状必须同时是「可 JSON 序列化的普通对象」与「重放端唯一认得的类型」。
- 它不拥有重放本身：录什么、何时录、匹配失败怎么办，分别属于 `DextResumeCache.record`、装配层与 kernel 的 `replay()`；本契约只回答一条记录长什么样。
- 形状如此，是因为记录者与重放者分处两个进程、两层目录：`src/features/conversations/contracts/execution.ts` 属纯层，不能依赖 `src/runner/`；而 kernel 只能依赖 `src/shared/`。把形状放进 `shared/contracts/` 后，两侧只依赖契约而互不依赖；`DextResumeCache` 再用 `import type` 加 `export type` 把它转手给 `src/app/` 与 `src/features/conversations/host/`，一处定义、多处引用。

## Design

- **只有三个字段，没有身份字段。** 没有 id、时间戳、序号或尝试次数：调用顺序由数组下标表达，重放身份由消费端按「位置 + `method` + `arguments`」现算（kernel 用 `__dextReplayIndex` 递增，不比对象里的任何字段）。契约里再加一个序号，就让「顺序」出现第二种说法。
- **值刻意不透明。** `arguments` 是 `Record<string, unknown>`、`response` 是 `unknown`：记录层不知道也不该知道每个 API 方法的参数与结果类型，响应原样交还给下一次运行，而不是在过境时被某份 schema 重新解释。若在此收窄成 `DextResult` 或某个方法专用类型，`ask` 的结果与 `terminal` 的输出就得在同一份契约里互相妥协。
- **可序列化是硬约束，风格是软约束。** 这条数据要穿过宿主与 kernel 之间的消息边界，所以没有类、方法、`Map`/`Set`、`Date` 或 `readonly` 修饰。`dextProtocol.ts` 在 `DextHostMessage` 上内联同一形状而不引用本文件：那一侧描述线上报文，本文件描述记录单元，字段名必须一致，形状却不合成一个会各自漂移的定义。
- **比较规则不在契约里。** kernel 的 `replay()` 用 `stableStringify`（按键排序后序列化）比较参数，因此 `{a:1,b:2}` 与 `{b:2,a:1}` 视为同一次调用；不匹配即抛错，错误文案与 `src/runner/dextResumeCache.ts` 的 `CHANGED_SINCE_STOPPED` 同一句，而不是退化成「悄悄重跑一次」。把匹配留给 kernel，契约才能在宿主、kernel 与测试之间保持中立。
- **失败不是静默复用。** 记录看不到的输入（`Date.now()`、`Math.random()`、`process.env`、直读文件）会让第二次运行走另一条路径；此时把旧响应贴到新调用上比重新执行更危险，所以重放序列一旦错位就是硬错误。
- **一次尝试一份记录。** `DextResumeCache` 构造时注入上一轮记录（`replay` getter 原样交出），`record()` 只追加本轮真实发生的调用（`entries` getter）。本契约不区分这两者，因为结构相同——差别在「谁写的」，不在「长什么样」。

## Boundary

- Allowed: 被 `src/features/conversations/contracts/execution.ts`（`TurnExecutionHost.execute` 的 `resume` / `onCallLog`）、`src/app/application.ts`、`src/app/conversationSetup.ts`、`src/app/sidebarProvider.ts`、`src/features/conversations/host/turnExecutionCoordinator.ts` 与 `src/runner/dextHost.ts` 以 `import type` 引用；经 `src/runner/dextResumeCache.ts` 的 `import type` 加 `export type` 再导出；作为 JSON 数据出现在 `DextHostMessage` 的 `run.replay` 上；被 `test/dextResume.test.ts`、`test/dextWorkflowCases.ts`、`test/conversationHarness.ts` 直接构造。
- Allowed: 只依赖 TypeScript 内建类型（`Record<string, unknown>`、`unknown`），保持零 import、零副作用、零状态，使扩展宿主、纯层、kernel 与测试读到的都是同一份形状。
- Forbidden: 导入 Node、VS Code、`src/runner/`、`src/app/` 或任何 feature 实现（`shared/` 不得反向依赖环境或业务，否则 kernel 与纯层会被拖进宿主）；在此放类、默认值、zod schema 或运行时校验——校验属于记录者与 kernel 的匹配步骤。
- Forbidden: 承载记录、比较、重放、持久化或恢复策略（分别归 `DextResumeCache.record`、kernel 的 `replay()` 与 `stableStringify`、装配层与 `runs/` 下的运行记录）；为单个 API 方法增加专用字段或按方法拆成联合类型；把 UI 文案、错误消息或产品名写进契约（`CHANGED_SINCE_STOPPED` 是 `dextResumeCache.ts` 的常量，不在本文件）。
- Forbidden: 把 `response` 收窄成具体结果类型、把 `arguments` 打开成 `unknown`（那样 `stableStringify` 的比较基准会随调用方漂移），或在此新增 `id` / `index` / `timestamp` 让顺序有第二种表达。