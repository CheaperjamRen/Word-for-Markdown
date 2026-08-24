export function formatPathForDisplay(canonicalPath: string): string {
  if (/^\\\\\?\\UNC\\/i.test(canonicalPath)) {
    return `\\\\${canonicalPath.slice(8)}`;
  }
  if (/^\\\\\?\\[A-Za-z]:\\/.test(canonicalPath)) {
    return canonicalPath.slice(4);
  }
  if (/^\\\\\?\\/.test(canonicalPath)) {
    return canonicalPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "Markdown";
  }
  if (canonicalPath.startsWith("\\\\.\\") || canonicalPath.startsWith("\\??\\")) {
    return canonicalPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "Markdown";
  }
  return canonicalPath;
}

export function fileNameForDisplay(canonicalPath: string): string {
  return formatPathForDisplay(canonicalPath).split(/[\\/]/).filter(Boolean).at(-1) ?? "Markdown";
}
