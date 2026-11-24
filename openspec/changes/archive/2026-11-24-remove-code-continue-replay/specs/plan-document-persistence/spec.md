# Spec Delta

## ADDED Requirements

### Requirement: planPath 跨 Kernel 边界保持可用

`planPath` SHALL 是普通 JSON 字符串，并在 Extension Host 将 `plan()` 的调用结果交给 Kernel 之前写入结果。收到该响应的脚本和包含该响应的执行结果 SHALL 保留此字段。`location` 与 `save` 作为普通参数进入 `invocation.arguments`，MUST NOT 需要新增协议字段。

#### Scenario: 跨边界后仍包含 planPath

- **WHEN** Extension Host 处理 Code 脚本发起的 `plan({ save: true, location: "global" })` 并保存非空计划
- **THEN** 脚本收到的对象及返回 Extension Host 的执行结果中均保留指向本次实际保存文件的 `planPath`
- **AND** 调用方可用该值执行 `fs.stat` 或 `fs.readFile`

#### Scenario: 不保存时跨边界保留计划正文

- **WHEN** Code 脚本传入 `save: false` 和显式 `location`，且 Agent 返回非空计划
- **THEN** Extension Host 收到原参数，两个计划目录均无本次调用新增的文件
- **AND** 脚本收到完整计划正文，响应不含 `planPath`

## REMOVED Requirements

### Requirement: planPath 跨 Kernel 边界与重放保持可用

**Reason**: Code Continue 及其调用回放已移除。用户确认重新执行后，`plan()` 按当次调用应用既有保存规则。

**Migration**: 使用「重新执行」后，从新调用读取返回值。跨边界行为由「planPath 跨 Kernel 边界保持可用」承接。
