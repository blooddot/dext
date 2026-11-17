# pi-result-submission Specification

## Purpose

定义 Pi 扩展中 `dext_submit_result` 的提交语义与注册声明：提交被接受即结束回合，未被接受则让模型在同一回合继续修正，注册时声明 provider 侧的约束采样，并记录 Pi 的批量终止语义与 strict schema 改写的已知边界。

## Requirements

### Requirement: 提交被接受即结束回合
当 `dext_submit_result` 的提交被宿主接受时，扩展 SHALL 返回带 `terminate: true` 的工具结果，使该回合在当前工具批次结束后直接结束。

#### Scenario: accepted 的提交结束回合
- **WHEN** 模型调用 `dext_submit_result`，宿主回复的 `status` 为 `accepted`
- **THEN** 该次 `execute` 返回的工具结果带 `terminate: true`
- **AND** Pi 不再为本回合发起下一轮模型请求

### Requirement: 未接受的提交不结束回合
当提交未被接受时，扩展 SHALL 返回与改动前一致的、不带 `terminate` 的工具结果，使模型能在同一回合读到诊断并重新提交。

#### Scenario: rejected 的提交继续同轮修正
- **WHEN** 宿主回复的 `status` 为 `rejected` 并带有契约诊断
- **THEN** 该次 `execute` 返回的工具结果不带 `terminate`，且 `isError` 为 `true`
- **AND** 模型可以在同一回合重新提交一个通过校验的结果

#### Scenario: unavailable 与 cancelled 不带 terminate
- **WHEN** 宿主回复的 `status` 为 `unavailable`，或调用因取消返回 `cancelled`
- **THEN** 该次 `execute` 返回的工具结果不带 `terminate`

### Requirement: 提前终止遵循 Pi 的整批语义
`terminate` 只在同一工具批次里所有最终工具结果都为终止时生效，扩展 MUST NOT 让本工具的 `terminate` 覆盖同批其它工具的结果。

#### Scenario: 同批并行调用其它工具
- **WHEN** 模型在一条 assistant 消息里同时调用 `dext_submit_result` 和另一个工具，且后者最终的 `execute` 结果不带 `terminate`
- **THEN** Pi 在该批次结束后仍继续本回合
- **AND** 这是 Pi 的批量终止语义，不视为扩展缺陷

### Requirement: 注册项声明 JSON-schema 约束采样
注册 `dext_submit_result` 时扩展 SHALL 声明 `constrainedSampling: { type: "json_schema", strict: "prefer" }`，并 MUST NOT 使用 `"require"`。

#### Scenario: 注册声明使用 prefer
- **WHEN** 一次 Pi 回合带有结果契约并注册 `dext_submit_result`
- **THEN** 该注册项的 `constrainedSampling` 为 `{ type: "json_schema", strict: "prefer" }`
- **AND** 该值显式不等于 `"require"`

#### Scenario: strict 子集不满足时回退
- **WHEN** 结果契约的根 schema 是 `oneOf`，或包含 strict 子集不接受的 `$ref`、`$defs`、`oneOf`、对象联合等关键字
- **THEN** Pi 回退到普通 schema 发送，回合仍可正常提交
- **AND** 不因约束采样失败而抛出错误

#### Scenario: provider 不支持 strict
- **WHEN** 当前 provider 不支持 strict 模式的 JSON schema 工具
- **THEN** 请求按普通 schema 发送，提交与校验行为与未声明该字段时一致
- **AND** 不因 `"prefer"` 抛出「requires JSON-schema constrained sampling」

### Requirement: strict 改写不改变本地校验依据
约束采样只影响发给 provider 的 schema；扩展 SHALL 继续用原始 `config.resultSchema` 注册工具参数并作为本地校验依据，MUST NOT 为了迎合 strict 改写该契约。

#### Scenario: 可选属性被改写为可空
- **WHEN** 结果契约含可选属性，strict 转换把它包成 `anyOf: [prop, { type: "null" }]` 并把 `required` 补全为全部属性
- **THEN** 模型可能对该可选属性提交 `null`
- **AND** Pi 在本地校验前丢弃这个可选 `null`（1.4.0 的 `normalizeOptionalNulls`、1.5.2 的 `pi-schema` `coerce` Pass 1）
- **AND** `config.resultSchema` 本身保持原样

#### Scenario: null 落在不会被归一化的位置
- **WHEN** 可选属性为 `null` 且该位置不在 object `properties` 或数组 `items` 的遍历范围内（例如 union 分支内部），而原 schema 不接受 `null`
- **THEN** 本地校验返回 `rejected` 与诊断
- **AND** 该回合按「未接受的提交不结束回合」继续，模型可在同轮修正

### Requirement: 已接受提交胜过宿主的 toolUse 守卫
当 Pi 因提前终止在最后一条 assistant 消息上留下 `stopReason` 为 `toolUse` 时，Dext 宿主 SHALL 在本回合已有被接受的提交时把该回合视为成功并采用该提交，MUST NOT 以 `Pi stopped before producing a final response.` 判失败。

#### Scenario: accepted 提交以工具调用结束
- **WHEN** 一次 Pi 回合的提交已被接受，且最后一条 assistant 消息是带 `stopReason: "toolUse"` 的工具调用
- **THEN** 该回合成功返回被接受的结果
- **AND** 不产生「Pi stopped before producing a final response.」

#### Scenario: 未提交的 toolUse 仍判失败
- **WHEN** 一次 Pi 回合没有任何被接受的提交，且结束时 `stopReason` 为 `toolUse` 或 `pending`
- **THEN** 该回合仍按原有守卫判失败

### Requirement: 约束采样不替代提醒通道
`terminate` 与 `constrainedSampling` MUST NOT 被当作「模型一定会调用 `dext_submit_result`」的保证；模型不调用工具时的行为沿用既有提醒与宿主兜底路径。

#### Scenario: 模型不调用工具
- **WHEN** 一个需要结果契约的 Pi 回合结束时模型没有调用 `dext_submit_result`
- **THEN** 既有 `agent_before_settle` 提醒仍然触发一次
- **AND** 本次改动不修改该提醒的触发条件或文案
