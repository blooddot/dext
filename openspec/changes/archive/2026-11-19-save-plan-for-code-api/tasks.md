# Tasks

## 1. 抽出共用计划写入实现

- [x] 1.1 给 `src/platform/vscode/dextStorage.ts` 的 `directory()` 与 `reference()` 增加可选位置参数（缺省仍读 `dext.storage.location`，签名保持兼容），`uriForReference` 不变；目录与引用规则仍只有这一处定义。verify: `npm run typecheck`
- [x] 1.2 从 `src/app/application.ts` 的 `savePlan` 中抽出私有写入方法，入参为计划文档文本与本次生效位置，保留现有目录选择、`planFileName` 命名、重名跳过、修订哈希校验与写入内容（文档加结尾换行），返回存储引用与 `vscode.Uri.fsPath` 两个值；`savePlan` 传入 `this.storage.location()` 并改用返回值中的存储引用，UI 行为保持不变。写入方法不判断 `save`，是否保存由调用方决定。verify: `npm run typecheck`
- [x] 1.3 为共用写入实现补充回归测试，覆盖 `global` 与 `workspace` 两种位置下的目录、命名形式、相对引用与绝对路径、位置参数与设置不一致时的行为，以及重名递增与修订哈希失败；`workspace` 位置路径断言与改动前一致。verify: `npx vitest run test/planFile.test.ts test/planSaveWrite.test.ts`
- [x] 1.4 运行 UI Plan 相关既有测试，确认 `savePlan` 拆分后 UI 结果仍为 `text: plan.conversation` 与原有 `planPath` 引用。verify: `npx vitest run test/sidebarLayout.test.ts test/planComposerLifecycle.test.ts test/planTodoExecution.test.ts`

## 2. 把 save 与 location 加进 plan() 契约

- [x] 2.1 在 `src/features/workflow/domain/builtins.ts` 的 `plan` 输入里新增 `save`：`type: "boolean"`、`default: true`、不标 `internal`，描述写明「默认保存计划文件并返回 planPath；false 时只返回文本」。verify: `npm run typecheck`
- [x] 2.2 同一处新增 `location`：`type: "enum"`、`values: ["global", "workspace"]`、无 `default`、不标 `internal`，描述写明「默认跟随 `dext.storage.location`；只影响这次调用，不改设置」。verify: `npm run typecheck`
- [x] 2.3 重新生成工作区声明并确认包含 `save?: boolean` 与 `location?: "global" | "workspace"`；把 `src/shared/contracts/types.ts` 中 `PlanResult.planPath` 的注释从「仅 Plan 模式设置」改为「保存时由宿主设置，形态由本次保存位置决定：`global` 为绝对路径、`workspace` 为计划目录相对路径」，必要时同步 `builtinTypeDefinitions.ts` 的 `PlanResult` 描述。verify: `npm run generate:dext-types -- --workspace . && npm run generate:dext-types -- --workspace . --check`
- [x] 2.4 在 `src/app/application.ts` 的 `kernelHost()` 中把传给 `DextKernelHost` 的 `execute` 回调改为私有包装：先执行 `runtime.execute`，当 `invocation.method === "plan"`、`invocation.arguments` 中的 `save` 不是显式 `false`、且结果是非空计划文本时，按 `invocation.arguments.location ?? this.storage.location()` 解析生效位置并调用共用写入实现，把 `planPath` 写入返回副本并保留原 `text`；其余调用结果原样返回。`save` 缺席按 `true` 处理。verify: `npm run typecheck`
- [x] 2.5 代码 API 保存路径按生效位置区分形态：`global` 返回写入目标的绝对 `fsPath`，`workspace` 返回既有计划目录相对路径；空文本、写入函数返回 `undefined`、生效位置为 `workspace` 且工作区不受信任／不存在时不附加 `planPath`（不回退到 `global`）；`save: false` 时既不写盘也不使用 `location`。verify: `npx vitest run test/planCodeApiSave.test.ts`
- [x] 2.6 新增聚焦测试，覆盖代码 API `plan()` 默认与 `save: true` 写入文件并返回 `planPath`、`save: false` 不写文件且无 `planPath`（调用仍成功）、`global` 位置的 `planPath` 可被 `fs.stat`/`fs.readFile` 读取、`workspace` 位置路径不变，以及保存失败（写入抛错）时调用失败且不返回路径。verify: `npx vitest run test/planCodeApiSave.test.ts`
- [x] 2.7 新增位置选择测试：设置为 `workspace` 时 `location: "global"` 只写 global 位置并返回绝对路径、设置为 `global` 时 `location: "workspace"` 只写项目计划目录并返回相对路径、不传 `location` 时与设置一致、显式 `location` 之后设置值未变且后续调用仍跟随设置、`location: "workspace"` 且工作区不受信任时不写文件也不返回 `planPath`。verify: `npx vitest run test/planCodeApiSave.test.ts`
- [x] 2.8 补充参数契约测试：未声明参数仍被严格校验拒绝，`save` 与 `location` 作为已声明参数被接受，非布尔 `save` 与非法 `location`（如 `"project"`）按既有参数校验失败且不产生计划文件。verify: `npx vitest run test/planCodeApiSave.test.ts test/apiFlow.test.ts`

## 3. Kernel 边界与重放

- [x] 3.1 为代码 API 的保存接入补充边界测试：`DextKernelHost` 返回的 `executions`/`steps` 中 `plan` 结果在 `toBoundaryJson` 之后仍包含 `planPath`，且该值可直接读取；`save` 与 `location` 作为普通参数出现在 `invocation.arguments`，未引入新的协议字段。verify: `npx vitest run test/dextHost.test.ts test/planCodeApiSave.test.ts`
- [x] 3.2 补充重放测试：命中此前 `plan()` 调用的重放结果保留同一 `planPath`，且 global 与项目计划目录都不新增第二个文件；`save: false` 的重放结果仍无 `planPath` 且不写文件；显式 `location` 的调用重放后位置不变。verify: `npx vitest run test/dextResume.test.ts test/planCodeApiSave.test.ts`
- [x] 3.3 确认跨位置引用可解析：为 `planUri`/`uriForReference` 补充测试，验证当前设置为 `workspace` 时仍能打开 `.dext-global/plans/...` 引用，设置为 `global` 时仍能打开 `.dext/plans/...` 引用（含自定义 `dext.planDirectory`）。verify: `npx vitest run test/planFilePath.test.ts test/planFile.test.ts`

## 4. 文档与最终验证

- [x] 4.1 更新 `docs/workflows.md` 与 `docs/workflows.zh-CN.md` 中 `plan()` 与 `PlanResult` 的说明：签名写为 `plan({ input, save=true, location?, ... })`，写明 `save: false` 只返回文本、不返回 `planPath`，`location` 缺省跟随 `dext.storage.location` 且只影响当次调用，`planPath` 在 `global` 位置下是绝对路径、`workspace` 位置下保持计划目录相对路径，保存失败不返回路径。verify: `git diff --check`
- [x] 4.2 运行类型检查与聚焦测试套件，确认 Plan 保存、`save`/`location` 选项与 Kernel 调用相关测试全部通过。verify: `npm run typecheck && npx vitest run test/planCodeApiSave.test.ts test/planSaveWrite.test.ts test/dextHost.test.ts test/dextResume.test.ts`
- [x] 4.3 运行空白检查并确认没有无关改动。verify: `git diff --check`

## Workflow follow-up

- 实现完成、评审通过后归档本变更：`openspec archive "save-plan-for-code-api"`。
- 归档后确认 `openspec/specs/plan-document-persistence/spec.md` 已生成且 `openspec validate --strict` 通过。
