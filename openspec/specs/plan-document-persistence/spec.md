# plan-document-persistence Specification

## Purpose

规定 Plan 文档的保存契约：代码 API 的 `plan()` 用公开的 `save` 选项决定是否把计划写成文件（默认保存），用公开的 `location` 选项选择存到 global 计划目录还是项目计划目录（默认沿用设置），UI Plan 恒定保存且位置不变；代码 API 与 UI Plan 共用同一套落盘规则，返回的 `planPath` 必须指向调用方可直接读取的真实文件，并明确不同存储位置下的路径形态与失败语义。

## Requirements

### Requirement: plan() 用 save 选项决定是否保存计划文档

代码 API 的 `plan()` SHALL 接受公开布尔选项 `save`，默认值为 `true`。当 `save` 为 `true` 或未提供、且计划文本非空时，系统 SHALL 在把结果交给调用方之前把该文本保存为计划文件，并在返回的 `PlanResult` 中带上指向该文件的 `planPath`。当 `save` 为 `false` 时，系统 MUST NOT 写入计划文件，MUST NOT 返回 `planPath`，并 SHALL 原样返回计划文本，由调用方自行决定如何使用。计划文本为空或只有空白字符时，系统 MUST NOT 写入文件，也 MUST NOT 返回 `planPath`。`save` 只决定是否落盘，具体写到哪里由 `location` 或 `dext.storage.location` 设置决定。

#### Scenario: 默认保存

- **WHEN** 用户代码调用 `plan({ input: "..." })` 且 Agent 返回一份非空计划文本
- **THEN** 该调用的结果包含 `planPath`
- **AND** 调用方用 `fs.stat` 与 `fs.readFile` 读取该 `planPath` 成功，内容包含刚保存的计划正文

#### Scenario: 显式 save: true 与默认一致

- **WHEN** 用户代码调用 `plan({ input: "...", save: true })`
- **THEN** 计划文件被写入，结果中的 `planPath` 指向该文件
- **AND** 除参数表外，结果与不传 `save` 时相同

#### Scenario: save: false 不落盘

- **WHEN** 用户代码调用 `plan({ input: "...", save: false })` 且 Agent 返回非空计划文本
- **THEN** 不创建任何计划文件
- **AND** 结果中包含完整的计划 `text`，且没有 `planPath`
- **AND** 调用正常成功，不报错

#### Scenario: 空计划不落盘

- **WHEN** 计划文本是空字符串或只有空白字符
- **THEN** 不创建计划文件，结果中没有 `planPath`
- **AND** 调用按既有错误处理结束，不会出现指向不存在文件的路径

### Requirement: plan() 用 location 选项选择计划保存位置

代码 API 的 `plan()` SHALL 接受公开枚举选项 `location`，允许值为 `"global"` 与 `"workspace"`，取值与既有的 `dext.storage.location` 设置一致。当 `location` 为 `"global"` 时，系统 SHALL 把计划写入 global storage 的计划目录；当 `location` 为 `"workspace"` 时，系统 SHALL 把计划写入项目内的计划目录（`dext.planDirectory`，默认 `.dext/plans`）。当 `location` 未提供时，系统 SHALL 沿用 `dext.storage.location` 的当前取值，行为与改动前一致。该选项 MUST 只选择既有的两个存储位置，MUST NOT 引入新的计划目录、命名或冲突规则。

#### Scenario: 单次调用存到 global

- **WHEN** 配置为 `dext.storage.location = "workspace"`，用户代码调用 `plan({ input: "...", location: "global" })`
- **THEN** 计划文件写入 global storage 的计划目录
- **AND** 工作区计划目录中没有因为这次调用新增文件
- **AND** 返回结果的 `planPath` 指向 global storage 中的该文件

#### Scenario: 单次调用存到项目

- **WHEN** 配置为 `dext.storage.location = "global"`，用户代码调用 `plan({ input: "...", location: "workspace" })`
- **THEN** 计划文件写入项目计划目录（`dext.planDirectory`，默认 `.dext/plans`）
- **AND** global 计划目录中没有因为这次调用新增文件
- **AND** 返回结果的 `planPath` 指向该项目内文件

#### Scenario: 不提供 location 时沿用设置

- **WHEN** 用户代码调用 `plan({ input: "..." })` 且没有传 `location`
- **THEN** 保存位置与 `dext.storage.location` 的当前取值相同
- **AND** 结果与改动前在同配置下保存的结果一致

### Requirement: location 只作用于当次保存

`location` 的影响范围 SHALL 限于当次保存：MUST NOT 改写 `dext.storage.location` 或 `dext.planDirectory` 设置，MUST NOT 影响后续没有传该选项的调用。`save` 为 `false` 或计划文本为空时该选项不生效，MUST NOT 因此报错。修订既有计划时该选项 MUST NOT 生效：修订 SHALL 写回被修订的计划文件本身。

#### Scenario: 设置保持不变

- **WHEN** 用户代码以显式 `location` 调用 `plan()`
- **THEN** `dext.storage.location` 与 `dext.planDirectory` 的取值保持不变
- **AND** 后续没有传 `location` 的调用仍按设置保存

#### Scenario: save: false 时 location 不生效

- **WHEN** 用户代码调用 `plan({ input: "...", save: false, location: "global" })`
- **THEN** 任何计划目录都不新增文件，结果中没有 `planPath`
- **AND** 该调用正常成功，不报错

#### Scenario: 修订不受 location 影响

- **WHEN** 用户在 UI 中修订一份已保存的计划，且该计划位于与当前设置或显式 `location` 不同的位置
- **THEN** 修订写回被修订的计划文件本身，不新建另一个位置的文件
- **AND** 结果中的 `planPath` 仍指向该计划的原引用

### Requirement: save 与 location 属于 plan() 的公开 API 契约

`save` 与 `location` SHALL 声明在 `plan` 方法的输入契约中（`builtins.ts`），使 Kernel 的严格参数校验接受这两个参数，并让生成的 `.dext/api/dext.d.ts` 选项、API 参考签名与工作流文档的 `plan({ ... })` 签名都出现它们。`save` MUST 是布尔值，`location` MUST 是 `"global"` 或 `"workspace"` 之一；类型不符 MUST 按既有参数校验失败处理。这两个选项 MUST NOT 改变由 Provider 返回的结果形状。

#### Scenario: 生成的类型声明包含 save 与 location

- **WHEN** 重新生成 `.dext/api/dext.d.ts`
- **THEN** `plan` 的选项类型包含 `save?: boolean` 与 `location?: "global" | "workspace"`
- **AND** `npm run generate:dext-types -- --workspace . --check` 通过

#### Scenario: 非布尔 save 被既有校验拒绝

- **WHEN** 用户代码调用 `plan({ input: "...", save: "no" })`
- **THEN** 调用按现有参数校验失败，不执行计划生成
- **AND** 不会写入计划文件

#### Scenario: 非法 location 被既有校验拒绝

- **WHEN** 用户代码调用 `plan({ input: "...", location: "project" })`
- **THEN** 调用按现有参数校验失败，不执行计划生成
- **AND** 不会写入计划文件

#### Scenario: Kernel 接受已声明的 save 与 location

- **WHEN** Code 运行从 Kernel 发起 `plan({ input: "...", save: false, location: "workspace" })` 请求
- **THEN** 宿主收到包含 `save` 与 `location` 的 `invocation.arguments`
- **AND** 该次调用没有被当作未知参数拒绝

### Requirement: 代码 API 返回的 planPath 可直接读取

当计划被保存时，代码 API 返回的 `planPath` SHALL 是调用方可直接读取的路径，其形态由本次保存实际使用的位置决定。`global` 位置下该值 MUST 是绝对文件路径；`workspace` 位置下 SHALL 保持既有的计划目录相对路径形式（默认以 `.dext/plans/` 开头，配置了 `dext.planDirectory` 时以该目录开头）。该字段 MUST NOT 只返回 `.dext-global/...` 这类需要 Dext 内部解析的引用。

#### Scenario: global 位置返回绝对路径

- **WHEN** 计划保存到 global 位置（由设置或显式 `location: "global"` 决定）
- **THEN** 返回的 `planPath` 是绝对路径，指向实际写入的计划文件
- **AND** 外部 Node 进程无需了解 `.dext-global` 约定即可用 `fs.stat` 与 `fs.readFile` 读取它

#### Scenario: workspace 位置保持原样

- **WHEN** 计划保存到项目计划目录（由设置或显式 `location: "workspace"` 决定）
- **THEN** 返回的 `planPath` 仍是以计划目录开头的相对路径（默认 `.dext/plans/`）
- **AND** 该路径与 UI Plan 在同一配置下生成的路径形式一致

### Requirement: 代码 API 与 UI Plan 共用保存规则

代码 API 与 UI Plan SHALL 使用同一套计划保存规则：同一存储位置下的计划目录、文件命名、重名冲突处理与写入内容完全一致。代码 API 的保存 MUST NOT 引入第二套目录、命名或冲突检测规则；`save` 只决定是否执行保存，`location` 只在既有两个存储位置之间选择，两者都 MUST NOT 改变这些规则。

#### Scenario: 同一目录与命名形式

- **WHEN** 在相同存储位置与相同目标文本下分别由 UI Plan 和 `plan({ save: true })` 保存计划
- **THEN** 两个文件位于同一个计划目录
- **AND** 文件名都沿用既有的 `时间戳-目标 slug-序号.plan.md` 形式

#### Scenario: 跨位置调用沿用同一命名规则

- **WHEN** 同一次运行先用 `location: "global"`、再用 `location: "workspace"` 保存计划
- **THEN** 两个目录各自按既有命名规则生成文件名
- **AND** 不存在只对代码 API 生效的文件名或目录差异

#### Scenario: 重名冲突沿用既有处理

- **WHEN** 同一秒内两次代码 API 保存使用相同目标文本并保存到同一位置
- **THEN** 第二个文件按既有规则获得递增序号，不会覆盖第一个文件
- **AND** 两次返回的 `planPath` 指向各自实际写入的文件

### Requirement: planPath 跨 Kernel 边界与重放保持可用

`planPath` SHALL 是普通 JSON 字符串，并在结果跨越 Kernel 与 Extension Host 边界之前写入结果。`location` 与 `save` 作为普通参数进入 `invocation.arguments`，MUST NOT 需要新增协议字段。被记录或缓存的结果 MUST 保留 `planPath`；重放该调用时 SHALL 返回已保存文件的同一个 `planPath`，且 MUST NOT 因重放而在任一位置重复写入计划文件。`save: false` 的调用同样被完整记录，其重放结果 MUST 仍然不含 `planPath`，也不会写入文件。

#### Scenario: 跨边界后仍包含 planPath

- **WHEN** 代码 API 的 `plan({ save: true, location: "global" })` 结果经由 Kernel 返回 Extension Host
- **THEN** 返回的执行结果中仍包含 `planPath`
- **AND** 该值可直接用于后续 `fs.stat` 或 `fs.readFile`

#### Scenario: 重放保留已保存路径

- **WHEN** 一次失败的 Code 运行被重试，重放命中此前的 `plan()` 调用
- **THEN** 重放结果包含与首次运行相同的 `planPath`
- **AND** global 与项目计划目录中都不会因此多出第二个计划文件

#### Scenario: 重放不改变 save 与 location 的语义

- **WHEN** 首次运行以 `save: false` 或显式 `location` 调用了 `plan()`，重试时重放该调用
- **THEN** 重放结果中的 `planPath` 与首次运行完全一致（`save: false` 时仍然没有该字段）
- **AND** 不会因为重放而改变保存位置或新增文件

### Requirement: 代码 API 保存不改变 UI Plan 行为

UI Plan 的保存结果与路径引用 SHALL 保持不变。UI Plan 没有 `save` 也没有 `location` 入口，MUST NOT 被这两个选项影响；保存后的 `planPath` 仍是 UI 可解析的引用，计划修订、Build、历史记录与打开计划 MUST 继续按原引用工作，不需要迁移既有计划文件。UI 与 `planUri` SHALL 继续能解析两个位置下的既有引用，因此代码 API 显式存到另一位置的计划也能从历史记录打开。

#### Scenario: UI Plan 仍按原路径保存

- **WHEN** 用户在 UI 的 Plan 模式完成一次计划生成
- **THEN** 结果中的 `planPath` 与改动前形式相同（`global` 设置为 `.dext-global/plans/...`，`workspace` 设置为 `.dext/plans/...`）
- **AND** 打开计划、修订计划与 Build 仍能通过该引用找到并读取文件

#### Scenario: UI 回合不受 save 与 location 影响

- **WHEN** 一个 Plan 回合由 UI 发起（该路径不传 `save` 或 `location`）
- **THEN** 计划文件照常按设置写入，结果照常带 `planPath`
- **AND** 不存在让 UI Plan 跳过保存或改变位置的入口

#### Scenario: 另一位置的计划仍可打开

- **WHEN** 一份计划由代码 API 以显式 `location` 保存在与当前设置不同的位置，之后用户在历史记录中打开它
- **THEN** `planUri` 按引用中的位置前缀解析出该文件并成功打开
- **AND** 不需要用户改设置或迁移文件

#### Scenario: 历史记录与 revision 不受影响

- **WHEN** 用户对既有计划发起修订，并查看历史记录或重新打开该计划
- **THEN** 修订仍写入文件路径不变，历史记录中保存的计划引用保持原样

### Requirement: 保存失败时不返回虚假路径

当计划保存失败、工作区不受信任或路径非法时，系统 SHALL 沿用现有错误处理：写入失败 MUST 让该次调用失败，其余情况 MUST NOT 返回 `planPath`，且任何返回的 `planPath` MUST 对应真实存在的文件。有效位置为 `workspace` 且工作区不受信任或没有工作区时，MUST NOT 写入计划文件，也 MUST NOT 返回 `planPath`。`save: false` 是调用方的显式选择，不属于保存失败，因此 MUST NOT 因此报错。

#### Scenario: 写入失败让调用失败

- **WHEN** 计划文件写入抛出错误（例如目录不可写）
- **THEN** 该次 `plan()` 调用失败，错误按现有方式上报
- **AND** 调用方不会收到任何 `planPath`

#### Scenario: 工作区不受信任时不伪造路径

- **WHEN** 工作区不受信任，且有效位置为 `workspace`（来自设置或显式 `location: "workspace"`）
- **THEN** 沿用现有行为不写入计划文件
- **AND** 返回结果中不包含 `planPath`

#### Scenario: 显式 workspace 位置但没有打开工作区

- **WHEN** 调用方传 `location: "workspace"`，但没有可用的工作区目录
- **THEN** 沿用现有行为不写入计划文件，也不写入 global 位置
- **AND** 返回结果中不包含 `planPath`

#### Scenario: 非法路径沿用既有校验

- **WHEN** 计划目标路径包含越出工作区的片段
- **THEN** 已有的路径校验错误继续生效
- **AND** 不会写入工作区之外的文件，也不会返回该路径

#### Scenario: save: false 不报错也不造路径

- **WHEN** 调用方显式传 `save: false`
- **THEN** 没有文件写入，也没有 `planPath`
- **AND** 该调用不被当作保存失败
