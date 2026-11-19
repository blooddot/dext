# Proposal

## Why

UI Plan 模式通过 `DextApplication.executeConversation` → `savePlan` 把 Plan 文档落盘并返回 `planPath`，但代码 API 的 `plan()` 走 `DextApplication.kernelHost` → `DextKernelHost` → `DextRuntime.execute`，只返回计划文本，不执行保存。调用方（如 Bext 的 `dev.refactor`）因此只能拿到「Dext Plan 未返回 planPath；原始 Plan 文本：…」，无法把计划文件交给后续步骤读取。

同时，`plan()` 没有任何参数可以让调用方选择要不要文件：写盘应当是调用方的决定，而不是每个 `plan()` 调用的固定副作用。

计划写到哪个目录同样只能由 `dext.storage.location` 设置决定。代码 API 的调用方既无法在单次调用里选择 `global` 还是项目内的计划目录（`dext.planDirectory`，默认 `.dext/plans`），也不应该为了一个文件的存放位置去改用户的全局设置。

## What Changes

- 在代码 API 的 `plan()` 上暴露公开布尔选项 `save`（默认 `true`），由调用方决定是否把计划写成文件。
- `save` 为 `true` 或不提供时，在返回前保存非空计划文本并返回 `planPath`；`save: false` 时只返回计划文本，不写文件，也不返回 `planPath`。
- 在代码 API 的 `plan()` 上暴露公开枚举选项 `location: "global" | "workspace"`（可选，取值与 `dext.storage.location` 相同），让调用方在单次调用里选择把计划存到 global 计划目录还是项目计划目录；不提供时沿用设置。它只选择已有的两个存储位置，不改写设置、不新增目录或命名规则，`save: false` 时不生效。
- 保存复用 UI Plan 已有的 `savePlan` 命名、目录、冲突检测与存储位置规则，不引入第二套实现。
- 在 `builtins.ts` 的 `plan` 输入契约中声明 `save`（与 `agent` 的 `apply`/`patch` 同类），使 Kernel 的严格参数校验接受该调用，并让生成的 `.dext/api/dext.d.ts`、API 参考签名与 `docs/workflows*.md` 同步出现这个选项。
- 在代码 API 的 `PlanResult` 中返回可直接读取的 `planPath`（仅在保存时出现）：`global` storage 下为绝对文件路径，`workspace` storage 下保持现有的 `.dext/plans/...` 相对路径行为。
- 把保存动作放在 Kernel 调用的宿主侧执行路径上，使响应在跨越 Kernel 与 Extension Host 的 JSON 边界前就已带上 `planPath`，重放记录与缓存结果同样携带该字段。
- UI Plan 的保存结果、路径引用、计划修订、Build、历史记录与打开计划行为保持不变。
- 空计划、保存失败、工作区不受信任和非法路径沿用现有错误处理，不返回指向不存在文件的 `planPath`。

## Capabilities

### New Capabilities
- `plan-document-persistence`: 规定 Plan 文档的保存契约：代码 API 的 `plan()` 用公开的 `save` 选项决定是否落盘（默认保存）而 UI Plan 恒定保存，两者共用同一套落盘规则，代码 API 返回的 `planPath` 必须是调用方可直接读取的真实文件路径，并说明不同 storage 位置下的路径形态与失败语义。

### Modified Capabilities

## Impact

- `src/app/application.ts`：抽出 `savePlan` 中负责写入与命名/冲突/存储判断的部分，供 UI 与代码 API 共用；在 Kernel 调用的执行包装中按 `save` 选项决定是否保存，并在保存后为 `plan` 结果补上 `planPath`。
- `src/features/workflow/domain/builtins.ts`：`plan` 输入新增 `save` 布尔字段（默认 `true`）与 `location` 枚举字段（`global`/`workspace`，无默认值），这是仅有的两个新增对外参数。
- `src/platform/vscode/dextStorage.ts`：`directory()` 与 `reference()` 增加可选的位置参数（缺省仍读 `dext.storage.location`），使目录与引用规则继续只有一处定义；`uriForReference` 不变，因此 UI 与 `planUri` 仍能解析另一个位置下的既有计划引用。
- `.dext/api/dext.d.ts`：由 `npm run generate:dext-types -- --workspace .` 重新生成，使 TypeScript 提示与运行时契约一致。
- `src/shared/contracts/types.ts`、`src/features/workflow/domain/builtinTypeDefinitions.ts`、`docs/workflows.md`、`docs/workflows.zh-CN.md`：`PlanResult.planPath` 与 `plan({ save })` 的语义补充（结果字段本身已存在，无需新增结果类型）。
- `src/runner/dextHost.ts` 与 `src/runner/dextRuntime.mjs`：无需修改协议形状，`save` 随普通参数进入 `invocation.arguments`，保存发生在宿主执行回调内，`planPath` 以普通 JSON 字符串跨边界。
- 测试：新增/扩展聚焦回归测试，覆盖 `save` 的三种取值、代码 API 保存与可读取路径、workspace storage 路径不变、UI 保存不变、Kernel 边界与重放、保存失败不返回虚假路径。
- 不修改调用方 Bext，不调整 storage 位置配置、计划目录配置或计划文件命名规则。
