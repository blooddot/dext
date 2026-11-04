## Responsibility

- **Names**: ProjectChangeEvidence → src/features/project/host/projectChangeEvidence.ts（同一文件导出 `ProjectChangeBaseline`、`ProjectChangeReport`、`ProjectChangeLimits`；没有界面名，界面与文档把它叫 change evidence / 变更证据，代码里的入口符号就是这三个）
- 它只拥有**一次 Plan 执行期间“源码字节到底变了什么”这一份证据**：`capture()` 在开工前把整棵工作区拍成基线，`compare()` 在收尾时重新拍一遍并产出 `ProjectChangeReport`（`added` / `modified` / `deleted`、`renameCandidates`、`diagnostics`、`complete`）。
- 它同时拥有基线的落盘形态与寿命：`version`、`id`（uuid）、`workspaceKey`、`capturedAt`、`complete`、`diagnostics`、`git`、`initialStatus`，以及 `files` 里每个路径的 sha256 与可选 UTF-8 正文。`capture(discard)` 写新基线时顺手删掉上一份，`remove()` 在运行结束清场，所以每个工作区目录里的源码快照最多一份。
- 它明确不拥有判断：变更由谁造成、规范是否因此过期、Plan 是否通过，都由调用方（`src/app/application.ts` 的 `startPlanProject` / `finishPlanProject` 与 `ProjectPlanReconciler`）决定；文件头注释也写明这是 content evidence，不是“每处编辑都出自 Agent”的断言。

## Design

- 形状是“类 + 注入的根目录 + 可调的预算”：构造函数一次性 `resolve(workspace)`，把基线目录算成 `storage/plan-project/<sha256(workspaceKey)>`，因此同一个仓库永远落到同一个目录，而 `maxFiles`（默认 1000）、`maxFileBytes`（256 KiB）、`maxBytes`（32 MB）、`exclude` 由调用方收紧，测试可以不经真实仓库就验证截断行为。
- 清单优先交给 git，退化路径有界：先试 `git ls-files -z --cached --others --exclude-standard` 加 `git status --porcelain=v1 -z`，失败才走目录遍历，并跳过 `.git`、`node_modules`、`dist`、`build`、`.env*`、`.ssh`、`.aws` 与 `pem/key/p12/pfx`；符号链接一律不跟，只记一条诊断，`git` 字段与 `initialStatus` 让读报告的人知道这份证据是哪条路径得来的。
- 快照先做安全与一致性再谈内容：绝对路径与含 `..` 的路径直接拒，`lstat` 后要求是普通文件，`realpath` 结果必须仍在工作区内，读前后各 `stat` 一次（大小、mtime、ino 任一变化即判“读取期间被并发修改”），越界与超预算都写成诊断而不是静默截断；正文只在无 NUL 且能按 UTF-8 严格解码时保存，二进制仍然留下哈希，于是“没变”永远是可比对的字节事实。
- 基线用 strict zod schema 校验并由 `writeFile(..., { flag: "wx" })` 独占创建：既不覆盖既有证据，也不给伪造或半写的基线留进口；`compare()` 先验 uuid 再验 `workspaceKey`，跨工作区的基线直接报错，而不是碰巧比出一堆差异。
- 报告把“事实”和“推测”分开：路径差集只按哈希比对，改动到二进制或非 UTF-8 正文时追加一条需人工复核的诊断；`renameCandidates` 由 `deleted.beforeHash === added.afterHash` 推出，名字里就写明它只是候选。`complete` 要求两次快照都完整且没有任何诊断，因此“证据不全”这件事本身可被下游检测到，而不是靠零诊断冒充干净。

## Boundary

- Allowed: 通过 git 或受预算约束的目录遍历读取工作区文件；在注入的 storage 目录下写入、删除自己那份 `plan-project/<hash>/<uuid>.json` 基线；产出 `ProjectChangeBaseline` / `ProjectChangeReport` 与限定覆盖范围的 diagnostics；在 uuid 非法时静默放弃删除。
- Forbidden: 修改工作区源码、`.dext` 模型或规范正文；断言某次编辑的作者身份；判定 Plan 是否有效、规范是否该标记过期（`application.ts` 的收尾流程与 `ProjectPlanReconciler` 拥有该判断）；调用 AI、索引或生成流水线；渲染界面或依赖 webview/DOM；跟随符号链接、越过 `realpath` 后的工作区根，或读取未列入清单的文件。