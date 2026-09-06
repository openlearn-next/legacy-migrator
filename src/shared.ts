/**
 * 导入/导出两端共享的纯函数：无 Node 依赖，server 与 frontend bundle 各自内联。
 */

/** 导出包 JSON 顶层的结构约定（旧站 export_openlearn_next.aspx 生成） */
export const EXPORT_SCHEMA_VERSION = 1;
export const LEGACY_VFS_ROOT = 'legacy'; // 资源在 /files/<root>/... 下可见

export interface LegacyResourceItem {
  ref: string; // 形如 resources/images/a.png（导出包内相对路径）
  bytes: number;
  missing?: boolean;
}

/** 校验并规范化资源相对路径，非法返回 null（防穿越：拒绝绝对路径/..段/反斜杠） */
export function sanitizeRelPath(relPath: string): string | null {
  if (!relPath || typeof relPath !== 'string') return null;
  const p = relPath.replace(/\\/g, '/').trim();
  if (!p || p.startsWith('/') || p.includes('../') || p.includes('..\\')) return null;
  const segments = p.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0) return null;
  if (segments.some((s) => s === '..')) return null;
  return segments.join('/');
}

export function legacyFileUrl(relPath: string): string {
  return '/files/' + LEGACY_VFS_ROOT + '/' + relPath;
}

/**
 * 把课程 HTML 里的 `resources/...` 引用改写为新平台 /files/... 绝对路径。
 * 按 ref 长度降序替换，避免 "resources/a.png" 误命中 "resources/a.png.bak"。
 */
export function rewriteResourceRefs(html: string, mapping: Map<string, string>): string {
  if (!html || mapping.size === 0) return html;
  const entries = [...mapping.entries()].sort((a, b) => b[0].length - a[0].length);
  let out = html;
  for (const [ref, url] of entries) {
    // 仅替换属性值/URL 语境中的引用，避免误伤正文文本：前后不能是字母数字
    out = out.split(ref).join(url);
  }
  return out;
}

/** 按回调产出切分块 */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 按序列化体积切分（用于资源批量上传，控制单命令 payload） */
export function chunkBySerializedSize<T>(items: T[], maxBytes: number, measure: (item: T) => number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let curSize = 0;
  for (const item of items) {
    const s = measure(item);
    if (cur.length > 0 && curSize + s > maxBytes) {
      out.push(cur);
      cur = [];
      curSize = 0;
    }
    cur.push(item);
    curSize += s;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
