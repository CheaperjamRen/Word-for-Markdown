# 源码编辑器软换行与长文性能验收

## 验收对象

- 设计合同：`docs/superpowers/specs/2026-08-25-source-editor-wrapping-history-performance-design.md`
- 功能提交：`dd1c21f`、`2bd3d2a`、`6680605`、`8c68aa7`
- Windows 可执行文件：`src-tauri/target/release/markdown-document-app.exe`，12,401,664 bytes
- NSIS 安装包：`src-tauri/target/release/bundle/nsis/Markdown 文档_0.1.0_x64-setup.exe`，4,522,764 bytes

## 合同追踪

| 设计要求 | 生产表面 | 自动证据 | 打包版证据 |
| --- | --- | --- | --- |
| 软换行不改变真实行号或 Markdown | `SourceEditor`, CodeMirror | `SourceEditor.test.tsx`: 单逻辑行开启 `lineWrapping` 且 `doc.lines === 1` | 100 KB 单行文件在窄窗中视觉折为多行但仅显示行号 1；普通长行折行后续行不虚增编号 |
| 原生可见字符、拖放光标与 Tab 缩进 | `SourceEditor` | `SourceEditor.test.tsx`: 特殊字符、拖放态、Tab 与单选区快捷键边界 | 实际输入中文与 emoji、键盘选中 `QA`、鼠标拖选及粘贴均可用；Windows 拼音候选窗正常显示并提交“中文” |
| 连续输入按自然操作组撤销 | `SourceEditor`, controller, reducer | 输入、删除方向、Enter、粘贴、组合输入、选区移动、500 ms 边界及 App 级 Undo/Redo 均通过 | `abc中文` 一次撤销；Enter 后立即 Backspace 可恢复；1 MB 末尾输入与撤销的 UI 动作各约 0.16 秒 |
| 源码批次不携带整份视图或缓冲区 | TypeScript 合同与 controller | 架构测试锁定五个字段；100 KB 回归确认无 `baseView` / `bufferText` | 不适用 |
| 折行视口按可见字符恢复并合并滚动通知 | Source viewport bridge | 同帧滚动只报告一次；卸载前刷新；缩放后回到同一字符 | 窄窗约第 26 行处从 100% 放到 110% 后仍停留在第 26 行附近；切标签返回也保持源码位置 |
| 不牺牲保存、恢复、外部冲突与字节保真 | controller 与 Rust 文件服务 | 前端全套、Phase 0 gate-plan、Rust 文件/生命周期测试通过 | 真实保存后磁盘包含标记且无临时文件残留；外部修改时同时保留本地缓冲与磁盘内容并弹出版本选择；关闭标签、重开及窗口退出均正常 |

## 自动验证

2026-08-26 在隔离工作树执行 `npm run verify`：

- Vitest：65 个测试文件、674 项测试全部通过；
- 图标资产：2 项通过；
- Source QA 夹具：2 项通过；
- Phase 0 gate-plan：通过；
- TypeScript 类型检查与 Vite production build：通过；
- Rust：库 46 项、generated handler 2 项、lifecycle 27 项、window geometry config 3 项，合计 78 项通过；
- 唯一构建提示为既有的部分动态分块超过 500 kB；它不影响本轮验收，但保留为后续首开性能优化项。

100 KB controller 回归进一步确认：

- 52 个相邻输入批次恰好触发 52 次同步候选解析；
- 这 52 次输入仅新增 1 个历史快照组；连同之前的独立原子修改，`history.past` 共 2 项；
- 当前 Source view cache 始终只保留 1 个会话/修订条目；
- 每批不含 `baseView` 或 `bufferText` 整文成员。

## 确定性 QA 文档

最终复测生成目录：`E:\MarkdownDocumentApp\.tmp\source-editor-qa-20260826-035357`

| 文件 | 字节 | 换行合同 | SHA-256 |
| --- | ---: | --- | --- |
| `source-100kb.md` | 102,400 | LF，1,156 个真实换行 | `96482EA26977E339A6BA831DE123A4DD87D937C420E15B7F77B04C35773C080A` |
| `source-1mb.md` | 1,048,576 | CRLF，11,540 个真实换行 | `1B9D0A64FFF427CA46AF2DCBD6C4D231C0ED4D882C56E22BE376DC6B03C6F673` |
| `source-single-line-100kb.md` | 102,400（生成时） | 无 CR/LF，仅 1 个逻辑行 | 生成时 `BB3FEBACFCD683466A67750B2B8C279DBBC22A506B9DF7644C33B96C848120E5`；保存与外部修改验收后的测试副本为 `6F891F578E28FA315DFD3F01583EEF509C88E811E958A82AE9FBCCFBA1A4A293` |

典型文档覆盖标题、中英文、emoji、列表、GFM 表格、本地链接、代码围栏、行内与块级数学公式。100 KB 与 1 MB 文档分别覆盖 LF 和 CRLF；极端夹具专门隔离单行布局成本。

## 打包版真人操作

2026-08-26 在重新构建的 release Windows 可执行文件上完成：

- 用真实路径打开 100 KB、1 MB 与单行 100 KB 文档；通过第二实例路由到同一主窗口，标签和标题正确；
- 100 KB 单行文档在源码模式中显示大量视觉折行但只有逻辑行号 1；Enter 显示行号 2，立即 Backspace 后恢复为行号 1；
- 实际输入 `hello`、`中文😀`、`pasteToken` 和 `abc中文`；另以 Windows 拼音输入法逐键输入 `zhong`、`wen`，候选窗正常跟随光标，提交为“中文”。每次组合分别一次 Undo 完整撤销；普通连续输入和粘贴也按自然操作组撤销；键盘和鼠标选区均可见且范围正确；
- 1 MB 文档切到源码模式后保持响应，末尾输入和 Undo 的桌面动作分别为 155 ms 与 157 ms；未观察到冻结或崩溃；
- 单行文档深处缩放、阅读/源码模式切换、标签切换后返回均未跳到顶部；窄窗 100%→110% 仍保持约第 26 行视口；
- 显式保存 `saved-ok-20260826` 后 UI 为“已保存”，磁盘内容一致且目录无 `.markdown-spike-*` 残留；
- 实际保存首次暴露了 Windows `ReplaceFileW` 将旧目标移动到内部备份时被监听器误判为“文件已移动”的问题。新增 RED 生命周期测试后，只把同目录且严格匹配 `.markdown-spike-<32 位十六进制>.replaced-backup` 的内部事件降为内容复查；普通真实重命名逻辑不变。重建后重复保存不再出现冲突；
- 本地保留 `local-unsaved-guard` 时从外部向磁盘写入 `disk-external-change`，界面显示“存在冲突”并提供“载入磁盘版本 / 保留我的版本”；编辑缓冲和磁盘尾部分别保留各自标记，没有静默覆盖；
- 关闭已保存标签后重新用文件路径打开，磁盘标记仍在；点击窗口右上角关闭后进程退出，未残留后台进程。

真实中文字符、emoji 与 Windows 拼音候选框的逐键组合均已验证；CodeMirror composition 事件测试同时锁定了该路径。不同第三方输入法仍应由首批用户反馈覆盖，但不再是本轮未验收项。

## 截图证据

- [宽窗口 100 KB 源码视图](./source-editor/source-100kb-wide.jpg)：1,463 × 866，完整工具栏、标签、状态栏与真实行号。
- [窄窗口 100 KB 源码视图](./source-editor/source-100kb-narrow.jpg)：761 × 791，视觉折行清晰，续行不重复编号，高频工具仍可访问。

## 当前结论

源码自动换行、逻辑行号、连续编辑/撤销、Windows 拼音组合、视口保持、100 KB/1 MB 响应、保存、外部冲突、重开和退出的核心链路均通过。第三方输入法差异与不同机器上的性能分布进入首批真实用户反馈清单，不阻断本轮交付。
