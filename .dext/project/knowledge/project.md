## Responsibility

Dext 是一个 Visual Studio Code 扩展，拥有以对话和类型化工作流完成工程任务的整套产品职责：**Ask**（只读问答）、**Agent**（改代码并跑检查）、**Plan**（生成与修订实施计划，再由 Build 执行）、**Code**（把 API 调用组合成 TypeScript 工作流）。围绕这四种回合，它还拥有会话历史与复用、Agent 后端与权限选择、Project 长期知识、APIs / Skills / Global Resources 资源页、MCP 工具接入，以及以编辑器标签页承载的 Project、APIs、Global Resources、History 页面。

它不拥有模型凭证，也不拥有 Agent 运行时本身：推理与工具执行由用户已安装并已登录的 CLI 提供，Dext 只按该 CLI 的接口驱动回合、读取事件并把结果呈现给用户。

## Design

- **CLI 即后端边界**。Codex CLI、Claude CLI、DeepSeek Harness 与 Pi CLI 默认都出现在 Agent 列表中；`dext.agentCli` 决定可见后端，`Dext: Configure Agent` 只关联可执行文件路径。Dext 不安装、不修复 CLI，沿用其已有凭证。
- **Code 模式不是新语言**。一个 Code 回合就是一段普通 ES module，作为 TypeScript 运行在长驻 Node 子进程中；Node 内置模块与工作区可解析的包直接可用，顶层 `await` 可用，类型检查与补全来自 VS Code 自身的 TypeScript 服务。项目 API 保存在 `.dext/api/`，入口函数名与文件名一致，生成的 `dext.d.ts`、`tsconfig.json`、`package.json` 使未安装 Dext 的协作者与 CI 也能类型检查。
- **Plan 完成需要证据**。每轮响应后检查上报的任务进度并继续未完成且可执行的工作；全部任务上报完成后，另起一轮独立最终校验才显示 `Completed`。取消显示 `Stopped`，覆盖全部剩余任务的显式外部阻塞显示 `Blocked`；连续三轮没有新完成任务或新工具活动、或达到 64 轮上限，则以 `Incomplete` 停止并保留计划。普通 Agent 返回不再隐含完成。
- **两种存储刻意分离**。Project 只保留长期内容（Overview、Knowledge、Diagrams），绝不出现 Hook 日志、任务清单或单次运行记录；回合记录留在会话历史中。
- **生成即草稿**。Project 与知识内容由生成产生时是 draft，只有人工审阅确认后才成为已接受内容；正文以 Markdown 文件与哈希引用，不复制进存储。

## Boundary

- Allowed: 启动并驱动用户已安装的 Agent CLI 可执行文件；在工作区 `.dext/` 下读写 Project、项目 API 与运行产物；通过 VS Code API 提供侧边栏、编辑器标签页、视图与命令。
- Forbidden: 不安装、修复或替换 Agent CLI，不代管其凭证与登录状态；不把单次运行记录、Hook 日志或任务清单写入 Project 长期存储；不引入 Python 解释器或独立于 TypeScript 的工作流语言；不在未受信任的工作区中执行项目 API；不把生成内容当作已确认规范。