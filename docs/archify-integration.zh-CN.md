# Archify 集成与升级

Dext 使用官方发布 ZIP 中的本地运行时，按需裁剪文件，不修改上游源码。布局、语义映射、样式配置和宿主交互归 Dext 适配层负责。升级由开发者验证后随 Dext 发布，不在用户机器上自动替换运行时，也不安装 Archify skill。

## 当前固定版本

- 发布：[v3.2.0](https://github.com/tt-a1i/archify/releases/tag/v3.2.0)。
- 下载：[archify.zip](https://github.com/tt-a1i/archify/releases/download/v3.2.0/archify.zip)，5,271,959 字节。
- ZIP SHA-256：`70e210265c59f24dcbdf2a502ff671104b5454e7ee7d3554aecd86bad32384f5`。
- 标签对象：`e62275b6373fa63436e195635835c313ce028b21`，指向提交 `208acba8d412335185b2056fedf54b3405df43fb`。两者属于同一个发布，不能把标签对象当成另一个源码提交。
- `vendor/project-diagrams/archify/UPSTREAM.json` 由 Dext 维护，记录发布来源、裁剪范围和运行时文件摘要；其他 126 个文件均来自官方 ZIP。
- `.gitattributes` 保留 vendor 文件原始字节，避免 Windows 自动转换换行符影响核对。

当前接入 `architecture`、`workflow`、`sequence`、`data_flow`、`lifecycle`、`tree`、`class` 七类 Project 图。保留的 `explainer` 辅助文件是 CLI 检查器依赖，不表示已经接入 explainer 产品功能。ERD、timeline、waterfall 和 explainer 页面仍不在 Project 能力列表内。

## 本次核验（2026-10-27）

- 重新下载发布 ZIP，摘要同时与原来源记录及 GitHub 发布资产 digest 一致。
- 126 个 vendor 文件内容均匹配发布包；同步前仅架构 renderer 的本地换行符为 CRLF，已恢复发布包原始 LF 字节。上游运行时没有源码逻辑 diff。
- 5 个相关测试文件、47 项测试和类型检查通过。
- 七类图、中文长标签夹具、当前项目 C1/C2 均通过真实 CLI 和浏览器检查，包括 SVG 导出、CSP、原生全屏、搜索、缩放、重置；已查看生成截图。阅读器另通过明暗／高对比度主题、1400／320 宽度和失败状态检查。
- 生产构建、模块边界和包资源检查通过；126 个运行时文件及来源记录均在 VSIX 文件清单中。
- 摘要检查的独立临时夹具确认：字节变更、添加、删除、解压文件不匹配、错误 ZIP 摘要都会被拒绝，失败时不重写来源记录。

结论是现有七类图的已测功能兼容。真实 VS Code 安装后的人工操作、其他操作系统以及全部上游功能尚未验收，不能称为全功能“完美适配”。长架构描述仍是原生单行文本，缩放到全图时偏小；原生装饰、双层控制栏及复杂边界布局仍有可读性优化空间，应通过 Dext 配置和适配层另行处理。

## 修改边界

| 需求 | 修改位置 |
| --- | --- |
| 字体、主题、布局参数 | 先查官方 schema、renderer README、发布包 references；通过原生配置传入 |
| Project 语义转 Archify IR、标签位置和连线路径、受限布局修复 | `src/features/project/host/diagrams/archifyAdapter.ts` |
| VS Code 沙箱、消息、源码跳转、导出、全屏 | `src/features/project/browser/archifyBridge.ts`、`src/features/project/host/diagrams/projectDiagramViewer.ts`、阅读器 |
| 上游没有配置入口的渲染能力 | 保留当前行为或向上游提出需求；明确说明限制，不在 vendor 打补丁 |

适配层同样不应依赖替换 HTML/SVG 字符串来实现新的渲染器。当前长架构标签通过原生 `labelAt`、`via`、布局间距解决位置问题；多行标签需要上游原生支持，不能据此宣称已经支持。

## 升级已有能力

1. 阅读目标版本 release notes 和原生契约变化。记录目标 release tag、标签对象及其解析后的提交、ZIP 下载地址、GitHub asset digest；不要用 `main` 替代固定发布。
2. 先检查 `git status` 和 vendor diff，保留现有工作。将 ZIP 下载到 `.tmp-*` 目录，核对 SHA-256 后解压。只下载依赖发布包，不执行包内安装脚本。
3. 同版本核对可直接执行以下命令；所有命令从仓库根目录运行：

```powershell
$auditDir = '.tmp-archify-release-audit'
New-Item -ItemType Directory -Force -Path $auditDir | Out-Null
Invoke-WebRequest -Uri 'https://github.com/tt-a1i/archify/releases/download/v3.2.0/archify.zip' -OutFile "$auditDir/archify.zip"
Get-FileHash -LiteralPath "$auditDir/archify.zip" -Algorithm SHA256
# 核对摘要后解压。
Expand-Archive -LiteralPath "$auditDir/archify.zip" -DestinationPath "$auditDir/extracted" -Force
node scripts/checkArchifyUpstream.mjs --source "$auditDir/extracted/archify" --archive "$auditDir/archify.zip"
```

4. 升级时，先比较旧版和新版的导入、动态加载、模板、字体、locale、schema、校验器及第三方许可证依赖；逐个用发布包原文件替换现有文件。遇到新增依赖就复制原文件，遇到移除或改名就明确调整文件集。不要盲目覆盖整个 vendor，也不要只替换 renderer。类图依赖 `renderers/erd/grid.mjs`，不可因为 ERD 未接入就删除它。
5. 更新 `UPSTREAM.json` 的版本、发布 URL、标签对象、提交和 ZIP 摘要，核实裁剪说明。更新适配层 `PACKAGE_VERSION` 和 `RUNTIME_VERSION`，确保缓存、产物及回执不混用不同运行时；纯渲染变化不要求改写已保存的 Project 模型。
6. 原文件复制完成后，重新比对官方解压目录并记录摘要：

```powershell
node scripts/checkArchifyUpstream.mjs --source '.tmp-archify-release-audit/extracted/archify' --archive '.tmp-archify-release-audit/archify.zip' --record
node scripts/checkArchifyUpstream.mjs
```

`--record` 要求同时提供 ZIP 和解压目录，校验 ZIP 与已记录 SHA-256、全部 vendor 文件与解压文件逐字节一致后才更新摘要。它不会下载、复制、修补源码，也不会判断新版功能是否兼容。无参数检查不联网，会拒绝 vendor 文件的增加、删除或修改；它也已接入 `test:build-assets`。

7. 执行下面的回归，再审查 diff。最后在真实 VS Code 中检查主题切换、节点与正文联动、证据跳转、搜索、缩放、全屏及 SVG 导出。只有浏览器检查通过，不能声称 Extension Host 或所有平台已验证。

```powershell
npm run typecheck
npx vitest run test/archifyAdapter.test.ts test/archifyLayoutBudget.test.ts test/projectC4.test.ts test/projectDiagramRegistry.test.ts test/projectDiagramViewer.test.ts
node scripts/checkProjectDiagramsUi.mjs --saved-project
node scripts/checkProjectReaderUi.mjs
npm run build
npm run test:build-assets
```

浏览器检查使用当前适配层和真实上游 CLI，覆盖七类图、沙箱 CSP、中文长标签、原生控制及导出；`--saved-project` 额外读取当前 `.dext/project-intent.json` 的 C4 数据。截图位于 `.tmp-tb/project-diagrams-ui`，应实际打开检查。跨大版本升级再运行完整 `npm run check`，并复核已有项目数据的兼容性。

## 接入新功能

运行时升级和产品新功能接入分别审查。官方新增 renderer 不会自动变成 Dext 的可选图，也不代表现有模型能表达它。

1. 明确新功能的真实输入、证据来源和用户入口。例如 explainer 接受 Markdown、引用和页面内容，不能当成另一张普通 Project 图直接开启。
2. 全局搜索图类型契约、校验器、AI 输出 schema/prompt、存储、adapter capabilities、阅读器和导出路径，列明需要改造与保留的部分。必要时制定旧数据迁移方案。
3. 补齐相应上游 renderer、schema、运行依赖及许可证原文件，在 Dext 适配层编写语义映射；保留已有稳定 Project ID 与证据约束。
4. 更新 adapter 的资产探测、`scripts/assertWebviewAssets.mjs` 的 VSIX 文件要求；用真实 CLI 测试有效输入、无效输入、取消及失败行为，再补浏览器交互检查。不能只靠文件存在或 renderer 独立成功来判断接入完成。
5. 重新记录上游摘要，验证生产构建与包内文件，完成真实 VS Code 验收后随 Dext 发布。出现兼容性回归时整体回退运行时、来源记录与适配改动，保留用户原始模型。
