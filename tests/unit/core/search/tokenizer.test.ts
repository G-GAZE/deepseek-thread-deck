import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSegmenter, createTokenizer, tokenizeText } from '@/core/search/tokenizer';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tokenizeText() 中文分词', () => {
  it('用 Intl.Segmenter 切出中文词', () => {
    expect(tokenizeText('中文分词方案对比')).toContain('分词');
  });

  it('把中英文混合串切成两部分', () => {
    const tokens = tokenizeText('Dexie 迁移怎么写');

    expect(tokens).toContain('dexie');
    expect(tokens).toContain('迁移');
  });

  it('英文统一小写，便于大小写无关检索', () => {
    expect(tokenizeText('MiniSearch INDEX')).toEqual(['minisearch', 'index']);
  });

  it('标点与换行被切掉，不产生空 token', () => {
    const tokens = tokenizeText('你好，世界。第二行\n第三行！');

    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((token) => token.trim() !== '')).toBe(true);
    expect(tokens.join('')).not.toContain('，');
    expect(tokens.join('')).not.toContain('。');
  });

  it('保留数字', () => {
    expect(tokenizeText('500 条对话')).toContain('500');
  });

  it('emoji 不抛错，也不会变成检索词', () => {
    const tokens = tokenizeText('😀🚀 部署完成');

    expect(tokens).toContain('部署');
    expect(tokens.some((token) => token.includes('😀'))).toBe(false);
  });

  it('空串与纯空白返回空数组', () => {
    expect(tokenizeText('')).toEqual([]);
    expect(tokenizeText('   \n\t ')).toEqual([]);
  });

  it('全 emoji 输入返回空数组，不产生检索词', () => {
    expect(tokenizeText('😀🚀🧩📌✅')).toEqual([]);
  });
});

describe('createTokenizer() 降级', () => {
  it('无 Intl.Segmenter 时退回按非字母数字切分，且不抛错', () => {
    const tokenizer = createTokenizer({ segmenter: null });

    const tokens = tokenizer('Dexie 迁移 v2');

    expect(tokens).toContain('dexie');
    expect(tokens).toContain('迁移');
    expect(tokens).toContain('v2');
  });

  it('可重复使用且结果稳定', () => {
    const tokenizer = createTokenizer();

    expect(tokenizer('中文分词')).toEqual(tokenizer('中文分词'));
  });

  it('索引侧与查询侧使用同一 tokenizer，切分结果一致', () => {
    const tokenizer = createTokenizer();
    const document = '中文分词方案对比';

    expect(tokenizer(document)).toEqual(tokenizeText(document));
  });

  it('Intl.Segmenter 不存在时 createSegmenter 返回 null，tokenizer 仍可用', () => {
    vi.stubGlobal('Intl', { Segmenter: undefined });

    expect(createSegmenter()).toBeNull();
    expect(createTokenizer()('Dexie 迁移')).toContain('迁移');
  });

  it('Segmenter 构造抛错时降级为 null，不把异常抛给调用方', () => {
    vi.stubGlobal('Intl', {
      Segmenter: class {
        constructor() {
          throw new Error('icu unavailable');
        }
      },
    });

    expect(createSegmenter()).toBeNull();
  });
});
