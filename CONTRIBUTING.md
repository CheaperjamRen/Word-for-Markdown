# 参与贡献 / Contributing

感谢你愿意让 Word for Markdown 变得更好。项目处于早期，**真实使用反馈**和**能复现问题的 `.md` 文件**与代码同样有价值。
English speakers are welcome — issues and PRs in either Chinese or English are fine.

## 先读这几条

- 项目只做一件事：把本地 `.md` 当作一份文档来读、来改。超出这个范围的功能（知识库、同步、插件系统）一般不会合入，提之前可以先开 Issue 讨论。
- **源文件保真是底线**：任何改动都不能让未被用户编辑的字节发生变化（包括 BOM、CRLF/LF、无法识别的语法）。
- 保存只能由用户显式触发；外部修改永远不能被静默覆盖。

## 报告问题

- Bug：用 [Bug 报告模板](https://github.com/CheaperjamRen/Word-for-Markdown/issues/new?template=bug_report.yml)，写清 Windows 版本、应用版本、复现步骤；附上能复现的 `.md`（可删减敏感内容）。
- 功能建议：用 [功能建议模板](https://github.com/CheaperjamRen/Word-for-Markdown/issues/new?template=feature_request.yml)，重点说你要读或要改的是什么文档、现在卡在哪里。
- 安全问题请**不要**公开提 Issue，按 [SECURITY.md](SECURITY.md) 私下报告。

## 开发环境

| 依赖 | 版本 |
| --- | --- |
| Node.js | 20+（仓库锁定 `npm@11`，请用 `npm ci`） |
| Rust | stable，≥ 1.77.2 |
| Windows 构建 | Microsoft C++ Build Tools、WebView2 Runtime |

```powershell
npm ci
npm run tauri dev     # 启动桌面应用（开发模式）
npm run dev           # 仅启动前端（浏览器中调试界面）
npm test              # Vitest 单元测试
npm run typecheck     # TypeScript 类型检查
npm run verify        # 提交 PR 前必须通过：测试 + 脚本测试 + 构建 + cargo test
```

macOS / Linux 可以开发和测试前端；文件替换、注册表等能力依赖 Windows API，完整的 `cargo test` 与安装包只在 Windows 上有保证。CI 会在 Windows 上跑完整 `npm run verify`。

## 代码在哪里

| 目录 | 内容 |
| --- | --- |
| `src/app/` | 应用外壳：菜单、标签、工具栏、对话框、文档控制器 |
| `src/documents/` | 会话状态、草稿编码、外部变更处理 |
| `src/markdown/` | 解析、大纲、阅读渲染 |
| `src/editor/` | 富文本编辑（Lexical） |
| `src/source/` | 源码编辑（CodeMirror 6） |
| `src/i18n/messages.ts` | 中英文界面文案（新增文案须同时提供两种语言） |
| `src-tauri/src/` | Rust：文件读写、原子保存、草稿恢复、文件监听、窗口管理 |
| `scripts/` | 图标生成、测试夹具与构建产物检查 |

## 提交 Pull Request

1. 从 `main` 新建分支，一个 PR 只解决一件事。
2. 行为变更必须附带测试；修 Bug 时先写一个能失败的测试。
3. 涉及界面的改动附上前后截图；新增或修改文案时同步 `zh-CN` 与 `en-US`。
4. 提交信息沿用现有风格（[Conventional Commits](https://www.conventionalcommits.org/zh-hans/)）：`feat:`、`fix:`、`perf:`、`docs:`、`test:`、`chore:`。
5. 面向用户的变化在 [CHANGELOG.md](CHANGELOG.md) 的 `Unreleased` 下补一行。
6. 本地 `npm run verify` 通过后再提交，并按 PR 模板勾选检查项。

## 发布（维护者）

1. 同步修改 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 中的版本号。
2. 把 `CHANGELOG.md` 的 `Unreleased` 改为新版本，并写 `docs/releases/vX.Y.Z.md`。
3. 推送 `vX.Y.Z` 标签，`Release` 工作流会构建安装包、生成 `SHA256SUMS.txt` 并创建草稿 Release；人工检查后发布。

## 行为准则

参与本项目即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.md)。

## 许可证

提交的贡献将按 [Apache License 2.0](LICENSE) 授权。
