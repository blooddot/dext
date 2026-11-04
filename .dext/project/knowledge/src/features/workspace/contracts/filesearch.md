## Responsibility

- **Names**: fileSearch → `src/features/workspace/contracts/fileSearch.ts`。
- 拥有输入框 `@` 文件补全这一交互的线协议形状：请求体 `fileSearchRequestSchema`（`type: "searchFiles"`、`requestId`、`query`，`query` 上限 120 字符）、由它推导的 `FileSearchRequest`，以及回包 `FileSearchResponse`（`type: "searchFilesResult"`、`requestId`、`files`）。
- 拥有 `requestId` 这个配对字段的存在性：它让一次查询与唯一一个回包对上号，从而支撑「只保留最新一次查询」的语义；但淘汰策略本身不在此处。
- 不拥有匹配打分（`domain/fileSearch.ts` 的 `rankFileMatches`、`fileMatchScore`），不拥有索引、缓存与文件监视（`host/fileSearchController.ts`），也不拥有 webview 侧的状态机（`browser/fileSearchClient.ts`）。

## Design

- 形状与校验分开落位：只有入站方向用 zod 定义 `fileSearchRequestSchema`，因为它要进入 `src/platform/webviewProtocol.ts` 的 `webviewRequestSchema` 判别联合；该文件以展开成员的方式组合本 schema（把 `fileSearchRequestSchema` 直接放进联合），所以 workspace 新增一条消息只改本文件，无须编辑协议总表——这正是把 schema 留在特性契约、而非写进 `platform` 的原因。
- 出站方向只声明 TypeScript 接口 `FileSearchResponse`：宿主是产出方、webview 是消费方，没有不可信输入需要解析，因此 `webviewProtocol.ts` 只把它并进 `WebviewResponse` 联合类型，不再复述校验。
- 契约里唯一的两条策略是最小必要的：`query` 的 120 字符上限，避免一次按键把无界字符串推进 IPC；`requestId` 的非负整数约束，让「最新请求」可以用单调比较判定。真正的截断（`MAX_INDEXED_FILES`、`MAX_FILE_SUGGESTIONS`）留在 host，契约不复制这些常量。
- 本文件属于纯层：不引用 `vscode`、Node 内置模块或 DOM 全局，因此三个环境引用同一个文件——host 与 browser 只取类型，`platform/webviewProtocol.ts` 同时取值（schema）与类型。
- 与同名实现的关系是分层而非重复：`contracts` 只管形状，打分在 `domain/`，索引与生命周期在 `host/`，`test/fileSearch.test.ts` 因此能分别断言排序行为与请求淘汰行为。

## Boundary

- Allowed: 被 `src/features/workspace/host/fileSearchController.ts` 与 `src/features/workspace/browser/fileSearchClient.ts` 以 `import type` 引用，被 `src/platform/webviewProtocol.ts` 以值加类型引用，并被 `test/conversationProtocol.test.ts` 用于协议断言。
- Allowed: 收紧或新增字段时同步修改 zod schema 与响应接口，两者必须保持同一形状。
- Forbidden: 引入 `vscode`、Node 内置模块、DOM 全局，或依赖任何 `host/`、`browser/`、`domain/` 实现。
- Forbidden: 在契约里承载排序算法、索引上限、文件监视、缓存或重试；这些属于 `domain/` 与 `host/`，契约只描述线上形状。