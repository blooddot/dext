# Tasks

## 1. 会话 header 读取助手

- [x] 1.1 新增 `src/features/agents/host/piSessionHeader.ts`，导出 `piSessionCwd(path: string): Promise<string | undefined>`：用 `open` 加 64 KiB 缓冲只读到首个换行，解析 `JSON.parse` 后的字符串型 `cwd`；按 design 的容错表放行不可读、首行非 JSON、`cwd` 缺失/空/非字符串、超长首行的情形
  verify: npx tsc --noEmit
- [x] 1.2 新增 `test/piSessionHeader.test.ts`，用临时目录覆盖六条分支（正常 header、`cwd` 为文件、`cwd` 不存在、首行非 JSON、无 `cwd`、文件不可读），断言返回原值或 `undefined`
  verify: npx vitest run test/piSessionHeader.test.ts

## 2. 恢复路径的预检

- [x] 2.1 在 `PiAgentRunner.execute` 拿到 `resume` 之后、调用 `open` 之前使用 1.1 的助手：目录不存在或不是目录时直接抛错，文案说明工作区已移动或删除并给出下一步；不启动 Pi，不引入 `--fork`，不改 `PiRpcTransport`
  verify: npx tsc --noEmit
- [x] 2.2 在 `test/piAgentRunner.test.ts` 用现有 fixture 补断言：会话首行 `cwd` 指向已改名目录时该回合失败、fixture 日志不新增进程、文案含工作区提示；`cwd` 存在时恢复与现状一致；首行不可解析或缺 `cwd` 时仍走既有路径
  verify: npx vitest run test/piAgentRunner.test.ts

## 3. `set_model` 失败的可操作提示

- [x] 3.1 新增私有 `setModel` 方法承接 `set_model` 请求，`select` 与 `discover` 两处调用点改用它；失败时在 Pi 的原始原因后追加「模型可能已下架，请刷新模型目录」的提示，取消时原样透传，其它 RPC 命令的错误透传不动
  verify: npx tsc --noEmit
- [x] 3.2 在 `test/piAgentRunner.test.ts` 补断言：回合模型失效时文案含刷新提示；`discoverModels` 的模型失效同样含该提示；`set_model` 之外的命令失败时不追加该提示
  verify: npx vitest run test/piAgentRunner.test.ts

## 4. 固定 coercion 现状

- [x] 4.1 在 `test/piExtension.test.ts` 补最小断言：可选属性上的显式 `null` 不出现在转发给宿主的参数里、单值数组参数到达后按单元素数组原样转发，且结果契约与工具注册未被改写
  verify: npx vitest run test/piExtension.test.ts
- [x] 4.2 在 `docs/agents.md` 与 `docs/agents.zh-CN.md` 的 Pi 段落补一句说明：这两步规整由 Pi 的工具参数校验完成，Dext 不再补一次 `null` 归一化或数组包装
  verify: grep -n "coercion" docs/agents.md && grep -n "coercion" docs/agents.zh-CN.md

## 5. 文档收敛

- [x] 5.1 把两份 Pi 段落的版本基线从「Pi 1.4.0 或兼容的更新 CLI」改为「1.4.0 起，当前验证到 1.5.2」，并列三条升级注意：刷新模型目录（指向 Configure Agent）、工具参数 coercion、`cacheWarming` 默认 `"idle"` 的计费影响与在 Pi `settings.json` 中设为 `"off"` 的关闭方式
  verify: grep -n "1.5.2" docs/agents.md docs/agents.zh-CN.md && grep -n "cacheWarming" docs/agents.md docs/agents.zh-CN.md
- [x] 5.2 在两份 Pi 的会话恢复段落补一句：会话记录的工作区已移动或删除时，Dext 直接说明原因且不启动 Pi
  verify: grep -n "no longer exists" docs/agents.md && grep -n "已移动或删除" docs/agents.zh-CN.md

## 6. 集成验证

- [x] 6.1 跑完整的 Pi 测试与仓库检查，确认新增断言与既有 Pi 用例全部通过、类型与构建无回归
  verify: npm run check
- [x] 6.2 在 1.5.2 真机上复核 design 实测表的两条对照仍然成立（工作区丢失时 Pi 以 exit 1 退出且不自动继续、`cwd` 存在时正常响应），并各跑一次「重命名工作区后恢复会话」与「正常恢复」，把实际行为回填 design 的验证结论
  verify: pi --version

## Workflow follow-up

- 项目评审通过后归档该 change，并核对归档后的主 spec 内容。
