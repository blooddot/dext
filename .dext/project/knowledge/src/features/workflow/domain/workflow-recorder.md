## Responsibility

- **Names**: Record Conversation as Dext Workflow → `recordWorkflow`（`src/features/workflow/domain/workflowRecorder.ts`，模块名 `workflowRecorder`，同文件导出 `recordedApiName`）；界面上的名字是命令 `dext.history.recordWorkflow`，代码名仍以 `recordWorkflow` 为准。
- 它只做一件事：把一次对话的历史轮次（`RecordedTurn`）折算成一份可编辑的 TypeScript API 骨架（`RecordedWorkflow`：`fileName`、`apiId`、`source`），并把这个骨架建议放在 `.dext/api` 下。它既不查询历史，也不写盘、不注册 API。
- 之所以只有这一层，是因为“从对话生成工作流”唯一需要判断的东西就是文本映射：哪一轮算一步、用什么方法、返回什么类型、哪些字符串其实是参数。把这些判断收在一处，宿主（`src/extension.ts` 的 `recordConversation`）才能只负责落盘、重载与打开文件。

## Design

- **输入被刻意收窄**：`RecordedTurn` 只有 `input`、`mode`、`response`、`error` 四个字段，注释写明“刚好够记录一轮”，因此本模块不需要 `Memento`、不需要历史存储，测试可以直接构造轮次。
- **失败轮次直接消失，而不是被猜着补全**：`recordWorkflow` 先过滤空输入与 `error`，若一轮都不剩就抛 `This conversation has no successful turn to record.`；剩下的轮次按原顺序一一变成 `step_N`，绝不合并或重排。
- **名字是纯函数且必须能当标识符**：`recordedApiName` 取第一条长度 ≥ `MIN_TITLE_LENGTH`（3）的输入，小写化、去掉 `@path` 引用、非字母数字折成 `_`、截断 40 字符，再剥掉开头的数字与下划线，全不可用则回退 `recorded_workflow`；重名时的编号后缀由宿主追加，本模块不处理冲突。
- **复用即参数化**：出现在两轮及以上的同一段输入才被提升为 `main()` 参数（`prompt`、`prompt_2`…），只出现一次的输入保留为字面量——参数化一次性输入等于凭空发明一个对话从未变化过的入参。
- **确认变成闸门**：`ui.confirm` 调用被还原为 `gate_N_M` 变量加一行注释，而不用 `if` 包住后续步骤，因为骨架的用途是可编译的起点，猜测“No 该跳过哪些步骤”反而会写错。
- **Code 模式轮次只注释、不重写**：那一轮本来就是 TypeScript，再包一层 `agent()` 会改变它的行为，所以原文逐行加 `//` 保留给作者粘贴。
- **返回类型跟随真实结果**：`returnType` 取最后一轮结果 `kind` 经 `RESULT_TYPES` 映射出的 `*Result`，缺失时按方法回落 `AgentResult`/`AskResult`；若全部轮次都是 Code 模式则没有可返回的值，改为 `Promise<void>` 与一句 `console.log` 提示。
- **语法上必须可擦除**：生成的 `import` 只引入实际用过的方法（初始含 `ask`、`ui`）与 result 类型（`type AskResult` 这类，因为结果接口由 `dext` 模块导出而非全局），`test/workflowRecorder.test.ts` 用 `stripTypeScriptTypes` 验证骨架能被 runner 的擦除通道接受——擦不掉的骨架比没有骨架更糟。

## Boundary

- Allowed: 唯一导入是 `src/shared/contracts/types.ts` 的 `DextResult`、`InputExecutionResponse` 类型；输出字符串由宿主 `src/extension.ts` 的 `recordConversation` 写入 `.dext/api`；被 `dext.history.recordWorkflow` 命令与测试直接调用。
- Allowed: 生成注释里带有记录日期与“编辑后再保存”的提示，属于骨架文本的一部分。
- Forbidden: 读写文件系统或工作区、创建 `.dext/api` 目录、检测重名、调用 `application.reload()` 或打开编辑器（都在宿主侧）；读取 `vscode`、Node 内置模块或任何存储/偏好实现；查询或改写历史、Plan、Project 数据；执行生成的代码或校验其运行结果（只保证可擦除）；把它写成第二套工作流语言——骨架里只允许出现 `dext` 模块已有的方法与结果类型。