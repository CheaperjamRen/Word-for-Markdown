export interface CachedMermaidEntry {
  diagramId: string;
  svg: string;
}

const MAX_MERMAID_SVG_CACHE = 32;
const mermaidSvgCache = new Map<string, CachedMermaidEntry>();
let mermaidRenderSequence = 0;

export function nextMermaidRenderSequence(): number {
  mermaidRenderSequence += 1;
  return mermaidRenderSequence;
}

export function readCachedMermaidSvg(cacheKey: string): CachedMermaidEntry | undefined {
  const cached = mermaidSvgCache.get(cacheKey);
  if (cached !== undefined) {
    mermaidSvgCache.delete(cacheKey);
    mermaidSvgCache.set(cacheKey, cached);
  }
  return cached;
}

export function writeCachedMermaidSvg(cacheKey: string, entry: CachedMermaidEntry): void {
  if (mermaidSvgCache.has(cacheKey)) mermaidSvgCache.delete(cacheKey);
  mermaidSvgCache.set(cacheKey, entry);
  if (mermaidSvgCache.size > MAX_MERMAID_SVG_CACHE) {
    const oldest = mermaidSvgCache.keys().next().value;
    if (oldest !== undefined) mermaidSvgCache.delete(oldest);
  }
}

export function materializeMermaidSvg(entry: CachedMermaidEntry, instanceId: string): string {
  return entry.diagramId && entry.diagramId !== instanceId
    ? entry.svg.replaceAll(entry.diagramId, instanceId)
    : entry.svg;
}

export function resetMermaidSvgCacheForTests(): void {
  mermaidSvgCache.clear();
}
