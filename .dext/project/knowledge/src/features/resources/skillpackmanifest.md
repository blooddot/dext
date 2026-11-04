## Responsibility

- **Names**: Skill pack import → `SkillPackManifest`（`src/features/resources/domain/skillPack.ts`，同文件导出 `normalizeSkillPackManifest`、`formatSkillPackReport`、`skillPackId`、`isSkillPackId`）；来源侧是 `GithubSource` / `parseGithubUrl` / `githubTreeUrl`（`domain/skillSource.ts`）；下载侧是 `fetchGithubSkillSnapshot` / `fetchGithubArchive` / `extractTarGz` / `DEFAULT_ARCHIVE_LIMITS`（`host/githubSkillSnapshot.ts`、`host/githubArchive.ts`）；候选分析契约是 `SkillImportSelection` / `skillImportPrompt` / `validateSkillImportSelection`（`domain/skillImportAnalysis.ts`）；升级侧是 `buildSkillPackUpgradePlan` / `compareSkillPackContent`（`domain/skillPackUpgrade.ts`）。界面与文档把这族能力叫作「Skill pack import」，标题取代码里最窄的公开类型 `SkillPackManifest`。
- 它拥有「一个技能包是什么、从哪个公开 GitHub 源来、装完之后长什么样」这三件只读事实：`.dext/skill-packs/<id>/` 下的 `pack.json` 清单与 `SOURCE.md` 报告、id 规则（`SKILL_PACK_ID_PATTERN`，最长 64，`[a-z0-9][a-z0-9._-]*`）、v1/v2 两代清单记录，以及 `skills/<id>/SKILL.md` 的规范位置。
- 它拥有容错读取：`normalizeSkillPackManifest` 逐字段降级，缺 `name` 用目录名、缺 `analysis` 用 `skills[].directory` 回填 `selected`、一条 Skill 都没有时返回 `undefined`，但绝不因为清单畸形而抛错。
- 它拥有给人看的那份溯源报告：`formatSkillPackReport` 按固定小节（来源、release、commit、发现方式、选中来源、导入备注、被跳过与被标记不可用的命令）生成 SOURCE.md 文本。
- 它拥有来源 URL 的唯一解析：`parseGithubUrl` 只接受公开 HTTPS 的 `github.com` 与 `raw.githubusercontent.com`，把 repo / tree / blob / raw 四种形状折成 `{owner, repo, path, ref?, skillFile?}`，其余形状返回具体错误文案而不是抛出。
- 它拥有下载与解包的有界性：`DEFAULT_ARCHIVE_LIMITS`（50 MiB 压缩、200 MiB 展开、5 000 个文件、60 s）与内存 tar 读取器 `extractTarGz` 一起决定「什么算一个可导入的快照」。
- 它拥有 AI 选包这一步的输入与验收：`skillImportPrompt` 决定哪些信息离开宿主，`validateSkillImportSelection` 决定什么样的答案可以被采用。
- 它拥有升级的两份证明：`buildSkillPackUpgradePlan` 证明新包只写进自己的目录且每个规范 Skill 可装，`compareSkillPackContent` 证明新旧内容是否真的不同。
- 它不拥有：写盘、移入 Trash、未保存文档检查与冲突报告（归 `src/app/application.ts` 的 `upgradeSkillPack`），候选发现与具体导入流程（归 `resources/host/skillImporter.ts`），资源页的删除归属校验（`resources/host/resourceActions.ts`），技能目录加载（`workflow/host/skillCatalog.ts`），以及真正调用模型的 analyzer（由装配层注入）。

## Design

- **清单是契约，宽容度是刻意的。** `normalizeSkillPackManifest` 只对「没有一条可用 Skill」判失败，因为清单坏掉不该连带让同目录里已经装好的技能从目录中消失；`version: 1 | 2` 只是清单格式而非上游版本，上游版本单列在 `upstreamVersion`，release 与 commit 各自独立保存，因此「同一个版本号、不同字节」可以被识别。
- **两代清单共存而不分支。** v1 用 `directory` 与 `targetAgent` 记录固定导入目标，v2 给每条 Skill 加 `file`（已安装相对路径），`formatSkillPackReport` 只在 v2 打印「每轮用各自 Agent 的版本，其次共享」，v1 则把 `targetAgent` 标成 legacy——差异只在报告措辞与字段有无，读取路径只有一条。
- **选择结果进契约，而不是进日志。** `analysis.mode` 区分 `deterministic` 与 `ai`，`selected` / `excluded` / `skipped` 分开记录：`excluded` 是不可用的具体原因，`skipped` 是 AI 拒绝或越界的候选。这样后来的读者能分辨一次 AI 决定与一次确定性选择，而不必回看当年那次调用。
- **不信任模型返回的是路径。** `skillImportPrompt` 把描述压成单行并截断（名称 120、描述 300、原因 200 字符），只送目录名、id、文件数与 shallow 状态，SKILL.md 正文永不离开宿主；`validateSkillImportSelection` 用 `.strict()` 的 zod 模式解析，再逐条要求路径已存在于候选列表、非绝对、不含 `..`、不重复，`confidence: "low"` 直接拒绝——宁可让用户手动选一个目录，也不采用一个猜出来的包。
- **纯层必须无环境。** `skillSource.ts` 是纯解析、从不 fetch，`src/webview/main.ts` 直接 import 它的 `looksLikeGithubUrl` 来做输入校验，`src/app/application.ts` 用它判断已装包是否还有可更新的来源；因此这里一旦引进 Node 或 VS Code，Webview 立刻无法构建。错误文案本身就是 composer 的提示语。
- **只接受 SKILL.md，因为 command 不是 skill。** blob 与 raw 链接在解析阶段就要求文件名是 `SKILL.md`，`parseGithubUrl` 的注释与文案写明「A command file is not a skill」，这条判定不推到导入阶段再做第二次。
- **仓库根解析到 release，不解析到默认分支。** `resolveGithubRef` 对没有 ref 的来源先问 `releases/latest`（草稿与预发布视为没有发布），只有从未发布过 release 的仓库才回落到 `default_branch`，默认分支按 `owner/repo` 缓存且失败即删缓存；理由是「开发中的 commit 不该变成已安装的包」。tree/blob/raw 链接则原样沿用 URL 里的 ref。
- **先索引后下载，字节预算只花在被选中的文件上。** `fetchGithubSkillSnapshot` 先用 `/commits/<ref>` 钉住 40 位 commit，再读递归 tree 只取名字与 `mode:sha` 作为 `fileHashes`，`loadFiles()` 才下载；无关资产因此不占 `maxCompressedBytes`。API 限流（403/429）或 tree 被截断时回落到有界 tar 下载，这两条路径产出的快照形状相同，调用方不必分叉。
- **预检先于任何一个字节落盘。** `loadFiles` 先对整个选择做一次 file-count、模式（只允许 `100644`/`100755`，链接与 submodule 一律拒绝）、声明大小与总预算的检查，然后才并发四个 worker 下载，任何一步失败都不会留下半份快照；`fetchGithubBytes` 边读边计数，`content-length` 只是提前拒绝的捷径而非唯一防线。
- **重定向按主机白名单。** `fetchGithubBytes` 用 `redirect: "manual"` 自己跟随，最多 5 次，只允许 `codeload.github.com`、`github.com`、`objects.githubusercontent.com`、`raw.githubusercontent.com` 与 `*.githubusercontent.com`，避免把有界下载变成一个任意跳板。
- **tar 解析器按「写入文件系统必须拒绝的全部形状」写。** 内存中读 ustar、PAX 与 GNU long name，校验每个 header 的 checksum 与八进制字段，拒绝硬链接、符号链接、设备与 FIFO，忽略目录项（它们的文件会各自被检查），路径先规范化再进表，大小写折叠后重复即报错，并要求整份归档只有一个仓库根——那个 `repo-commit` 目录名顺带给出 commit。
- **解压上限交给 zlib。** `gunzipSync` 的 `maxOutputLength` 让「解压炸弹」在展开前就失败，并把该错误翻译成一句人话，而不是先用 `Buffer` 撑爆扩展宿主。
- **升级计划只证明归属，不执行替换。** `buildSkillPackUpgradePlan` 要求每个新文件落在 `skills/` 或本包自己的 `skill-packs/<id>/` 内、同一路径（大小写折叠）只写一次、Skill id 通过 `isSkillId`、被别的包声明的 id 直接报冲突、新 id 要么本来属于本包要么目录必须为空，最后才给出完整新树、`removeSkills`、`addedSkills`/`removedSkills` 与 `primarySkillId`；把旧目录移入 Trash 是调用方的事。
- **内容差异与版本解耦。** `compareSkillPackContent` 按字节比较（统一 CRLF、忽略 `pack.json` 与 `SOURCE.md` 这两份生成物），返回 `identical` / `changed` / `added` / `removed`：新 commit 可能一个 Skill 都没变（只改了 README、hook 或测试），移动的 release tag 也可能改了内容却不改版本，只有这份差异能区分两者，而「commit 相同就早退」的判定留在宿主。
- **限额写成常量而不是提示词。** 下载与解包的边界是 `DEFAULT_ARCHIVE_LIMITS` 与被注入的 `limits` 覆盖，索引另设 8 MiB / 100 000 条上的上限；这些数字可被测试断言，也能在测试里收紧成「1 个文件」「5 ms」而不必构造巨型 fixture。

## Boundary

- Allowed: `domain/` 侧只用字符串、`Uint8Array`、`Map`、注入的 `Date` 与注入的 `exists()` 做纯计算，不 import `vscode`、Node 内建模块或 DOM；`host/` 侧可用 `node:zlib`、`globalThis.fetch`、`AbortController` 与 `TextDecoder`，并把 `fetch`、`signal`、`limits`、`apiBase`/`codeloadBase` 作为可选参数注入以便测试。
- Allowed: 声明并校验包的清单形状、id 规则、报告文本、来源 URL、候选摘要与 AI 选择结果、归档与快照形状、升级计划与内容差异；被 `src/app/application.ts`（`skillPackRefs`、`upgradeSkillPack`、`skillImportAnalyzer`、导入入口）、`resources/host/skillImporter.ts`、`resources/host/resourceActions.ts`、`workflow/host/skillCatalog.ts`、`src/webview/main.ts`（仅 `looksLikeGithubUrl`）与 `test/` 引用。
- Allowed: 只读地枚举与解析 GitHub 公开 API 的 commit、tree 与 release 响应，读限定主机上的 tar.gz 与 raw 文件；把超出限额、越界路径、链接条目、重复条目与不安全 id 报成具体错误。
- Forbidden: 写工作区文件、创建目录、把旧包移入 Trash、检查未保存文档或代替调用方确认升级（归 `application.ts` 与资源页）；自己执行导入流程里的候选发现、变体合并、浅层校验与 pack 落盘（归 `skillImporter.ts`）。
- Forbidden: 调用模型。本节点只给提示词与验收规则，`SkillImportAnalyzer` 由装配层注入并绑定到当前 Project AI 或 CLI。
- Forbidden: 把 SKILL.md 正文或支持文件内容送进候选分析提示词；接受模型给出的、不在候选列表内的路径；接受 `low` 置信度的选择后自行「补一个最像的」。
- Forbidden: 在本节点引入 `vscode`、`src/app/`、`src/webview/`、Node 内置模块（`domain/` 内）或 DOM 全局；把第二套路径规则或第二套 SKILL.md 定位规则与 `resourcePathSegments` / `SKILL.md` 常量并列。
- Forbidden: 用目录名、README 或 package.json 反推一个技能包的内容；对非 GitHub 来源、带凭据/端口/query/hash/编码斜杠的 URL，或指向 command 文件的链接做「尽力而为」的导入。