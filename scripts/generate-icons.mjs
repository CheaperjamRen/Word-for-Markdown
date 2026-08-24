import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const icons = resolve(root, "src-tauri/icons");
const tauriCli = resolve(root, "node_modules/@tauri-apps/cli/tauri.js");

function generate(input, output) {
  const result = spawnSync(process.execPath, [tauriCli, "icon", input, "-o", output], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

generate(resolve(icons, "markdown-app.svg"), icons);

const fileOutput = mkdtempSync(join(tmpdir(), "markdown-document-file-icon-"));
try {
  generate(resolve(icons, "markdown-file.svg"), fileOutput);
  copyFileSync(resolve(fileOutput, "icon.ico"), resolve(icons, "markdown-file.ico"));
} finally {
  rmSync(fileOutput, { recursive: true, force: true });
}
