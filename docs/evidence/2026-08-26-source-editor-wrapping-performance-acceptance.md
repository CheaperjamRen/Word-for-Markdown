# 源码编辑器软换行与长文性能验收

## 验收对象

- 设计合同：`docs/superpowers/specs/2026-08-25-source-editor-wrapping-history-performance-design.md`
- 功能提交：`dd1c21f`、`2bd3d2a`、`6680605`、`8c68aa7`、`08fc780`
- Windows 可执行文件：`src-tauri/target/release/markdown-document-app.exe`，12,394,496 bytes
- NSIS 安装包：`src-tauri/target/release/bundle/nsis/Markdown 文档_0.1.0_x64-setup.exe`，4,523,542 bytes

## 合同追踪

| 设计要求 | 生产表面 | 自动证据 | 打包版证据 |
| --- | --- | --- | --- |
| 软换行不改变真实行号或 Markdown | `SourceEditor`, CodeMirror | `SourceEditor.test.tsx`: 单逻辑行开启 `lineWrapping` 且 `doc.lines === 1` | 100 KB 单行文件在窄窗中视觉折为多行但仅显示行号 1；普通长行折行后续行不虚增编号 |
| 原生可见字符、拖放光标与 Tab 缩进 | `SourceEditor` | `SourceEditor.test.tsx`: 特殊字符、拖放态、Tab 与单选区快捷键边界 | 实际输入中文与 emoji、键盘选中 `QA`、鼠标拖选及粘贴均可用；Windows 拼音候选窗正常显示并提交“中文” |
| 连续输入按自然操作组撤销 | `SourceEditor`, controller, reducer | 输入、删除方向、Enter、粘贴、组合输入、选区替换、选区移动、500 ms 边界及 App 级 Undo/Redo 均通过；选区覆盖为原子组，后续输入另起一组 | `abc中文` 一次撤销；Enter 后立即 Backspace 可恢复；1 MB 末尾输入与撤销的 UI 动作各约 0.16 秒 |
| 源码批次与本地回显不复制整文 | TypeScript 合同、`SourceEditor` 与 controller | 架构测试锁定五个字段；100 KB 回归确认无 `baseView` / `bufferText`；已接受 props echo 不调用 CodeMirror `doc.toString()` | 不适用 |
| 折行视口按可见字符恢复并合并滚动通知 | Source viewport bridge | 同帧滚动只报告一次；卸载前刷新；缩放后回到同一字符 | 窄窗约第 26 行处从 100% 放到 110% 后仍停留在第 26 行附近；切标签返回也保持源码位置 |
| 不牺牲保存、恢复、外部冲突与字节保真 | controller 与 Rust 文件服务 | 前端全套、Phase 0 gate-plan、Rust 文件/生命周期测试通过；原子保存只信任文件服务登记的精确随机重命名目标，回滚目标也覆盖，伪装文件名仍按真实 rename | 三份长文逐一保存、关闭、重开；原始前缀逐字节一致，BOM、CRLF/LF、emoji、Protected Raw 均保留；外部冲突双方均保留 |

## 自动验证

2026-08-26 在隔离工作树执行 `npm run verify`：

- Vitest：65 个测试文件、677 项测试全部通过；
- 图标资产：2 项通过；
- Source QA 夹具：2 项通过；
- Phase 0 gate-plan：通过；
- TypeScript 类型检查与 Vite production build：通过；
- Rust：库 47 项、generated handler 2 项、lifecycle 27 项、window geometry config 3 项，合计 79 项通过；
- 唯一构建提示为既有的部分动态分块超过 500 kB；它不影响本轮验收，但保留为后续首开性能优化项。

100 KB controller 回归进一步确认：

- 52 个相邻输入批次恰好触发 52 次同步候选解析；
- 这 52 次输入仅新增 1 个历史快照组；连同之前的独立原子修改，`history.past` 共 2 项；
- 当前 Source view cache 始终只保留 1 个会话/修订条目；
- 每批不含 `baseView` 或 `bufferText` 整文成员。

## 确定性 QA 文档

最终复测生成目录：`E:\MarkdownDocumentApp\.tmp\source-editor-qa-20260826-0510`

| 文件 | 字节 | 换行合同 | SHA-256 |
| --- | ---: | --- | --- |
| `source-100kb.md` | 102,400 | LF，1,165 个真实换行；含 Protected Raw | `1D606FAE56F8F6F6AD92D30B8717E93F81627D95AB497CD4EA1B228F6E84E906` |
| `source-1mb.md` | 1,048,576 | UTF-8 BOM；CRLF 11,550 个；无裸 LF；含 Protected Raw | `16B6060DAADBCCD08EF6E64CD49E47AC4CDD88A0B6A4A26E892B0F6DFB810E3B` |
| `source-single-line-100kb.md` | 102,400 | 无 CR/LF，仅 1 个逻辑行 | `BB3FEBACFCD683466A67750B2B8C279DBBC22A506B9DF7644C33B96C848120E5` |

典型文档覆盖 frontmatter、标题、中英文、emoji、列表、GFM 表格、本地链接、代码围栏、行内/块级数学公式、私有指令和原始 HTML。100 KB 与 1 MB 文档分别覆盖 LF、UTF-8 BOM 与 CRLF；Protected Raw 与后续普通段落由真实空行隔开，避免夹具本身把文档余下内容错误吞进受保护块。极端夹具专门隔离单行布局成本。

三份文件都在应用中追加独立标记后显式保存、关闭并由路径重开。保存结果如下：

| 文件 | 保存后字节 | 追加标记 | 原始前缀逐字节一致 | 保存后 SHA-256 |
| --- | ---: | --- | --- | --- |
| `source-100kb.md` | 102,419 | ` qa-roundtrip-100kb` | 是 | `F25A0ED4732226FB6749107A1F5D788CC5A0F36DE066297ACFD7806154CFA17F` |
| `source-1mb.md` | 1,048,593 | ` qa-roundtrip-1mb` | 是；BOM、11,550 个 CRLF、0 个裸 LF 均保持 | `59AF949F679D6B310832355C65BCD5CA7885E4C08F5A79A746F5BAFFA51D2121` |
| `source-single-line-100kb.md` | 102,424 | ` qa-roundtrip-singleline` | 是；仍无 CR/LF | `256C92051DD7E558DCC50112EA91027F3262C1ADDD1F67C98D859F84535D4EFF` |

## 打包版真人操作

2026-08-26 在重新构建的 release Windows 可执行文件上完成：

- 用真实路径打开 100 KB、1 MB 与单行 100 KB 文档；通过第二实例路由到同一主窗口，标签和标题正确；
- 100 KB 单行文档在源码模式中显示大量视觉折行但只有逻辑行号 1；Enter 显示行号 2，立即 Backspace 后恢复为行号 1；
- 实际输入 `hello`、`中文😀`、`pasteToken` 和 `abc中文`；另以 Windows 拼音输入法逐键输入 `zhong`、`wen`，候选窗正常跟随光标，提交为“中文”。每次组合分别一次 Undo 完整撤销；普通连续输入和粘贴也按自然操作组撤销；键盘和鼠标选区均可见且范围正确；
- 1 MB 文档切到源码模式后保持响应，末尾输入和 Undo 的桌面动作分别为 155 ms 与 157 ms；未观察到冻结或崩溃；
- 单行文档深处缩放、阅读/源码模式切换、标签切换后返回均未跳到顶部；窄窗 100%→110% 仍保持约第 26 行视口；
- 三份最终夹具分别追加标记并显式保存，UI 均回到“已保存”，关闭后从真实路径重开成功；磁盘原始前缀逐字节一致，目录无 `.markdown-spike-*` 残留；
- 实际保存首次暴露了 Windows `ReplaceFileW` 将旧目标移动到内部备份时被监听器误判为“文件已移动”的问题。第一版按文件名猜测的修复在对抗审查中被否决；最终实现只接受文件服务为当前事务登记的精确随机目标，同时登记 `.replaced-backup` 与回滚 `.rollback-capture`。未登记的相似名称仍报告真实重命名。重建后连续保存没有误报冲突；
- 本地保留 `local-unsaved-guard` 时从外部向磁盘写入 `disk-external-change`，界面显示“存在冲突”并提供“载入磁盘版本 / 保留我的版本”；编辑缓冲和磁盘尾部分别保留各自标记，没有静默覆盖；
- 关闭已保存标签后重新用文件路径打开，磁盘标记仍在；点击窗口右上角关闭后进程退出，未残留后台进程。

真实中文字符、emoji 与 Windows 拼音候选框的逐键组合均已验证；CodeMirror composition 事件测试同时锁定了该路径。不同第三方输入法仍应由首批用户反馈覆盖，但不再是本轮未验收项。

## 截图证据

- [宽窗口 100 KB 源码视图](./source-editor/source-100kb-wide.jpg)：1,463 × 866，完整工具栏、标签、状态栏与真实行号。
- [窄窗口 100 KB 源码视图](./source-editor/source-100kb-narrow.jpg)：761 × 791，视觉折行清晰，续行不重复编号，高频工具仍可访问。

## 当前结论

源码自动换行、逻辑行号、连续编辑/撤销、选区替换、Windows 拼音组合、本地回显成本、视口保持、100 KB/1 MB 响应、三类字节往返、原子保存监听、外部冲突、重开和退出的核心链路均通过。第三方输入法差异与不同机器上的性能分布进入首批真实用户反馈清单，不阻断本轮交付。
