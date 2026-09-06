import { describe, expect, it } from 'vitest';
import {
  chunk,
  chunkBySerializedSize,
  htmlToMarkdown,
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

describe('htmlToMarkdown', () => {
  it('转换标题/加粗/列表/图片', () => {
    const html = '<h1>标题</h1><p>你好 <b>世界</b></p><ul><li>甲</li><li>乙</li></ul>' +
      '<img src="/files/legacy/images/a.png" alt="图">';
    const md = htmlToMarkdown(html);
    expect(md).toContain('# 标题');
    expect(md).toContain('**世界**');
    expect(md).toContain('- 甲');
    expect(md).toContain('![](/files/legacy/images/a.png)');
    expect(md).not.toContain('<');
  });

  it('链接转 Markdown 并保留 href', () => {
    const md = htmlToMarkdown('<p><a href="https://example.com">官网</a></p>');
    expect(md).toContain('[官网](https://example.com)');
  });

  it('剔除 script/style 与表格标签降级为文本', () => {
    const md = htmlToMarkdown('<script>alert(1)</script><table><tr><td>甲</td><td>乙</td></tr></table>');
    expect(md).not.toContain('alert');
    expect(md).toContain('甲');
    expect(md).toContain('乙');
  });

  it('解码常见实体', () => {
    expect(htmlToMarkdown('<p>A&amp;B&nbsp;C&lt;D&gt;</p>')).toContain('A&B C<D>');
  });

  it('空内容给占位说明', () => {
    expect(htmlToMarkdown('')).toBe('(本课程无文本内容，请打开对应的 HTML 课件查看)');
  });
});
