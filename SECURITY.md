# 安全策略 / Security Policy

## 支持的版本

| 版本 | 是否接收安全修复 |
| --- | --- |
| 最新发布版（当前 0.1.x） | ✅ |
| 更早版本 | ❌ 请升级到最新版 |

## 报告漏洞

请**不要**通过公开 Issue、讨论区或 PR 披露安全问题。

使用 GitHub 的私密报告通道：进入仓库 **Security → Report a vulnerability**（[直接链接](https://github.com/CheaperjamRen/Word-for-Markdown/security/advisories/new)）。报告中请尽量包含：

- 受影响的版本与 Windows 版本；
- 复现步骤，以及能触发问题的最小 `.md` 文件或路径结构；
- 你判断的影响（例如：读取或写入了预期之外的文件、执行了脚本、加载了远程资源）。

维护者会在 **7 天内**确认收到，并在修复发布后与你协调公开时间；如你同意，会在发布说明中致谢。

## 我们特别关心的范围

这是一个打开不受信任 Markdown 文件的本地应用，以下问题都视为安全问题：

- Markdown 中的 HTML、Mermaid、KaTeX、链接或图片导致脚本执行、绕过内容安全策略（CSP）或加载远程资源；
- 打开、保存、恢复草稿或文件监听过程中，读写了用户所打开文件以外的路径（含符号链接、重解析点、路径穿越）；
- 保存流程导致原文件或草稿被截断、损坏或丢失；
- 安装包或文件关联被利用来提升权限。

## Scope (English)

Please report privately via **Security → Report a vulnerability**. We treat script execution from Markdown content, CSP bypasses, remote resource loading, file access outside the opened document, and save paths that can corrupt or lose data as security issues. We aim to acknowledge reports within 7 days.
