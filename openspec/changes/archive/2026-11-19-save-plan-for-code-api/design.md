# Design

## Context

现状与约束（动机见 proposal.md）：

- UI Plan：`DextApplication.executeConversation` 在拿到 `runtime.executeConversation("plan", …)` 的响应后调用私有 `savePlan`。它用 `splitPlanResponse` 拆出对话回复与计划文档，按 `dext.planDirectory`、`dext.storage.location` 决定目录，用 `planFileName` 生成 `时间戳-slug-序号.plan.md` 并跳过已存在文件，写入成功后返回 `planPath`（`global` 为 `.dext-global/plans/<name>`，`workspace` 为 `<segments>/<name>`）。`planUri`、`DextStorage.uriForReference` 负责把该引用解析成 `vscode.Uri`，UI 打开计划、修订与 Build 都依赖这条链路。
- 代码 API：`DextApplication.executeInput` → `DextKernelHost.runSource` → Kernel 通过 `request` 消息调用宿主的 `options.execute`，该回调当前直接是 `runtime.execute`。宿主在 `onRequest` 里把响应经 `toBoundaryJson` 序列化，再 `DextResumeCache.record`，然后才回给 Kernel；Kernel 把 `response.result` 返回给用户代码。`runtime.execute` 对 `plan` 只按结果契约校验 `{ kind: "plan", text }`，不注入 `PLAN_RESPONSE_FORMAT_INSTRUCTION`，因此计划文本既没有对话/文档分隔符，也不会经过 `savePlan`。
- `PlanResult` 已有可选 `planPath` 字段；`global` storage 的引用前缀固定在 `DextStorage` 内部，外部 Node 进程无法解析。
- 存储位置只能是 `dext.storage.location`（`global`/`workspace`，见 `DextStorage.location()`）。`DextStorage.directory("plans")` 在 `global` 下返回 `<globalStorageUri>/plans`，在 `workspace` 下返回 `<workspace>/.dext/plans`；但 `savePlan` 的 `workspace` 分支自己用 `planDirectory()`（`dext.planDirectory`，默认 `.dext/plans`）+ `planPathSegments` 算目录，并用 `[...segments, name].join("/")` 生成相对引用，`.dext` 只是默认值。`DextStorage.reference("plans", name)` 才是 `.dext-global/plans/<name>` 这种引用形式的唯一来源。
- `DextStorage.uriForReference()` 不看当前设置：它同时识别 `global` 与 `workspace` 两种前缀（`global` 前缀用 `globalStorageUri` 解析，`workspace` 用工作区根拼接），所以显式存到另一位置的计划仍能被 `planUri`、UI 打开计划、修订与 Build 找到。这也是“单次调用选位置”能安全相加的前提。
- `plan` 的输入契约由 `builtins.ts` 声明，经 `axAdapter.inputSchema` 编译成 `z.object(...).strict()` 并在 `runtime.execute` 里校验（`this.ax.validateInput`）：未声明的参数会直接报错，所以新增选项必须写进 `builtins.ts`，不能只在宿主包装里临时读一个没有声明过的字段。`.dext/api/dext.d.ts`、API 参考签名与 `builtins.ts` 来自同一份声明，因此声明改了就要重新生成。
- `agentRunner.agentPayload` 会把非 `internal` 参数原样放进发给 Provider 的参数信封（`agent` 的 `apply`/`patch` 就是这样），`internal` 参数则被过滤掉。

## Goals / Non-Goals

**Goals:**

- 代码 API 的 `plan()` 用公开选项 `save` 控制是否落盘，用公开选项 `location` 在既有两个存储位置间选择，默认都保持现状（保存、跟随设置）。
- 代码 API 的 `plan()` 在结果离开宿主前写入计划文件，并让 `planPath` 是外部 Node 可直接读取的路径。
- UI Plan 与代码 API 共用写入实现：目录、命名、冲突检测、`workspace` 信任判断、写入内容一致。
- 保存发生在 Kernel 响应的 JSON 边界与 replay 记录之前，使返回值、Output、重放缓存看到同一份结果。
- 失败语义与现状一致：写入异常让调用失败，其余前置条件不满足时不返回 `planPath`。

**Non-Goals:**

- 不为 UI Plan 增加保存开关或位置选择器：UI 没有传 `save`/`location` 的入口，Plan 回合仍恒定按设置保存。
- 不新增第二套计划目录、命名、冲突检测或存储位置配置：`location` 只是在 `global` 与 `workspace` 两个既有位置间选择。
- 不改写 `dext.storage.location` / `dext.planDirectory` 设置（显式 `location` 只影响当次调用）。
- 不修改 UI Plan 的 `planPath` 引用格式、计划修订、Build、历史记录与打开计划逻辑。
- 不改动 Kernel 协议形状、`dextRuntime.mjs`、`dextHost.ts` 的消息类型或 `PlanResult` 的字段集合。
- 不改动调用方 Bext，也不顺带重构 `runtime.execute` 的其他调用路径。
- 不为代码 API 重新设计 Plan 指令或文档模板。

## Decisions

### 在 Kernel 调用的宿主执行包装中保存

在 `DextApplication.kernelHost()` 创建 `DextKernelHost` 时，把 `execute` 回调从 `runtime.execute` 改为一个私有包装：先 `await runtime.execute(...)`，当 `invocation.method` 为 `plan`、调用方没有传 `save: false`、且结果为非空计划文本时，按 `invocation.arguments.location ?? this.storage.location()` 解析生效位置并调用共用写入逻辑，把 `planPath` 写回 `response.result` 的返回副本，再返回给 `DextKernelHost`。

理由：`DextHost.onRequest` 的顺序是「`options.execute` → `toBoundaryJson` → `DextResumeCache.record` → 发送响应」。在 `options.execute` 内部完成保存，能让 `planPath` 天然进入边界序列化与重放记录，不需要在 `executeInput` 里二次遍历 `steps`/`executions` 并手动修补缓存。

考虑过的替代方案：

- 在 `executeInput` 拿到 `InputExecutionResponse` 后再补 `planPath`：改动少，但 replay 记录已在 `onRequest` 完成，重放返回的响应会缺少 `planPath`，需要额外改动协议或缓存才能保持一致，违背「重放结果保持可用」。
- 在 `runtime.execute` 内直接保存：`runtime` 是内核侧共用的纯逻辑层，没有 `vscode` 与 `DextStorage`，把宿主存储职责塞进去会污染分层，也会影响非代码路径。

### 用公开的 `save` 选项控制是否落盘

`plan` 的输入契约新增 `save: boolean`（默认 `true`，见 `src/features/workflow/domain/builtins.ts`），Kernel 包装从 `invocation.arguments` 读这个值，只有 `save !== false` 时才走共用写入：

- 参数缺席按 `true` 处理。`default: true` 是 zod 契约的一部分，`runtime.execute` 在校验时把它填进 `resolved.arguments`；宿主包装拿到的是 Kernel 传来的原始 `invocation.arguments`，所以判据是「不是显式 `false`」，而不是「等于 `true`」。
- `save: false` 原样返回 `runtime.execute` 的响应：不写文件、不附加 `planPath`，也不报错——不保存是调用方的选择，不是失败。
- UI Plan 不经过这个包装（UI 走 `executeConversation` → 私有 `savePlan`），因此没有开关，保存行为不变。
- 该字段不标 `internal`：`agent` 的 `apply`/`patch` 就是同类的「这次要不要写」公开布尔量，同样会出现在 `agentPayload` 的参数里；标成 `internal` 虽然能让它不进 Provider 信封，但会把 `CONVERSATION_METHODS` 的既有注释（「`internal` 只额外保留 `skills`/`rules`」）变成不断追加的特例清单，收益抵不上语义偏移。

考虑过的替代方案：

- 命名 `savePlan`：与 `planPath` 字段和私有 `savePlan()` 方法重名，`plan({ save: false })` 已经足够明确，也与 `apply`/`patch`/`echo` 的单短词风格一致。
- 始终保存、不提供选项（本变更最早的方案）：对 Bext 这类要文件的调用方最省事，但不需要文件的调用方会被迫产生计划文件，也无法避开 `global` storage 下的绝对路径，正是这次要修的地方。
- 把开关塞进 `metadata`、设置项或环境变量：绕开参数契约，类型提示与严格校验都看不到，调用方无从发现，也无法在同一个 Code 文件里按调用区分。

### 抽出共用写入函数，分别返回引用与物理路径

把 `savePlan` 中「判定预置条件是否满足 → 按位置选择目录 → 生成不冲突文件名 → 修订哈希校验 → 写文件」的部分抽成一个私有方法（暂称 `writePlanFile`），入参为计划文档文本、**本次生效的位置**、可选既有路径与可选期望哈希，返回 `{ reference, filePath }`：

- `location` 参数为该次调用解析出的 `StorageLocation`：代码 API 取 `plan` 参数或设置，UI 恒取设置（即 `this.storage.location()`），所以 UI 调用点的语义完全不变，只是参数从隐式变成显式。
- `reference`：沿用现有 `planPath` 形式（`global` 为 `storage.reference("plans", name)`，`workspace` 为 `[...segments, name].join("/")`）。
- `filePath`：写入目标的 `vscode.Uri.fsPath`，即操作系统原生的绝对路径。

`savePlan` 继续用 `reference` 作为 UI 的 `planPath`；代码 API 包装用 `filePath`（`global`）或 `reference`（`workspace`）作为 `planPath`。文档文本由调用方提供：UI 传入 `splitPlanResponse(result.text).document`，对话文本仍取 `plan.conversation`；代码 API 传入原始 `result.text.trim()`。空文本、无文档、有效位置为 `workspace` 且工作区不受信任／不存在时返回 `undefined`，调用方保持响应不变。写入函数本身不判断 `save`：是否保存由调用方决定（UI 恒定保存，代码 API 由选项决定），写入函数只负责「给定了文档与位置就写到该位置下不冲突的文件」。

考虑过的替代方案：

- 给 `savePlan` 加 `readable: boolean` 参数：签名会同时承担「拆分 UI 文本」和「选择路径形态」两件事，调用点难读，且代码 API 并不需要分隔符拆分。
- 把位置计算放在 `writePlanFile` 里重新拼一遍（`joinPath(globalStorageUri, "plans")` 或 `joinPath(workspaceUri, ...planPathSegments(...))`）：会与 `DextStorage` 的目录/引用规则形成第二份重复定义，正是本变更要避免的。因此给 `DextStorage.directory()`/`reference()` 加可选位置参数（缺省仍读设置），让位置选择继续只有一处实现。
- 把 `planPath` 全局改成绝对路径：会让 UI 历史记录、`planUri` 解析和计划引用全部变化，违反 UI 兼容要求。

### 用公开的 location 枚举选择已有的两个存储位置

`plan` 的输入契约新增 `location`（`type: "enum"`, `values: ["global", "workspace"]`，无 `default`），取值直接复用 `STORAGE_LOCATIONS` 的枚举词，与 `dext.storage.location` 设置同名同值：

- 不提供时没有 zod 默认值，字段保持 `optional`，宿主包装读到 `undefined` 就回落 `this.storage.location()`——这正是改动前的行为，因此现有调用方（包括 Bext）不受影响。位置解析放在宿主包装里，`runtime.execute` 与 Kernel 仍不知道存储位置。
- 提供时只作用于当次保存：不写设置、不持久化、不影响后续调用，也不改变计划目录内的命名与重名规则。
- `global` 位置使用 `globalStorageUri/plans`（`storage.directory("plans", "global")`），`workspace` 位置使用 `dext.planDirectory` + `planPathSegments`（现有 `savePlan` 分支）。两者都是既有规则，位置参数只是把 `DextStorage` 里“读设置”的那一步变成“读参数”。
- 优先级明确：`save: false` 或空计划文本先短路，`location` 不被使用也不报错；修订（`existingPath`）恒写回原文件，`location` 被忽略。与 `save` 一样，该字段不标 `internal`，与 `agent` 的 `apply`/`patch` 同类，会出现在 `agentPayload` 与生成的 `dext.d.ts` 里。
- 跨位置引用仍可解析：`uriForReference` 本来就不看当前设置，两个前缀都能改成 `vscode.Uri`，所以存到另一位置的计划仍能从历史记录打开、修订与 Build，不需要改 `planUri`。

考虑过的替代方案：

- 把 `save` 改成 `save: boolean | "global" | "workspace"`：一个参数同时表达两个正交决定，`save: false` 与位置的组合会被压进一个字面量联合，类型提示和校验都会变模糊。
- 命名 `saveTo` / `storage`：`location` 与要覆盖的 `dext.storage.location` 同名，调用方不需要在脑里做一次词汇映射；`storage` 又容易让人以为能改存储引擎。
- 给 `location` 设 `default: "global"`：会让所有现有调用方静默忽略 `dext.storage.location`，属于行为破坏；缺省必须等于“读设置”。
- 让调用方直接传目录或路径（如 `directory: "./plans"`）：相当于向代码 API 开一个目录选择入口，需要额外的越界校验、命名与冲突规则，与本变更“不新增第二套规则”相抵触。
- 把开关放进设置或环境变量：无法按调用区分，也就无法让同一份 Code 既存项目内计划又取一份绝对路径的副本。

### 代码 API 直接把整段文本视为计划文档

`runtime.execute` 的 `plan` 调用没有分隔符指令，模型返回的就是计划正文。代码 API 路径因此不做 `splitPlanResponse`，保存 `result.text.trim()` 加结尾换行，返回的 `text` 原样保留（调用方已依赖这段文本）。

考虑过的替代方案：在代码 API 的 plan 调用中追加 `PLAN_RESPONSE_FORMAT_INSTRUCTION` 再用 `splitPlanResponse`。这会改变代码 API 的可见文本，并把「计划正文」的可靠性押在模型是否遵守分隔符上，不是本次修复的目标。

### 路径形态按本次生效的存储位置区分

`global` 位置返回 `target.fsPath`（Windows 上形如 `C:\Users\<user>\AppData\Roaming\Code\User\globalStorage\blooddot.dext\plans\20261117-...-plan.md`）。`workspace` 位置保持相对的计划目录路径：默认 `.dext/plans/...`，配置了 `dext.planDirectory` 时以该目录开头（这一点与 UI 完全一致，因为两者用同一个 `[...segments, name].join("/")`）。选哪一个由本次生效的位置决定，而不是固定看当前设置。返回值仍是单个字符串字段，可 JSON 序列化，不需要新增字段或协议版本升级。

### 失败与前置条件照搬现有语义

写入函数在写入前完成全部校验并抛出既有错误（重名上限、修订哈希变化、路径越界）；写入抛错会向上冒泡为 `plan()` 调用失败，宿主在 `onRequest` 里转成 `error` 响应，因此不会产生「成功但没有文件」的结果。生效位置为 `workspace` 且工作区不受信任或没有工作区时，现有 `savePlan` 直接返回原响应；代码 API 同样只返回文本、不带 `planPath`，且不会退化成写 global（静默换位置比不保存更难排查）。

## Risks / Trade-offs

- [代码 API 的计划正文不是结构化计划文档] → 本次只负责落盘，不改变生成内容；后续如需统一文档结构，应作为独立变更调整 Plan 指令，并同步 UI 与代码 API。
- [`save: false` 的调用方需要自己把 `text` 写盘] → 文档与生成的声明都要写明 `planPath` 仅在保存时出现，否则容易把「没有 `planPath`」误读成保存失败。
- [新增公开参数要同步生成物] → 忘记跑 `npm run generate:dext-types -- --workspace .` 会让 `.dext/api/dext.d.ts` 与运行时契约漂移；`--check` 会拦住这种漂移。
- [同一 Code 运行并发调用 `plan()` 可能同名竞争] → 与 UI 既有 `stat`+`writeFile` 非原子的已知限制相同；共用同一实现，不扩大风险，也不在此次引入新的排他创建机制。
- [`global` storage 的绝对路径在 Windows 上使用反斜杠，跨平台调用方需按原生路径处理] → 规范要求「可被 `fs.stat`/`fs.readFile` 直接读取」，Node 在各自平台接受原生分隔符；不额外做斜杠归一化，避免返回一个与实际文件路径不一致的字符串。
- [显式 `location` 会让计划文件分散在两个目录] → UI 历史记录只存引用文本，`uriForReference` 两种前缀都能解析，所以打开、修订与 Build 不受影响；代价是用户可能在两个位置各有一批计划，文档需要在 `plan({ ... })` 签名旁说明默认跟随设置。
- [`location` 与 `save` 同时出现在 Provider 参数信封里] → 与 `agent` 的 `apply`/`patch` 同类，模型只会看到一个普通参数；计划文本的生成方式不受影响。若后续发现误导，可改为 `internal` 并同步 `CONVERSATION_METHODS` 注释。
- [重放缓存记录的是某台机器上的绝对路径] → replay 只用于同一宿主进程内的失败重试，路径在同一运行环境有效；计划文件不被清理，重放仍可读取。

## Migration Plan

- 无数据迁移：计划目录、命名与既有文件完全复用，历史记录中的 `planPath` 不改写。
- 行为兼容：`save` 默认 `true`，且 `location` 缺省时读设置，因此既有调用（包括 Bext）继续拿到 `planPath`；只有显式的 `save: false` 才会跳过写盘，只有显式 `location` 才会偏离设置，所以不存在需要同步修改的调用方。
- 回滚：还原 `kernelHost()` 的执行包装、`savePlan` 的抽取与 `DextStorage` 的可选位置参数即可；已保存的计划文件仍可被 UI 按原引用打开，不需要清理。

## Open Questions

- 无。参数名与默认值已定：`save: boolean`，默认 `true`；`location: "global" | "workspace"`，无默认值（缺省读 `dext.storage.location`）。若要改用 `savePlan`/`saveTo` 命名，只需改 `builtins.ts`、文档与生成声明，宿主的判据不变。
