import { describe, expect, it } from 'vitest';

import { generateFixtureData } from '../../fixtures/generate-fixtures';

const base = {
  conversations: 12,
  messagesPerConv: 6,
  chineseRatio: 0.5,
  withThinking: true,
  withAttachments: true,
} as const;

const CJK = /[\u4e00-\u9fff]/;
const LATIN = /[a-z]/i;

describe('generateFixtureData() 确定性', () => {
  it('相同 seed 与参数得到完全一致的数据', () => {
    const first = generateFixtureData({ ...base, seed: 42 });
    const second = generateFixtureData({ ...base, seed: 42 });

    expect(second).toEqual(first);
  });

  it('不同 seed 得到不同数据', () => {
    const first = generateFixtureData({ ...base, seed: 42 });
    const second = generateFixtureData({ ...base, seed: 7 });

    expect(second).not.toEqual(first);
  });

  it('默认 seed 为 42', () => {
    const withDefault = generateFixtureData(base);
    const explicit = generateFixtureData({ ...base, seed: 42 });

    expect(withDefault).toEqual(explicit);
  });
});

describe('generateFixtureData() 结构', () => {
  it('按参数生成会话与消息数量', () => {
    const data = generateFixtureData({ ...base, seed: 42 });

    expect(data.conversations).toHaveLength(12);
    expect(data.totalMessages).toBe(72);
    for (const conversation of data.conversations) {
      expect(conversation.messages).toHaveLength(6);
      expect(conversation.messageCount).toBe(6);
    }
  });

  it('remoteId 全局唯一', () => {
    const data = generateFixtureData({ ...base, conversations: 50, seed: 42 });
    const ids = data.conversations.map((conversation) => conversation.remoteId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('order 从 0 起连续递增，role 交替', () => {
    const [conversation] = generateFixtureData({ ...base, seed: 42 }).conversations;

    expect(conversation?.messages.map((message) => message.order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(conversation?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('消息 remoteId 在会话内唯一', () => {
    const [conversation] = generateFixtureData({ ...base, seed: 42 }).conversations;
    const ids = conversation?.messages.map((message) => message.remoteId) ?? [];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('标题会出现重复，用于覆盖重复标题场景', () => {
    const data = generateFixtureData({ ...base, conversations: 30, seed: 42 });
    const titles = data.conversations.map((conversation) => conversation.title);

    expect(new Set(titles).size).toBeLessThan(titles.length);
  });

  it('时间戳有序且 updatedAt 不早于 createdAt', () => {
    const data = generateFixtureData({ ...base, seed: 42 });

    for (const conversation of data.conversations) {
      expect(conversation.updatedAt).toBeGreaterThanOrEqual(conversation.createdAt);
    }
  });
});

describe('generateFixtureData() 开关与内容', () => {
  it('withThinking=false 时不产生 thinking 字段', () => {
    const data = generateFixtureData({ ...base, withThinking: false, seed: 42 });
    const messages = data.conversations.flatMap((conversation) => conversation.messages);

    expect(messages.every((message) => message.thinking === undefined)).toBe(true);
  });

  it('withThinking=true 时至少一条消息带 thinking', () => {
    const data = generateFixtureData({ ...base, withThinking: true, seed: 42 });
    const messages = data.conversations.flatMap((conversation) => conversation.messages);

    expect(messages.some((message) => (message.thinking ?? '').length > 0)).toBe(true);
  });

  it('withAttachments=false 时不产生 attachmentMeta', () => {
    const data = generateFixtureData({ ...base, withAttachments: false, seed: 42 });
    const messages = data.conversations.flatMap((conversation) => conversation.messages);

    expect(messages.every((message) => message.attachmentMeta === undefined)).toBe(true);
  });

  it('withAttachments=true 时至少一条消息带 attachmentMeta', () => {
    const data = generateFixtureData({ ...base, withAttachments: true, seed: 42 });
    const messages = data.conversations.flatMap((conversation) => conversation.messages);

    expect(messages.some((message) => (message.attachmentMeta?.length ?? 0) > 0)).toBe(true);
  });

  it('chineseRatio=1 时全部消息含中文', () => {
    const data = generateFixtureData({ ...base, chineseRatio: 1, seed: 42 });
    const messages = data.conversations.flatMap((conversation) => conversation.messages);

    expect(messages.every((message) => CJK.test(message.content))).toBe(true);
  });

  it('chineseRatio=0 时没有消息含中文', () => {
    const data = generateFixtureData({ ...base, chineseRatio: 0, seed: 42 });
    const messages = data.conversations.flatMap((conversation) => conversation.messages);

    expect(messages.every((message) => !CJK.test(message.content))).toBe(true);
  });

  it('混合比例下同时出现中英文消息', () => {
    const data = generateFixtureData({ ...base, chineseRatio: 0.5, seed: 42 });
    const messages = data.conversations.flatMap((conversation) => conversation.messages);

    expect(messages.some((message) => CJK.test(message.content))).toBe(true);
    expect(
      messages.some((message) => !CJK.test(message.content) && LATIN.test(message.content)),
    ).toBe(true);
  });

  it('内容包含 emoji 等特殊字符', () => {
    const data = generateFixtureData({ ...base, seed: 42 });
    const messages = data.conversations.flatMap((conversation) => conversation.messages);

    expect(messages.some((message) => /\p{Emoji}/u.test(message.content))).toBe(true);
  });
});
