import { describe, expect, it } from 'vitest';
import {
  chunk,
  chunkBySerializedSize,
  legacyFileUrl,
  rewriteResourceRefs,
  sanitizeRelPath,
} from '../shared';

describe('sanitizeRelPath', () => {
  it('接受正常相对路径并统一斜杠', () => {
    expect(sanitizeRelPath('images/a.png')).toBe('images/a.png');
    expect(sanitizeRelPath('images\\a.png')).toBe('images/a.png');
    expect(sanitizeRelPath('docs/上传 资源/x.doc')).toBe('docs/上传 资源/x.doc');
  });

  it('拒绝穿越与绝对路径', () => {
    expect(sanitizeRelPath('../etc/passwd')).toBeNull();
    expect(sanitizeRelPath('images/../../x.png')).toBeNull();
    expect(sanitizeRelPath('/abs/a.png')).toBeNull();
    expect(sanitizeRelPath('')).toBeNull();
    expect(sanitizeRelPath('a/..')).toBeNull();
  });
});

describe('rewriteResourceRefs', () => {
  it('按长度降序替换，避免前缀误命中', () => {
    const map = new Map<string, string>([
      ['resources/images/a.png', '/files/legacy/images/a.png'],
      ['resources/images/a.png.bak', '/files/legacy/images/a.png.bak'],
    ]);
    const html = '<img src="resources/images/a.png"><a href="resources/images/a.png.bak">';
    const out = rewriteResourceRefs(html, map);
    expect(out).toBe('<img src="/files/legacy/images/a.png"><a href="/files/legacy/images/a.png.bak">');
  });

  it('空映射时原文返回', () => {
    expect(rewriteResourceRefs('<p>keep</p>', new Map())).toBe('<p>keep</p>');
  });
});

describe('chunk / chunkBySerializedSize', () => {
  it('chunk 按大小切分', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });

  it('chunkBySerializedSize 单项超限也独立成批', () => {
    const out = chunkBySerializedSize([{ b: 10 }, { b: 20 }, { b: 5 }], 12, (x) => x.b);
    expect(out).toEqual([[{ b: 10 }], [{ b: 20 }], [{ b: 5 }]]);
  });

  it('chunkBySerializedSize 尽量装满每批', () => {
    const out = chunkBySerializedSize([{ b: 5 }, { b: 5 }, { b: 5 }], 12, (x) => x.b);
    expect(out).toEqual([[{ b: 5 }, { b: 5 }], [{ b: 5 }]]);
  });
});

describe('legacyFileUrl', () => {
  it('拼接 /files 前缀', () => {
    expect(legacyFileUrl('images/a.png')).toBe('/files/legacy/images/a.png');
  });
});
