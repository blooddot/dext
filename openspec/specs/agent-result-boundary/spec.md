# agent-result-boundary Specification

## Purpose

定义 Agent 的原始正文被接受为 Dext 结果的边界：合法信封按字段解析，没有信封的正文整段成为文本结果，看起来像信封却校验不过的正文同样可以整段成为文本结果，而无意义的 JSON 对象仍然判失败。

## Requirements

### Requirement: 合法信封按字段解析
当原始输出中存在 `kind` 与调用声明一致、且通过结果契约校验的 JSON 对象时，系统 SHALL 用该对象的字段作为结果，并 MUST 原样保留其中的 `text`、`patch`、`files` 等字段，不得把它们替换为整段原文。

#### Scenario: 合法 agent 信封
- **WHEN** 一次 `agent` 调用的原始输出是 `{"kind":"agent","text":"typed"}`
- **THEN** 结果为 `{ kind: "agent", text: "typed" }`
- **AND** 该回合不报告任何纯文本退化

#### Scenario: 叙述包裹的合法信封
- **WHEN** 原始输出由一句叙述、一个 `json` 代码块和一个合法信封组成
- **THEN** 结果取该信封的字段，而不是整段原文

### Requirement: 无 JSON 对象的正文整段成为文本
当原始输出中不存在任何可解析的 JSON 对象时，被读取为 `agent` 类别的回合 SHALL 把整条原文作为 `text` 结果返回，MUST NOT 因此丢弃该回合。

#### Scenario: 纯 Markdown 回答
- **WHEN** 一次 `agent` 调用的原始输出是一份不含 JSON 对象的 Markdown 表格
- **THEN** 结果为 `{ kind: "agent", text: <整段原文> }`
- **AND** 状态事件说明结果退化为整段文本

### Requirement: 信封形状的 JSON 校验失败时退化为整段原文
当原始输出中能抓到 JSON 对象、但该对象无法通过结果契约校验（缺少 `text`、包含契约之外的字段或 `kind` 不匹配）、且该回合没有可用的结构化修复通道时，系统 SHALL 再接受一次整段原文：把整条原始消息（含叙述与代码块）作为 `text`。该退化结果 MUST 通过与信封相同的契约校验。

#### Scenario: 正文里内嵌业务 JSON
- **WHEN** 一次 `agent` 调用的原始输出是「一句中文说明 + 一个含 `name`、`targetPath`、`nodes` 的 JSON 对象」
- **THEN** 结果成功返回，`text` 为包含该代码块在内的整段原文
- **AND** 该回合不再以 `text: Invalid input: expected string, received undefined` 或 `Unrecognized key: "name"` 失败

#### Scenario: 退化为原文后仍需满足契约
- **WHEN** 整段原文作为 `text` 也无法满足该次调用的结果契约
- **THEN** 该回合仍然判失败，并保留原本的信封校验诊断

### Requirement: 结构化修复通道优先于纯文本退化
当该回合存在可用的结构化修复通道时，系统 SHALL 先尝试修复并优先采用修复返回的结果；只有在修复不可用或修复未产出可用结果之后，SHALL 才使用整段原文退化。

#### Scenario: 修复成功
- **WHEN** 信封校验失败，但修复通道返回了一个通过契约校验的信封
- **THEN** 结果为修复后的字段，`text` 不是整段原文

#### Scenario: 修复不可用
- **WHEN** 当前 agent 提供方（例如 Pi）没有可用的修复通道，修复仅返回「不可用」说明
- **THEN** 系统改用整段原文退化，而不是直接把该回合判失败

### Requirement: 退化不得替代必需的结构化载荷
当该回合写工作区且要求 `patch`，或该次调用的结果契约要求 `patch`、`files` 时，纯文本退化 MUST NOT 生效，系统 SHALL 像改动前一样报告校验失败。

#### Scenario: 写工作区且要求 patch
- **WHEN** 一次写了工作区、且未声明 `patch: false` 的 `agent` 调用返回了「正文 + 业务 JSON」
- **THEN** 该回合判失败，不产出纯文本结果

### Requirement: 无意义的 JSON 对象仍然判失败
当抓到的 JSON 对象无法通过契约校验、且整段原文作为 `text` 也无法通过契约校验时（例如原文只有一个 `{}`），系统 SHALL 判失败，并在错误里既给出校验诊断也给出原文片段。

#### Scenario: 空对象
- **WHEN** 一次 `agent` 调用的原始输出是 `{}`
- **THEN** 该回合判失败，错误信息包含契约校验诊断与前 200 个字符的原文

### Requirement: 纯文本退化必须对用户可见
每次使用整段原文退化时，系统 SHALL 发出一个状态事件，说明 Agent 没有返回可用信封、整段消息已作为结果文本；该事件 MUST NOT 出现在按字段解析成功的回合里。

#### Scenario: 退化事件的可观测性
- **WHEN** 结果来自整段原文退化
- **THEN** 该回合产生一条说明退化的状态事件
- **AND** 同一个回归套件里按字段解析成功的回合不产生该事件
