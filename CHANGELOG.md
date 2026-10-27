# Changelog

本文件记录 Word for Markdown 的版本变化，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
All notable changes to this project are documented here. 详细发布说明见 [`docs/releases/`](docs/releases/) 与 [Releases](https://github.com/CheaperjamRen/Word-for-Markdown/releases)。

## [Unreleased]

### Added

- GitHub Actions：`CI` 在 Ubuntu 上跑前端测试与构建，在 Windows 上跑完整 `npm run verify`（含 `cargo test --locked`）；`Release` 在推送 `v*` 标签时构建 NSIS 安装包、生成 `SHA256SUMS.txt` 并创建草稿 Release。
- 社区文件：`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`CHANGELOG.md`，以及 Issue / Pull Request 模板。
- README 中英文重写：功能一览、三种视图截图、快速开始、快捷键、同类工具对比、文件处理方式、当前限制与 FAQ。

### Changed

- 编辑菜单中暂不可用的“剪切 / 粘贴”增加悬停提示，说明可在富文本或源码编辑区内直接使用 `Ctrl+X` / `Ctrl+V`。
- `windows-sys` 改为仅在 Windows 目标上引入；非 Windows 构建时安装语言提示回退为跟随系统语言。

### Fixed

- 源码编辑器验收记录不再引用未公开的设计文件和作者本地 `E:\` 路径，改为可复现的 `npm run source:qa-fixtures` 命令，并注明公开仓库的实测测试数量。

## [0.1.1] - 2026-08-26

### Added

- 源码模式支持类似 VS Code 的软换行：长行只在视口内折行，不改写 Markdown，也不虚增行号。

### Changed

- 输入、退格、粘贴和选区替换采用更自然的连续撤销分组，兼容 Windows 中文输入法。
- 缩放、切换视图和标签页后保持折行位置。
- 100 KB 至 1 MB 文档的源码变更不再整篇复制。

### Fixed

- 原子保存后文件监听器误报“文件已移动”或外部修改冲突的问题，并覆盖保存回滚路径。

## [0.1.0] - 2026-08-24

首个公开 Windows 版本。

### Added

- 阅读、富文本、源码三种文档视图。
- 多级大纲、文内查找、专注阅读与阅读位置恢复。
- 柔白、暖纸、夜间主题，A4、A3、自由画布版式；整体画布缩放与文字缩放。
- 标准 GFM、表格、任务列表、代码、KaTeX 公式与 Mermaid 图表。
- 表格矩形选区、行列操作、单元格编辑与对象移动。
- 本地文件、显式保存、恢复草稿与外部修改冲突保护。
- 简体中文 / English 界面与安装语言。

[Unreleased]: https://github.com/CheaperjamRen/Word-for-Markdown/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/CheaperjamRen/Word-for-Markdown/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/CheaperjamRen/Word-for-Markdown/releases/tag/v0.1.0
