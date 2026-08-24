export type ResolvedTarget =
  | { kind: "anchor"; headingId: string }
  | { kind: "web"; url: string }
  | { kind: "markdown"; canonicalPath: string }
  | { kind: "preview"; canonicalPath: string; mediaType: "image" | "pdf" }
  | { kind: "directory"; canonicalPath: string }
  | { kind: "system"; canonicalPath: string }
  | { kind: "dangerous"; canonicalPath: string; reason: string }
  | { kind: "blocked"; reason: string };

export interface TargetFacts {
  exists: boolean;
  directory: boolean;
  canonicalPath?: string;
}

export function splitHref(href: string): { path: string; fragment: string | null } {
  const hash = href.indexOf("#");
  const rawPath = hash < 0 ? href : href.slice(0, hash);
  const rawFragment = hash < 0 ? null : href.slice(hash + 1);
  return {
    path: rawPath,
    fragment: rawFragment === null ? null : decodeURIComponent(rawFragment),
  };
}

export function resolveRelativeWindowsPath(basePath: string, href: string): string | null {
  if (/^(?:[a-z]+:|#|\\\\)/i.test(href)) return null;
  const raw = href.split(/[?#]/, 1)[0] ?? "";
  if (!raw) return null;
  const normalizedBase = basePath.replaceAll("/", "\\");
  const rootMatch = /^[A-Za-z]:\\/.exec(normalizedBase);
  const root = rootMatch?.[0] ?? "";
  const parent = normalizedBase.slice(0, Math.max(root.length, normalizedBase.lastIndexOf("\\") + 1));
  const parts = `${parent}${raw.replaceAll("/", "\\")}`.split("\\");
  const output: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") { if (output.length > (root ? 1 : 0)) output.pop(); continue; }
    output.push(part);
  }
  if (!output.length) return null;
  const joined = output.join("\\");
  return root && !joined.startsWith(root) ? `${root}${joined}` : joined;
}

function mediaTypeFor(path: string): "image" | "pdf" | null {
  if (/\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(path)) return "image";
  if (/\.pdf$/i.test(path)) return "pdf";
  return null;
}

function isDangerousPath(path: string): boolean {
  return /\.(?:exe|cmd|bat|ps1|js|vbs|lnk)$/i.test(path) || /^\\\\/.test(path);
}

export function classifyHref(
  href: string,
  facts: TargetFacts & { fragment: string | null },
): ResolvedTarget {
  const trimmed = href.trim();
  if (!trimmed) return { kind: "blocked", reason: "链接为空" };
  if (facts.fragment !== null && !facts.exists && !facts.canonicalPath) {
    return { kind: "blocked", reason: "目标不存在" };
  }
  if (trimmed.startsWith("#")) {
    return facts.fragment ? { kind: "anchor", headingId: facts.fragment } : { kind: "blocked", reason: "锚点为空" };
  }
  if (/^(?:https?:|mailto:)/i.test(trimmed)) return { kind: "web", url: trimmed };
  if (/^(?:javascript:|data:|vbscript:|file:)/i.test(trimmed)) return { kind: "blocked", reason: "不允许打开此链接" };
  if (!facts.exists || !facts.canonicalPath) return { kind: "blocked", reason: "目标不存在" };
  if (facts.directory) return { kind: "directory", canonicalPath: facts.canonicalPath };
  if (isDangerousPath(facts.canonicalPath)) {
    return { kind: "dangerous", canonicalPath: facts.canonicalPath, reason: "此文件可能执行程序" };
  }
  if (/\.(?:md|markdown)$/i.test(facts.canonicalPath)) {
    return { kind: "markdown", canonicalPath: facts.canonicalPath };
  }
  const mediaType = mediaTypeFor(facts.canonicalPath);
  if (mediaType) return { kind: "preview", canonicalPath: facts.canonicalPath, mediaType };
  return { kind: "system", canonicalPath: facts.canonicalPath };
}
