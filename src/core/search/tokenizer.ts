/**
 * 中文友好的分词（PRD：MiniSearch + `Intl.Segmenter`）。
 *
 * 关键约束：**建索引与查询必须使用同一个 tokenizer**，否则两侧切分不一致会查不到。
 * 无 `Intl.Segmenter`（老浏览器）时退回按「非字母数字非汉字」切分，保证不抛错。
 */

export interface TokenizerOptions {
  /** 显式传 null 可强制走兜底切分，便于测试与降级验证。 */
  segmenter?: Intl.Segmenter | null;
  locale?: string;
}

/** 兜底切分：保留字母、数字与汉字，其余一律当分隔符。 */
const FALLBACK_SEPARATOR = /[^0-9A-Za-z\u4e00-\u9fff]+/;

export function createSegmenter(locale = 'zh'): Intl.Segmenter | null {
  try {
    if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
    return new Intl.Segmenter(locale, { granularity: 'word' });
  } catch {
    return null;
  }
}

export function createTokenizer(options: TokenizerOptions = {}): (text: string) => string[] {
  const segmenter =
    options.segmenter === undefined ? createSegmenter(options.locale) : options.segmenter;

  return (text: string): string[] => {
    const normalized = text.normalize('NFKC').toLowerCase().trim();
    if (normalized === '') return [];

    if (segmenter === null) {
      return normalized.split(FALLBACK_SEPARATOR).filter((token) => token !== '');
    }

    const tokens: string[] = [];
    for (const piece of segmenter.segment(normalized)) {
      if (!piece.isWordLike) continue;
      const token = piece.segment.trim();
      if (token !== '') tokens.push(token);
    }
    return tokens;
  };
}

/** 默认 tokenizer（单例，避免重复构造 Segmenter）。 */
export const tokenizeText = createTokenizer();
