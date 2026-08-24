<p align="right">简体中文 · <a href="README.en.md">English</a></p>

<p align="center">
  <img src=".github/assets/readme/app-icon.png" width="96" alt="Word for Markdown 图标">
</p>

<h1 align="center">Word for Markdown</h1>

<p align="center"><strong>把本地 Markdown 当作文档来打开、阅读和修改。</strong></p>

<p align="center">
  <a href="https://github.com/CheaperjamRen/Word-for-Markdown/releases/latest"><strong>下载 Windows 版</strong></a>
  · Windows 10/11 x64
  · 简体中文 / English
  · Apache-2.0
</p>

![Word for Markdown 暖纸阅读模式](.github/assets/readme/reading.png)

## Markdown 正在成为 AI 时代的通用文档

Markdown 用普通文本表达标题、列表、链接、表格和代码。文件轻便，结构清楚，打开和传递都很快；任何文本工具都能读取，Git 可以准确记录每次变化，长期保存也不依赖某个特定平台。

它同样是一种天然的 AI 文档格式。Agent 可以稳定地生成、读取和修改 Markdown，人也能直接看懂原文。同一个 `.md` 文件可以在 Agent、代码仓库、文档站点和云文档之间流动。如今 [Google Docs](https://support.google.com/docs/answer/12014036)、[Notion](https://www.notion.com/help/import-data-into-notion) 和 [飞书文档](https://www.feishu.cn/content/article/7644456827538820052) 都提供了 Markdown 的导入、导出或打开能力。

### 本地阅读仍缺少一个自然入口

Markdown 的生产与交换已经很顺畅，文件落到 Windows 桌面后的体验仍然分散：Agent 内预览依赖原来的会话，代码编辑器更关注源码和工程操作，云文档导入通常会生成一份副本。普通用户需要一个清楚的默认动作——双击 `.md`，像打开普通文档一样开始阅读，需要时直接修改。

Word for Markdown 接上这段本地体验。它打开 `.md` / `.markdown` 后先呈现舒适的长文排版，需要修改时可切换富文本或源码；菜单、标签页、工具栏和快捷键沿用熟悉的桌面文档逻辑。

> 为 Agent 产出的本地 Markdown 文档，提供像 Word 打开 DOCX 一样自然的阅读与编辑体验。

## 它的特点

| | |
| --- | --- |
| **长文阅读优先** | 舒适的正文宽度与段落节奏，支持大纲、文内查找、专注阅读和阅读位置恢复。 |
| **同一文档，三种视图** | 阅读、富文本、源码共享当前内容与缩放状态，切换视图不会触发保存。 |
| **Markdown 原文保真** | 富文本只回写实际修改的区域；未知或暂不支持的语法会保留源码，并提供局部源码入口。 |
| **本地文件，明确保存** | 文档留在本地，原文件只在用户显式保存时写入；异常退出时可恢复未保存编辑。 |

### 为知识手册和 Agent 成果设计的阅读面

- 柔白、暖纸、夜间三套完整应用主题
- 窄、适中、宽三档正文宽度与三档阅读间距
- A4、A3、自由画布三种版式
- 整体画布缩放与文字缩放两套方式
- 多级大纲、`Ctrl+F` 查找、锚点与本地 Markdown 跳转
- GFM 表格、任务列表、代码块、图片、KaTeX 公式与 Mermaid 图表

### Word 式富文本，保留 Markdown 的开放性

在整篇文档中连续编辑文字，使用标题、粗体、斜体、删除线、行内代码、列表、引用、链接和代码块。表格支持选区、增删行列、单元格编辑与对象移动；公式、图表和特殊内容保留清楚的源码入口。

![Word for Markdown 富文本与表格编辑](.github/assets/readme/rich-editing.png)

### 需要精确控制时，回到源码

源码模式基于 CodeMirror 6，提供行号、Markdown 高亮、查找替换和大文档虚拟化。富文本与源码编辑都作用于同一份内存候选内容，只有点击保存或按下 `Ctrl+S` 才会写入原文件。

![Word for Markdown 源码模式](.github/assets/readme/source.png)

## 常用操作

1. 打开应用，选择“打开文档”，也可以从“历史文档”继续上次阅读。
2. 使用右上角的“阅读 / 富文本 / 源码”切换工作方式。
3. 在状态栏选择 A4、A3 或自由画布，并调整文档缩放。
4. 需要沉浸阅读时，从“查看”菜单进入专注阅读。
5. 修改完成后按 `Ctrl+S` 显式保存。

网页链接交给默认浏览器，本地 Markdown 在新标签页打开；本地图片等可预览资源会留在应用内。文件在其他程序中发生变化时，应用会根据当前是否有未保存修改刷新内容或提示选择保留的版本。

## 下载与安装

前往 [Releases](https://github.com/CheaperjamRen/Word-for-Markdown/releases/latest) 下载 `Markdown 文档_0.1.0_x64-setup.exe`。

安装程序支持简体中文与 English，采用当前 Windows 用户安装方式。安装后的应用名称显示为“Markdown 文档”。你可以从应用内打开文件，也可以在 Windows 中把它选择为 `.md` / `.markdown` 的默认打开方式。

当前公开测试版尚未使用商业代码签名证书。若 Windows 显示“未知发布者”，请先确认安装包来自本仓库 Releases，并核对发布页提供的 SHA-256 后再决定是否继续。

## 文件与隐私

- 无需账号，不要求把文档上传到云端。
- 阅读主题、版式、缩放和界面语言保存在本机，不写入 Markdown。
- 原始 Markdown 字节是文档真源；显式保存前，编辑内容只存在于当前会话和恢复草稿中。
- 保存前会检查磁盘版本，外部修改与本地编辑发生冲突时由用户选择保留方式。

## 当前版本范围

v0.1.0 首先支持 Windows 10/11 x64 与本地 `.md` / `.markdown` 文件。标准 GFM 是默认文档协议；数学公式、Mermaid 和 frontmatter 提供阅读与安全编辑路径。少见或无法可靠转换的扩展语法会保留为源码，适合在源码模式或局部源码编辑器中处理。

## 从源码构建

<details>
<summary>展开构建说明</summary>

需要 Node.js 20+、Rust stable、Microsoft C++ Build Tools 与 WebView2 Runtime。

```powershell
npm ci
npm run verify
npm run tauri:build
```

Windows 安装包会生成到 `src-tauri/target/release/bundle/nsis/`。

</details>

## License

[Apache License 2.0](LICENSE)
