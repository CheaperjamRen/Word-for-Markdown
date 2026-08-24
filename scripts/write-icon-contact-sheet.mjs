import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = resolve(root, "fixtures/generated/evidence");
const sizes = [16, 24, 32, 48];
const icons = [
  ["应用图标", "markdown-app.svg"],
  [".md 文件图标", "markdown-file.svg"],
].map(([label, name]) => [
  label,
  `data:image/svg+xml;base64,${readFileSync(resolve(root, "src-tauri/icons", name)).toString("base64")}`,
]);

const groups = icons.map(([label, source]) => `
  <section><h2>${label}</h2>
    ${["light", "dark", "busy"].map((theme) => `<div class="row ${theme}">${sizes.map((size) => `<figure><img alt="${label} ${size}px" src="${source}" width="${size}" height="${size}"><figcaption>${size}px</figcaption></figure>`).join("")}</div>`).join("")}
  </section>`).join("");

const html = `<!doctype html><meta charset="utf-8"><title>Markdown icon contact sheet</title>
<style>body{margin:0;padding:32px;font:14px system-ui;color:#22323d;background:#eef1f2}main{max-width:920px;margin:auto}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}section{padding:20px;border-radius:18px;background:white;box-shadow:0 10px 28px #18242d18}.row{display:flex;align-items:end;gap:24px;min-height:90px;margin-top:12px;padding:16px;border-radius:12px}.light{background:#f6f3ed}.dark{background:#17232c}.busy{background:radial-gradient(circle at 18% 28%,#ffb5c9 0 9%,transparent 10%),radial-gradient(circle at 82% 67%,#5ad2d0 0 15%,transparent 16%),linear-gradient(35deg,transparent 0 34%,#6678df77 35% 51%,transparent 52%),#f5e8ec}figure{display:grid;justify-items:center;gap:8px;margin:0;min-width:52px}figcaption{padding:2px 6px;border-radius:9px;background:#ffffffcc;color:#43525b;font-size:11px}</style>
<main><h1>Markdown icon contact sheet</h1><div class="grid">${groups}</div></main>`;

mkdirSync(evidence, { recursive: true });
writeFileSync(resolve(evidence, "icon-contact-sheet.html"), html);
