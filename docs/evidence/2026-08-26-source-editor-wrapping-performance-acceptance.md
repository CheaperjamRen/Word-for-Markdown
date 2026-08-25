# 源码编辑器软换行与长文性能验收

## 验收对象

- 设计合同：`docs/superpowers/specs/2026-08-25-source-editor-wrapping-history-performance-design.md`
- 功能提交：`dd1c21f`、`2bd3d2a`、`6680605`、`8c68aa7`
- Windows 可执行文件：`src-tauri/target/release/markdown-document-app.exe`，12,389,888 bytes
- NSIS 安装包：`src-tauri/target/release/bundle/nsis/Markdown 文档_0.1.0_x64-setup.exe`，4,521,995 bytes

## 合同追踪

| 设计要求 | 生产表面 | 自动证据 | 打包版证据 |
| --- | --- | --- | --- |
| 软换行不改变真实行号或 Markdown | `SourceEditor`, CodeMirror | `SourceEditor.test.tsx`: 单逻辑行开启 `lineWrapping` 且 `doc.lines === 1` | 待解锁 Windows 桌面后补录 |
| 原生可见字符、拖放光标与 Tab 缩进 | `SourceEditor` | `SourceEditor.test.tsx`: 特殊字符、拖放态、Tab 与单选区快捷键边界 | 待补录 |
| 连续输入按自然操作组撤销 | `SourceEditor`, controller, reducer | 输入、删除方向、Enter、粘贴、组合输入、选区移动、500 ms 边界及 App 级 Undo/Redo 均通过 | 待补录 |
| 源码批次不携带整份视图或缓冲区 | TypeScript 合同与 controller | 架构测试锁定五个字段；100 KB 回归确认无 `baseView` / `bufferText` | 不适用 |
| 折行视口按可见字符恢复并合并滚动通知 | Source viewport bridge | 同帧滚动只报告一次；卸载前刷新；缩放后回到同一字符 | 待补录 |
| 不牺牲保存、恢复、外部冲突与字节保真 | controller 与 Rust 文件服务 | 前端全套、Phase 0 gate-plan、Rust 文件/生命周期测试通过 | 待补录 |

## 自动验证

2026-08-26 在隔离工作树执行 `npm run verify`：

- Vitest：65 个测试文件、674 项测试全部通过；
- 图标资产：2 项通过；
- Source QA 夹具：2 项通过；
- Phase 0 gate-plan：通过；
- TypeScript 类型检查与 Vite production build：通过；
- Rust：库 46 项、generated handler 2 项、lifecycle 26 项、window geometry config 3 项，合计 77 项通过；
- 唯一构建提示为既有的部分动态分块超过 500 kB；它不影响本轮验收，但保留为后续首开性能优化项。

100 KB controller 回归进一步确认：

- 52 个相邻输入批次恰好触发 52 次同步候选解析；
- 这 52 次输入仅新增 1 个历史快照组；连同之前的独立原子修改，`history.past` 共 2 项；
- 当前 Source view cache 始终只保留 1 个会话/修订条目；
- 每批不含 `baseView` 或 `bufferText` 整文成员。

## 确定性 QA 文档

生成目录：`E:\MarkdownDocumentApp\.tmp\source-editor-qa-20260826-0245`

| 文件 | 字节 | 换行合同 | SHA-256 |
| --- | ---: | --- | --- |
| `source-100kb.md` | 102,400 | LF，1,156 个真实换行 | `96482EA26977E339A6BA831DE123A4DD87D937C420E15B7F77B04C35773C080A` |
| `source-1mb.md` | 1,048,576 | CRLF，11,540 个真实换行 | `1B9D0A64FFF427CA46AF2DCBD6C4D231C0ED4D882C56E22BE376DC6B03C6F673` |
| `source-single-line-100kb.md` | 102,400 | 无 CR/LF，仅 1 个逻辑行 | `BB3FEBACFCD683466A67750B2B8C279DBBC22A506B9DF7644C33B96C848120E5` |

典型文档覆盖标题、中英文、emoji、列表、GFM 表格、本地链接、代码围栏、行内与块级数学公式。100 KB 与 1 MB 文档分别覆盖 LF 和 CRLF；极端夹具专门隔离单行布局成本。

## 打包版预检与真人操作

已完成：

- release 可执行文件与 NSIS 安装包构建成功；
- 用真实路径启动 `source-100kb.md`，窗口标题正确，阅读结构包含标题、中英文、列表、表格、链接、代码与公式；
- 通过第二实例依次路由 1 MB 与 100 KB 单行文档，二次实例均正常退出，主进程保持响应；1 MB 路由进程 402 ms 退出，单行路由进程 375 ms 退出，标题随后切换到对应文档；
- 打开 1 MB 文档后主进程约 36.7 MB working set 且 `Responding = true`。这些数值只记录本机观察，不作为跨机器门槛。

尚待补录：Windows 桌面在操作阶段进入锁屏，窗口捕获只能看到锁屏。遵循真实验收规则，没有在不可见状态下盲目输入，也没有把自动测试冒充真人操作。解锁后需完成并补录：

1. 在 100 KB、1 MB 与单行 100 KB 文档切换到源码模式；
2. 验证视觉折行与真实行号；
3. 英文连续输入、中文输入法、Enter、Backspace、粘贴、选区拖动；
4. 对各自然操作组执行 Undo/Redo；
5. 在单行中部滚动后缩放、切模式、切标签并返回；
6. 显式保存、关闭、重开，比较未触碰区域字节与行尾；
7. 制造一次外部修改，确认冲突提示可见且不破坏任一版本；
8. 保存 1440×900 与窄窗口源码截图，并如实记录主观停顿。

## 当前结论

自动正确性、构建与打包预检通过；打包版真人编辑链仍处于“未验收”而不是“失败”。在上述八项真实操作和截图补齐前，本报告不宣称本轮最终通过。
